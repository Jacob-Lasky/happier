import { storage } from '@/sync/domains/state/storage';
import { machineVoiceRuntimeStart, machineVoiceRuntimeStop } from '@/sync/ops/machineVoiceRuntime';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@/sync/runtime/rpcErrors';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { sync } from '@/sync/sync';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import {
  abortLocalVoiceTurn,
  appendLocalVoiceAgentContextUpdate,
  getLocalVoiceState,
  interruptLocalVoicePlayback,
  runLocalVoiceTextTurn,
  stopLocalVoiceSession,
} from '@/voice/local/localVoiceEngine';
import { patchLocalVoiceState, subscribeLocalVoiceState } from '@/voice/local/localVoiceState';
import { connectPipecatRuntime, type PipecatRuntimeClient, type PipecatRuntimeEvent } from '@/voice/pipecat/pipecatRuntimeClient';
import { resolvePipecatPlatform } from '@/voice/pipecat/pipecatPlatform';
import { createPipecatSpeechOutput } from '@/voice/pipecat/pipecatSpeechOutput';
import type { VoiceSpeechOutput } from '@/voice/output/speakAssistantText';
import { sendLocalConversationTextTurn } from '@/voice/adapters/localConversation/localConversationAdapter';
import { resolveVoiceNetworkTimeoutMs } from '@/voice/runtime/fetchWithTimeout';
import type { VoiceAdapterController, VoiceSessionMode, VoiceSessionSnapshot } from '@/voice/session/types';
import { voiceSessionBindingManager } from '@/voice/sessionBinding/voiceSessionBindingRuntime';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { fireAndForget } from '@/utils/system/fireAndForget';

const ADAPTER_ID = 'realtime_pipecat';

/**
 * Public STUN, so the app and a runtime behind different NATs can find each other. Machines on the
 * same network or tailnet connect without it.
 */
const PIPECAT_ICE_SERVERS: ReadonlyArray<RTCIceServer> = [{ urls: ['stun:stun.l.google.com:19302'] }];

/**
 * One call, from start to stop. Runtime events are matched to the call by this object's identity,
 * so it is never replaced; the machine is recorded on it once resolved.
 */
type Connection = {
  readonly controlSessionId: string;
  readonly sessionKey: string;
  readonly abort: AbortController;
  machineId: string | null;
};

/** Ends a start whose call was stopped (or replaced) while it awaited something. */
function throwIfEnded(owner: Connection): void {
  if (owner.abort.signal.aborted) throw owner.abort.signal.reason ?? new Error('voice_call_ended');
}

class VoiceRuntimeStartError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(code);
  }
}

/**
 * Realtime voice through the daemon-hosted Pipecat runtime. The runtime owns the speech (WebRTC
 * audio, Deepgram STT and TTS, turn detection, barge-in); every finished user turn runs through the
 * local conversation engine exactly like a typed or locally transcribed turn, and the reply comes
 * back to the runtime to be spoken.
 */
