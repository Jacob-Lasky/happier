/**
 * Client for the daemon-hosted Pipecat voice runtime (apps/voice-runtime).
 *
 * Audio flows peer to peer over WebRTC; the offer/answer exchange goes through the daemon's
 * encrypted machine RPC (`negotiate`). Messages use Pipecat's RTVI protocol on the WebRTC data
 * channel, plus the runtime's `happier.*` messages (see the runtime's bridge.py).
 */

export type PipecatRuntimeEvent =
  | Readonly<{ type: 'ready' }>
  | Readonly<{ type: 'user_started_speaking' }>
  | Readonly<{ type: 'user_stopped_speaking' }>
  | Readonly<{ type: 'user_transcript'; text: string; final: boolean }>
  | Readonly<{ type: 'user_turn'; text: string }>
  | Readonly<{ type: 'bot_started_speaking' }>
  | Readonly<{ type: 'bot_stopped_speaking' }>
  /** The runtime stopped speaking because it was interrupted (the user talked over it). */
  | Readonly<{ type: 'bot_interrupted' }>
  | Readonly<{ type: 'disconnected' }>;

export type PipecatRuntimeClient = Readonly<{
  /** Streams reply text for speaking. `seq` identifies one reply; `final` flushes it. */
  speak: (seq: number, text: string, final: boolean) => void;
  /** Stops reply `seq` if it is still streaming or playing. */
  cancel: (seq: number) => void;
  close: () => void;
}>;

/** The parts of the platform's WebRTC and media APIs the client uses (browser or react-native-webrtc). */
export type PipecatPlatform = Readonly<{
  createPeerConnection: (config: RTCConfiguration) => RTCPeerConnection;
  getMicrophone: () => Promise<MediaStream>;
  /** Plays the runtime's audio; returns a function that stops playing it. */
  playRemoteAudio: (stream: MediaStream) => () => void;
}>;

/**
 * The runtime treats a peer that sent nothing for 3 seconds as gone (Pipecat 1.16,
 * SmallWebRTCConnection.is_connected), so the client pings well inside that window.
 */
const KEEPALIVE_INTERVAL_MS = 1000;
const RTVI_PROTOCOL_VERSION = '2.3.0';

type RtviMessage = Readonly<{ label?: unknown; type?: unknown; data?: unknown }>;

function readServerEvent(message: RtviMessage): PipecatRuntimeEvent | null {
  const data = (message.data && typeof message.data === 'object' ? message.data : {}) as Record<string, unknown>;
  switch (message.type) {
    case 'bot-ready':
      return { type: 'ready' };
    case 'user-started-speaking':
      return { type: 'user_started_speaking' };
    case 'user-stopped-speaking':
      return { type: 'user_stopped_speaking' };
    case 'bot-started-speaking':
      return { type: 'bot_started_speaking' };
    case 'bot-stopped-speaking':
      return { type: 'bot_stopped_speaking' };
    case 'bot-interrupted':
      return { type: 'bot_interrupted' };
    case 'user-transcription':
      return typeof data.text === 'string' ? { type: 'user_transcript', text: data.text, final: data.final === true } : null;
    case 'server-message':
      if (data.type === 'happier.user_turn' && typeof data.text === 'string') return { type: 'user_turn', text: data.text };
      return null;
    default:
      return null;
  }
}

/**
 * The offer carries its candidates (the runtime's signalling takes one offer, no trickle), so it
 * waits for them, but only until it has what a peer needs: every host candidate (gathered first)
 * plus a public (server-reflexive or relay) address. Waiting for gathering to "complete" instead
 * cost ~40 s on hosts with interfaces that cannot reach the STUN server (measured 2026-11-12 on a
 * Linux EC2 machine with Docker bridges): the browser declares completion only after its STUN
 * timeout on every one of them.
 */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('aborted');
}

