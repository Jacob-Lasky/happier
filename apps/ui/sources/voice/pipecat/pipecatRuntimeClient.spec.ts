import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectPipecatRuntime, type PipecatPlatform, type PipecatRuntimeEvent } from './pipecatRuntimeClient';

// Boundary fakes only: the platform's WebRTC peer connection, data channel and microphone stream.
class FakeEventTarget {
  private readonly listeners = new Map<string, Array<(event: any) => void>>();
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
  }
  emit(type: string, event: any = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeChannel extends FakeEventTarget {
  readyState: RTCDataChannelState = 'connecting';
  readonly sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 'closed';
  }
  open() {
    this.readyState = 'open';
    this.emit('open');
  }
  receive(message: unknown) {
    this.emit('message', { data: typeof message === 'string' ? message : JSON.stringify(message) });
  }
}

class FakePeerConnection extends FakeEventTarget {
  readonly channel = new FakeChannel();
  iceGatheringState: RTCIceGatheringState = 'complete';
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  readonly tracks: unknown[] = [];
  closed = false;
  createDataChannel() {
    return this.channel;
  }
  addTrack(track: unknown) {
    this.tracks.push(track);
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0 offer' };
  }
  async setLocalDescription(description: { type: string; sdp: string }) {
    this.localDescription = description;
  }
  async setRemoteDescription(description: { type: string; sdp: string }) {
    this.remoteDescription = description;
  }
  close() {
    this.closed = true;
  }
}

function createPlatform() {
  const pc = new FakePeerConnection();
  const track = { kind: 'audio', stopped: false, stop() { this.stopped = true; } };
  const platform: PipecatPlatform = {
    createPeerConnection: () => pc as unknown as RTCPeerConnection,
    getMicrophone: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) as unknown as MediaStream,
    playRemoteAudio: () => () => {},
  };
  return { pc, track, platform };
}

function sentMessages(channel: FakeChannel) {
  return channel.sent.filter((data) => !data.startsWith('ping')).map((data) => JSON.parse(data));
}

describe('connectPipecatRuntime', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('negotiates through the daemon, announces the client and keeps the connection alive', async () => {
    const { pc, platform } = createPlatform();
    const offers: string[] = [];
    const client = await connectPipecatRuntime({
      platform,
      iceServers: [],
      signal: new AbortController().signal,
      onEvent: () => {},
      negotiate: async (offer) => {
        offers.push(offer);
        return 'v=0 answer';
      },
    });

    expect(offers).toEqual(['v=0 offer']);
    expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'v=0 answer' });

    pc.channel.open();
    expect(sentMessages(pc.channel)[0]).toMatchObject({ label: 'rtvi-ai', type: 'client-ready' });
    vi.advanceTimersByTime(2_500);
    expect(pc.channel.sent.filter((data) => data.startsWith('ping')).length).toBeGreaterThanOrEqual(2);
    client.close();
  });

  it('turns runtime messages into events and ignores anything that is not RTVI', async () => {
    const { pc, platform } = createPlatform();
    const events: PipecatRuntimeEvent[] = [];
    const client = await connectPipecatRuntime({
      platform,
      iceServers: [],
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
      negotiate: async () => 'v=0 answer',
    });
    pc.channel.open();

    pc.channel.receive({ label: 'rtvi-ai', type: 'server-message', data: { type: 'happier.user_turn', text: 'run the tests' } });
    pc.channel.receive({ label: 'rtvi-ai', type: 'bot-started-speaking' });
    pc.channel.receive({ label: 'rtvi-ai', type: 'bot-interrupted' });
    pc.channel.receive({ label: 'rtvi-ai', type: 'user-transcription', data: { text: 'run the', final: false } });
    pc.channel.receive({ label: 'other', type: 'bot-ready' });
    pc.channel.receive('not json');

    expect(events).toEqual([
      { type: 'user_turn', text: 'run the tests' },
      { type: 'bot_started_speaking' },
      { type: 'bot_interrupted' },
      { type: 'user_transcript', text: 'run the', final: false },
    ]);
    client.close();
  });

  it('streams reply text and cancellations as client messages', async () => {
    const { pc, platform } = createPlatform();
    const client = await connectPipecatRuntime({
      platform,
      iceServers: [],
      signal: new AbortController().signal,
      onEvent: () => {},
      negotiate: async () => 'v=0 answer',
    });
    pc.channel.open();

    client.speak(4, 'Done.', true);
    client.cancel(4);

    expect(sentMessages(pc.channel).slice(1).map((message) => message.data)).toEqual([
      { t: 'happier.speak', d: { seq: 4, text: 'Done.', final: true } },
      { t: 'happier.cancel', d: { seq: 4 } },
    ]);
    client.close();
  });

  it('releases the microphone and the connection when the daemon cannot start the runtime', async () => {
    const { pc, track, platform } = createPlatform();
    await expect(connectPipecatRuntime({
      platform,
      iceServers: [],
      signal: new AbortController().signal,
      onEvent: () => {},
      negotiate: async () => {
        throw new Error('voice_runtime_unavailable');
      },
    })).rejects.toThrow('voice_runtime_unavailable');
    expect(track.stopped).toBe(true);
    expect(pc.closed).toBe(true);
  });

  it('reports the connection dropping once', async () => {
    const { pc, platform } = createPlatform();
    const events: PipecatRuntimeEvent[] = [];
    await connectPipecatRuntime({
      platform,
      iceServers: [],
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
      negotiate: async () => 'v=0 answer',
    });
    pc.connectionState = 'failed';
    pc.emit('connectionstatechange');
    pc.channel.emit('close');
    expect(events).toEqual([{ type: 'disconnected' }]);
    expect(pc.closed).toBe(true);
  });

  it('sends the offer once the public address is known instead of waiting for every interface', async () => {
    const { pc, platform } = createPlatform();
    pc.iceGatheringState = 'gathering';
    const offers: string[] = [];
    const connecting = connectPipecatRuntime({
      platform,
      iceServers: [{ urls: 'stun:stun.example.test:3478' }],
      signal: new AbortController().signal,
      onEvent: () => {},
      negotiate: async (offer) => {
        offers.push(offer);
        return 'v=0 answer';
      },
    });
    for (let i = 0; i < 20 && !pc.localDescription; i += 1) await Promise.resolve();
    expect(pc.localDescription).not.toBeNull();
    pc.emit('icecandidate', { candidate: { type: 'host' } });
    await Promise.resolve();
    expect(offers).toEqual([]);
    pc.emit('icecandidate', { candidate: { type: 'srflx' } });
    for (let i = 0; i < 20 && offers.length === 0; i += 1) await Promise.resolve();
    expect(offers).toEqual(['v=0 offer']);
    (await connecting).close();
  });

  it('releases the microphone and never negotiates when cancelled while the microphone opens', async () => {
    const { platform, track } = createPlatform();
    const controller = new AbortController();
    let openMicrophone: () => void = () => {};
    const getMicrophone = platform.getMicrophone;
    const slowPlatform: PipecatPlatform = {
      ...platform,
      getMicrophone: () => new Promise((resolve) => { openMicrophone = () => resolve(getMicrophone()); }),
    };
    const negotiate = vi.fn(async () => 'v=0 answer');
    const connecting = connectPipecatRuntime({ platform: slowPlatform, iceServers: [], signal: controller.signal, onEvent: () => {}, negotiate });
    controller.abort(new Error('call ended'));
    openMicrophone();
    await expect(connecting).rejects.toThrow('call ended');
    expect(negotiate).not.toHaveBeenCalled();
    expect(track.stopped).toBe(true);
  });
});