export function createRealtimePipecatVoiceAdapter(): VoiceAdapterController {
  const listeners = new Set<() => void>();
  let connection: Connection | null = null;
  let connecting = false;
  let client: PipecatRuntimeClient | null = null;
  let userSpeaking = false;
  let botSpeaking = false;
  let snapshot: VoiceSessionSnapshot | null = null;
  const speechOutput = createPipecatSpeechOutput(() => client);

  const computeSnapshot = (): VoiceSessionSnapshot => {
    const local = getLocalVoiceState();
    const status = connection ? (connecting ? 'connecting' : 'connected') : local.error ? 'error' : 'disconnected';
    const mode: VoiceSessionMode = userSpeaking
      ? 'listening'
      : botSpeaking
        ? 'speaking'
        : local.status === 'sending'
          ? 'thinking'
          : 'idle';
    return {
      adapterId: ADAPTER_ID,
      sessionId: connection?.controlSessionId ?? null,
      status,
      mode: status === 'connected' ? mode : 'idle',
      canStop: status === 'connected' || status === 'connecting',
      ...(local.error ? { errorCode: local.error, errorMessage: local.errorMessage ?? local.error } : {}),
    };
  };

  const getSnapshot = (): VoiceSessionSnapshot => {
    const next = computeSnapshot();
    const prev = snapshot;
    if (
      prev
      && prev.status === next.status
      && prev.mode === next.mode
      && prev.sessionId === next.sessionId
      && prev.canStop === next.canStop
      && prev.errorCode === next.errorCode
      && prev.errorMessage === next.errorMessage
    ) {
      return prev;
    }
    snapshot = next;
    return next;
  };

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const releaseRuntime = (current: Connection) => {
    // A runtime exists only once a machine was asked to start it (possibly still starting).
    if (!current.machineId) return;
    fireAndForget(machineVoiceRuntimeStop(current.machineId, current.sessionKey), { tag: 'realtimePipecat.stop' });
  };

  const disconnect = async () => {
    const current = connection;
    connection = null;
    connecting = false;
    userSpeaking = false;
    botSpeaking = false;
    if (current) {
      current.abort.abort();
      releaseRuntime(current);
    }
    client?.close();
    client = null;
    await stopLocalVoiceSession();
    notify();
  };

  const onRuntimeEvent = (owner: Connection, event: PipecatRuntimeEvent) => {
    if (connection !== owner) return;
    switch (event.type) {
      case 'user_started_speaking':
        userSpeaking = true;
        break;
      case 'user_stopped_speaking':
        userSpeaking = false;
        break;
      case 'bot_started_speaking':
        botSpeaking = true;
        break;
      case 'bot_stopped_speaking':
        botSpeaking = false;
        break;
      case 'bot_interrupted':
        // The runtime already stopped speaking and dropped what it had received; drop the rest
        // of this turn's reply here too, so no later chunk of it is sent.
        interruptLocalVoicePlayback();
        break;
      case 'user_turn':
        fireAndForget(
          runLocalVoiceTextTurn({ sessionId: owner.controlSessionId, text: event.text, speechOutput }),
          { tag: 'realtimePipecat.userTurn' },
        );
        break;
      case 'disconnected':
        fireAndForget(disconnect(), { tag: 'realtimePipecat.disconnected' });
        return;
      default:
        return;
    }
    notify();
  };

  const resolveMachineId = async (controlSessionId: string, requestedTargetSessionId: string | null): Promise<string> => {
    // The runtime runs where the voice conversation runs: the voice agent's conversation session in
    // agent mode, the target session otherwise.
    const binding = controlSessionId === VOICE_AGENT_GLOBAL_SESSION_ID
      ? await voiceSessionBindingManager.ensureBound({ adapterId: ADAPTER_ID, controlSessionId, requestedTargetSessionId })
      : null;
    const machineSessionId = binding?.conversationSessionId ?? controlSessionId;
    const machineId = normalizeNonEmptyString(readMachineTargetForSession(machineSessionId)?.machineId);
    if (!machineId) throw new VoiceRuntimeStartError('voice_runtime_no_machine');
    return machineId;
  };

  const start = async (opts: Readonly<{ sessionId: string; initialContext?: string }>) => {
    if (connection) return;
    const settings: any = storage.getState().settings;
    const cfg = settings?.voicePipecat ?? {};
    const conversationMode = settings?.voice?.adapters?.local_conversation?.conversationMode ?? 'direct_session';
    const requestedSessionId = normalizeNonEmptyString(opts.sessionId);
    const controlSessionId = conversationMode === 'agent' ? VOICE_AGENT_GLOBAL_SESSION_ID : requestedSessionId;
    if (!controlSessionId) return;

    const owner: Connection = {
      controlSessionId,
      machineId: null,
      sessionKey: `pipecat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      abort: new AbortController(),
    };
    connection = owner;
    connecting = true;
    patchLocalVoiceState({ status: 'idle', sessionId: controlSessionId, error: null, errorMessage: null });
    notify();

    try {
      const platform = resolvePipecatPlatform();
      if (!platform) throw new VoiceRuntimeStartError('voice_runtime_unsupported_platform');
      const apiKey = sync.decryptSecretValue(cfg?.deepgram?.apiKey ?? null);
      if (!apiKey) throw new VoiceRuntimeStartError('voice_runtime_not_configured');

      const permission = await requestMicrophonePermission();
      throwIfEnded(owner);
      if (!permission.granted) {
        showMicrophonePermissionDeniedAlert(permission.canAskAgain);
        throw new VoiceRuntimeStartError('voice_runtime_microphone_denied');
      }

      const resolvedMachineId = await resolveMachineId(controlSessionId, conversationMode === 'agent' ? requestedSessionId : null);
      throwIfEnded(owner);
      owner.machineId = resolvedMachineId;
      const timeoutMs = resolveVoiceNetworkTimeoutMs(settings?.voice?.adapters?.local_conversation?.networkTimeoutMs, 15_000);
      const connected = await connectPipecatRuntime({
        platform,
        iceServers: PIPECAT_ICE_SERVERS,
        signal: owner.abort.signal,
        onEvent: (event) => onRuntimeEvent(owner, event),
        negotiate: async (offerSdp) => {
          const response = await machineVoiceRuntimeStart(
            resolvedMachineId,
            {
              sessionKey: owner.sessionKey,
              config: {
                credential: { kind: 'api_key', value: apiKey },
                stt: { model: cfg?.stt?.model ?? 'flux-general-en' },
                tts: { voice: cfg?.tts?.voice ?? 'aura-2-helena-en' },
                iceServers: PIPECAT_ICE_SERVERS.map((server) => ({
                  urls: Array.isArray(server.urls) ? [...server.urls] : [server.urls],
                })),
              },
              offer: { type: 'offer', sdp: offerSdp },
            },
            { timeoutMs },
          );
          if (!response.ok) throw new VoiceRuntimeStartError(response.errorCode, response.runtimeCode);
          return response.answer.sdp;
        },
      });
      if (connection !== owner) {
        connected.close();
        releaseRuntime(owner);
        return;
      }
      client = connected;
      connecting = false;
      notify();
    } catch (error) {
      // Once a start was requested a runtime may exist or still be coming up on the machine, even
      // after a stop: the stop can reach the daemon before the start and find nothing to stop.
      releaseRuntime(owner);
      if (connection !== owner) return;
      connection = null;
      connecting = false;
      const code = error instanceof VoiceRuntimeStartError
        ? error.code
        // A daemon that predates the runtime does not know its RPC at all.
        : isRpcMethodNotFoundError(error) || isRpcMethodNotAvailableError(error)
          ? 'voice_runtime_unavailable'
          : 'voice_runtime_start_failed';
      const detail = error instanceof VoiceRuntimeStartError ? error.detail : error instanceof Error ? error.message : undefined;
      patchLocalVoiceState({ status: 'idle', sessionId: null, error: code, errorMessage: detail ?? null });
      notify();
    }
  };

  const stop = async (_opts: Readonly<{ sessionId: string }>) => {
    await disconnect();
  };

  const toggle = async (opts: Readonly<{ sessionId: string }>) => {
    if (connection) {
      await disconnect();
      return;
    }
    await start({ sessionId: opts.sessionId });
  };

  const interrupt = async (_opts: Readonly<{ sessionId: string }>) => {
    const current = connection;
    if (current) await abortLocalVoiceTurn(current.controlSessionId);
  };

  // Typed into the voice conversation: spoken by the runtime during a call, otherwise text only.
  const silentSpeechOutput: VoiceSpeechOutput = { speak: async () => {} };
  const sendTextTurn: NonNullable<VoiceAdapterController['sendTextTurn']> = (opts) =>
    sendLocalConversationTextTurn(opts, client ? speechOutput : silentSpeechOutput);

  const sendContextUpdate = (opts: Readonly<{ sessionId: string; update: string }>) => {
    const current = connection;
    if (current) appendLocalVoiceAgentContextUpdate(current.controlSessionId, opts.update);
  };

  return {
    id: ADAPTER_ID,
    start,
    stop,
    toggle,
    interrupt,
    sendContextUpdate,
    sendTextTurn,
    getSnapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      // Turn progress and errors live in the local voice state, which the snapshot reads.
      const unsubscribeLocal = subscribeLocalVoiceState(listener);
      return () => {
        listeners.delete(listener);
        unsubscribeLocal();
      };
    },
  };
}