function waitForIceGathering(pc: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      pc.removeEventListener('icecandidate', onCandidate);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = () => {
      done();
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const onCandidate = (event: RTCPeerConnectionIceEvent) => {
      const type = event.candidate?.type;
      if (type === 'srflx' || type === 'relay') finish();
    };
    const onAbort = () => {
      done();
      reject(abortReason(signal));
    };
    pc.addEventListener('icegatheringstatechange', onChange);
    pc.addEventListener('icecandidate', onCandidate);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForChannelOpen(pc: RTCPeerConnection, channel: RTCDataChannel, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  if (channel.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      channel.removeEventListener('open', onOpen);
      channel.removeEventListener('close', onClosed);
      pc.removeEventListener('connectionstatechange', onState);
      signal.removeEventListener('abort', onAbort);
    };
    const onOpen = () => {
      done();
      resolve();
    };
    const onClosed = () => {
      done();
      reject(new Error('voice_runtime_disconnected'));
    };
    const onState = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') onClosed();
    };
    const onAbort = () => {
      done();
      reject(abortReason(signal));
    };
    channel.addEventListener('open', onOpen);
    channel.addEventListener('close', onClosed);
    pc.addEventListener('connectionstatechange', onState);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Connects to a runtime. Resolves once the runtime has answered and its data channel is open;
 * `onEvent` then reports what the runtime hears and says. Rejects (and releases the microphone)
 * if the offer, `negotiate` or the answer fails, or `signal` aborts first.
 */
export async function connectPipecatRuntime(params: Readonly<{
  platform: PipecatPlatform;
  iceServers: ReadonlyArray<RTCIceServer>;
  negotiate: (offerSdp: string) => Promise<string>;
  onEvent: (event: PipecatRuntimeEvent) => void;
  signal: AbortSignal;
}>): Promise<PipecatRuntimeClient> {
  const microphone = await params.platform.getMicrophone();
  let pc: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let stopRemoteAudio: (() => void) | null = null;
  let closed = false;
  let messageCounter = 0;

  /** False when the data channel is not open: the message was not sent. */
  const send = (type: string, data: unknown): boolean => {
    if (!channel || channel.readyState !== 'open') return false;
    messageCounter += 1;
    channel.send(JSON.stringify({ label: 'rtvi-ai', type, id: `happier-${messageCounter}`, data }));
    return true;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
    stopRemoteAudio?.();
    stopRemoteAudio = null;
    for (const track of microphone.getTracks()) track.stop();
    try {
      channel?.close();
    } catch {
      // Already closed by the peer.
    }
    pc?.close();
  };

  const onDisconnected = () => {
    if (closed) return;
    close();
    params.onEvent({ type: 'disconnected' });
  };

  try {
    if (params.signal.aborted) throw abortReason(params.signal);
    pc = params.platform.createPeerConnection({ iceServers: [...params.iceServers] });
    channel = pc.createDataChannel('chat', { ordered: true });
    const peer = pc;
    const dataChannel = channel;
    for (const track of microphone.getAudioTracks()) peer.addTrack(track, microphone);

    peer.addEventListener('track', (event: RTCTrackEvent) => {
      if (event.track.kind !== 'audio' || stopRemoteAudio) return;
      stopRemoteAudio = params.platform.playRemoteAudio(event.streams[0] ?? new MediaStream([event.track]));
    });
    peer.addEventListener('connectionstatechange', () => {
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') onDisconnected();
    });

    dataChannel.addEventListener('open', () => {
      send('client-ready', {
        version: RTVI_PROTOCOL_VERSION,
        about: { library: 'happier', library_version: '1', platform: 'happier-app' },
      });
      keepalive = setInterval(() => {
        if (dataChannel.readyState === 'open') dataChannel.send(`ping: ${Date.now()}`);
      }, KEEPALIVE_INTERVAL_MS);
    });
    dataChannel.addEventListener('close', onDisconnected);
    dataChannel.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      let message: RtviMessage;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.label !== 'rtvi-ai') return;
      const runtimeEvent = readServerEvent(message);
      if (runtimeEvent) params.onEvent(runtimeEvent);
    });

    await peer.setLocalDescription(await peer.createOffer());
    await waitForIceGathering(peer, params.signal);
    const offerSdp = peer.localDescription?.sdp;
    if (!offerSdp) throw new Error('voice_runtime_offer_failed');
    if (params.signal.aborted) throw abortReason(params.signal);
    const answerSdp = await params.negotiate(offerSdp);
    if (params.signal.aborted) throw abortReason(params.signal);
    await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    // Connected means the runtime can be spoken to: until the channel opens, speech would be lost.
    await waitForChannelOpen(peer, dataChannel, params.signal);
  } catch (error) {
    close();
    throw error;
  }

  return {
    speak: (seq, text, final) => {
      if (!send('client-message', { t: 'happier.speak', d: { seq, text, final } })) {
        throw new Error('voice_runtime_disconnected');
      }
    },
    // Nothing is playing on a closed channel, so there is nothing to cancel.
    cancel: (seq) => {
      send('client-message', { t: 'happier.cancel', d: { seq } });
    },
    close,
  };
}
