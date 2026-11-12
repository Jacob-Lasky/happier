import { beforeEach, describe, expect, it, vi } from 'vitest';

// Boundaries: the platform's WebRTC (fake peer connection below), the machine RPC to the daemon,
// microphone permission, settings decryption and the session → machine lookup. The local voice
// engine seam is stubbed like the local conversation adapter's spec does; the RTVI client is real.
const runLocalVoiceTextTurn = vi.fn(async (_params: { sessionId: string; text: string; speechOutput: unknown }) => {});
const interruptLocalVoicePlayback = vi.fn();
const stopLocalVoiceSession = vi.fn(async () => {});
const machineVoiceRuntimeStart = vi.fn(async (_machineId: string, _request: any, _opts?: any): Promise<any> => ({
  ok: true,
  answer: { type: 'answer', sdp: 'v=0 answer' },
}));
const machineVoiceRuntimeStop = vi.fn(async (_machineId: string, _sessionKey: string): Promise<any> => ({ ok: true }));

const state: any = {
  settings: {
    voice: {
      providerId: 'realtime_pipecat',
      adapters: {
        local_conversation: { conversationMode: 'direct_session' },
      },
    },
    voicePipecat: { deepgram: { apiKey: { _isSecretValue: true, value: 'dg-user-key' } }, stt: { model: 'flux-general-en' }, tts: { voice: 'aura-2-helena-en' } },
  },
};

class FakeTarget {
  private readonly listeners = new Map<string, Array<(event: any) => void>>();
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener() {}
  emit(type: string, event: any = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
class FakeChannel extends FakeTarget {
  readyState = 'connecting';
  readonly sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
}
const channel = new FakeChannel();
const peer = Object.assign(new FakeTarget(), {
  iceGatheringState: 'complete',
  connectionState: 'new',
  localDescription: null as null | { sdp: string },
  createDataChannel: () => channel,
  addTrack: () => {},
  createOffer: async () => ({ type: 'offer', sdp: 'v=0 offer' }),
  setLocalDescription: async (description: { sdp: string }) => { peer.localDescription = description; },
  setRemoteDescription: async () => {},
  close: () => {},
});

vi.mock('@/sync/domains/state/storage', async () => {
  const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
  return createStorageModuleStub({ storage: { getState: () => state } });
});
vi.mock('@/voice/local/localVoiceEngine', () => ({
  abortLocalVoiceTurn: vi.fn(async () => {}),
  appendLocalVoiceAgentContextUpdate: vi.fn(),
  getLocalVoiceState: () => ({ status: 'idle', sessionId: null, error: null, errorMessage: null }),
  interruptLocalVoicePlayback,
  runLocalVoiceTextTurn,
  stopLocalVoiceSession,
}));
const sendVoiceTextTurn = vi.fn(async (_params: any) => {});
vi.mock('@/voice/local/sendVoiceTextTurn', () => ({ sendVoiceTextTurn: (params: any) => sendVoiceTextTurn(params) }));
vi.mock('@/voice/agent/voiceAgentSessions', () => ({ voiceAgentSessions: { sendTurn: vi.fn(), stop: vi.fn() } }));
vi.mock('@/sync/ops/machineVoiceRuntime', () => ({ machineVoiceRuntimeStart, machineVoiceRuntimeStop }));
vi.mock('@/sync/ops/sessionMachineTarget', () => ({ readMachineTargetForSession: () => ({ machineId: 'machine-1' }) }));
vi.mock('@/sync/sync', () => ({ sync: { decryptSecretValue: (value: any) => value?.value ?? null } }));
const microphonePermission = vi.fn(async () => ({ granted: true, canAskAgain: true }));
vi.mock('@/utils/platform/microphonePermissions', () => ({
  requestMicrophonePermission: () => microphonePermission(),
  showMicrophonePermissionDeniedAlert: vi.fn(),
}));
vi.mock('@/voice/pipecat/pipecatPlatform', () => ({
  resolvePipecatPlatform: () => ({
    createPeerConnection: () => peer,
    getMicrophone: async () => ({ getTracks: () => [], getAudioTracks: () => [] }),
    playRemoteAudio: () => () => {},
  }),
}));
vi.mock('@/voice/sessionBinding/voiceSessionBindingRuntime', () => ({
  voiceSessionBindingManager: { ensureBound: async () => null },
}));

function runtimeSays(message: unknown) {
  channel.emit('message', { data: JSON.stringify({ label: 'rtvi-ai', ...(message as object) }) });
}

describe('realtime Pipecat voice adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    channel.sent.length = 0;
  });

  it('runs each heard user turn through the local conversation with the runtime speaking the reply', async () => {
    const { createRealtimePipecatVoiceAdapter } = await import('./realtimePipecatAdapter');
    const adapter = createRealtimePipecatVoiceAdapter();
    await adapter.start({ sessionId: 'session-1' });

    expect(machineVoiceRuntimeStart).toHaveBeenCalledWith(
      'machine-1',
      expect.objectContaining({
        config: expect.objectContaining({ credential: { kind: 'api_key', value: 'dg-user-key' } }),
        offer: { type: 'offer', sdp: 'v=0 offer' },
      }),
      expect.anything(),
    );
    expect(adapter.getSnapshot()).toMatchObject({ adapterId: 'realtime_pipecat', status: 'connected', sessionId: 'session-1' });

    runtimeSays({ type: 'server-message', data: { type: 'happier.user_turn', text: 'run the unit tests' } });
    expect(runLocalVoiceTextTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1', text: 'run the unit tests' }));

    runtimeSays({ type: 'bot-started-speaking' });
    expect(adapter.getSnapshot().mode).toBe('speaking');

    runtimeSays({ type: 'bot-interrupted' });
    expect(interruptLocalVoicePlayback).toHaveBeenCalledTimes(1);

    await adapter.stop({ sessionId: 'session-1' });
    expect(machineVoiceRuntimeStop).toHaveBeenCalledWith('machine-1', expect.any(String));
    expect(adapter.getSnapshot().status).toBe('disconnected');
  });

  it('releases the runtime it asked for when the daemon refuses to start one', async () => {
    machineVoiceRuntimeStart.mockResolvedValueOnce({ ok: false, errorCode: 'voice_runtime_unavailable', error: 'voice_runtime_unavailable' });
    const { createRealtimePipecatVoiceAdapter } = await import('./realtimePipecatAdapter');
    const adapter = createRealtimePipecatVoiceAdapter();
    await adapter.start({ sessionId: 'session-1' });

    const sessionKey = machineVoiceRuntimeStart.mock.calls[0]?.[1]?.sessionKey;
    expect(machineVoiceRuntimeStop).toHaveBeenCalledWith('machine-1', sessionKey);
    expect(adapter.getSnapshot().status).not.toBe('connected');
  });

  it('never starts a runtime when the call is ended while the microphone prompt is open', async () => {
    let grant: (value: { granted: boolean; canAskAgain: boolean }) => void = () => {};
    microphonePermission.mockImplementationOnce(() => new Promise((resolve) => { grant = resolve; }));
    const { createRealtimePipecatVoiceAdapter } = await import('./realtimePipecatAdapter');
    const adapter = createRealtimePipecatVoiceAdapter();
    const starting = adapter.start({ sessionId: 'session-1' });
    await Promise.resolve();
    await adapter.stop({ sessionId: 'session-1' });
    grant({ granted: true, canAskAgain: true });
    await starting;

    expect(machineVoiceRuntimeStart).not.toHaveBeenCalled();
    expect(adapter.getSnapshot().status).toBe('disconnected');
  });

  it('releases a runtime whose start was still running on the daemon when the call ended', async () => {
    let answer: (value: unknown) => void = () => {};
    machineVoiceRuntimeStart.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const { createRealtimePipecatVoiceAdapter } = await import('./realtimePipecatAdapter');
    const adapter = createRealtimePipecatVoiceAdapter();
    const starting = adapter.start({ sessionId: 'session-1' });
    for (let i = 0; i < 50 && machineVoiceRuntimeStart.mock.calls.length === 0; i += 1) await Promise.resolve();
    const sessionKey = machineVoiceRuntimeStart.mock.calls[0]?.[1]?.sessionKey;
    await adapter.stop({ sessionId: 'session-1' });
    const stopsBeforeStartReturned = machineVoiceRuntimeStop.mock.calls.length;
    answer({ ok: true, answer: { type: 'answer', sdp: 'v=0 answer' } });
    await starting;

    // A stop issued while the daemon was still starting the runtime can arrive first and find
    // nothing; the runtime must be released again once its start has returned.
    expect(machineVoiceRuntimeStop.mock.calls.length).toBeGreaterThan(stopsBeforeStartReturned);
    expect(machineVoiceRuntimeStop).toHaveBeenLastCalledWith('machine-1', sessionKey);
    expect(adapter.getSnapshot().status).toBe('disconnected');
  });

  it('sends typed turns of an agent conversation through the local conversation, spoken by the runtime when connected', async () => {
    state.settings.voice.adapters.local_conversation.conversationMode = 'agent';
    try {
      const { createRealtimePipecatVoiceAdapter } = await import('./realtimePipecatAdapter');
      const adapter = createRealtimePipecatVoiceAdapter();
      await adapter.sendTextTurn?.({
        controlSessionId: 'control-1',
        conversationSessionId: 'conversation-1',
        text: 'what changed?',
        localId: 'local-1',
        handoffMode: 'interrupt_and_send',
      });
      expect(sendVoiceTextTurn).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'control-1',
        userText: 'what changed?',
        durableDispatch: { localId: 'local-1', handoffMode: 'interrupt_and_send' },
        speechOutput: expect.objectContaining({ speak: expect.any(Function) }),
      }));
    } finally {
      state.settings.voice.adapters.local_conversation.conversationMode = 'direct_session';
    }
  });

  it('reports the runtime as unavailable on a daemon that predates it', async () => {
    const { createRpcCallError } = await import('@/sync/runtime/rpcErrors');
    const { RPC_ERROR_CODES } = await import('@happier-dev/protocol/rpc');
    machineVoiceRuntimeStart.mockRejectedValueOnce(createRpcCallError({ error: 'method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }));
    const patches: any[] = [];
    const localState = await import('@/voice/local/localVoiceState');
    const unsubscribe = localState.subscribeLocalVoiceState(() => patches.push(localState.getLocalVoiceState()));
    const { createRealtimePipecatVoiceAdapter } = await import('./realtimePipecatAdapter');
    await createRealtimePipecatVoiceAdapter().start({ sessionId: 'session-1' });
    unsubscribe();
    expect(patches.at(-1)).toMatchObject({ error: 'voice_runtime_unavailable' });
  });
});
