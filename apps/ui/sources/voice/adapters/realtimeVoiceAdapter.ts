import { voiceHooks } from '@/voice/context/voiceHooks';
import {
  getVoiceSession,
  getCurrentRealtimeProviderId,
  isVoiceSessionStarted,
  startRealtimeSession,
  stopRealtimeSession,
} from '@/realtime/RealtimeSession';
import { storage } from '@/sync/domains/state/storage';
import type { RealtimeVoiceProviderId } from '@/sync/domains/settings/voiceSettings';
import type { VoiceAdapterController, VoiceSessionMode, VoiceSessionSnapshot, VoiceSessionStatus } from '@/voice/session/types';
import { appendVoiceConversationUserText } from '@/voice/sessionBinding/voiceConversationTranscript';

function mapRealtimeStatus(status: unknown): VoiceSessionStatus {
  if (status === 'connecting' || status === 'connected' || status === 'error') return status;
  return 'disconnected';
}

function mapRealtimeMode(mode: unknown): VoiceSessionMode {
  if (mode === 'speaking') return 'speaking';
  return 'idle';
}

export function createRealtimeVoiceAdapter(id: RealtimeVoiceProviderId): VoiceAdapterController {
  const getSnapshot = (): VoiceSessionSnapshot => {
    const state = storage.getState();
    const ownsSession = getCurrentRealtimeProviderId() === id;
    const status = ownsSession ? mapRealtimeStatus(state.realtimeStatus) : "disconnected";
    const mode = ownsSession ? mapRealtimeMode(state.realtimeMode) : "idle";
    return {
      adapterId: id,
      // Realtime voice is account-scoped; the connection is not owned by any single session.
      sessionId: null,
      status,
      mode,
      canStop: status === 'connected' || status === 'connecting',
    };
  };

  const start = async (opts: Readonly<{ sessionId: string; initialContext?: string }>) => {
    const initialContext = opts.initialContext ?? voiceHooks.onVoiceStarted(opts.sessionId);
    await startRealtimeSession(opts.sessionId, initialContext, false, { providerId: id });
  };

  const stop = async (_opts: Readonly<{ sessionId: string }>) => {
    await stopRealtimeSession();
    voiceHooks.onVoiceStopped();
  };

  const toggle = async (opts: Readonly<{ sessionId: string }>) => {
    const snap = getSnapshot();
    if (snap.status === 'connecting') {
      return;
    }
    if (snap.status === 'connected') {
      await stop({ sessionId: opts.sessionId });
      return;
    }
    await start({ sessionId: opts.sessionId });
  };

  const interrupt = async (_opts: Readonly<{ sessionId: string }>) => {
    // Realtime voice supports a call-like UX; for now interrupt == stop.
    const snap = getSnapshot();
    if (snap.status === 'connected' || snap.status === 'connecting') {
      await stopRealtimeSession().catch(() => {});
      voiceHooks.onVoiceStopped();
    }
  };

  const sendContextUpdate = (opts: Readonly<{ sessionId: string; update: string }>) => {
    const voice = getVoiceSession();
    if (!voice || !isVoiceSessionStarted()) return;
    voice.sendContextualUpdate(opts.update);
  };

  const sendTextTurn: NonNullable<VoiceAdapterController['sendTextTurn']> = async (opts) => {
    const voice = getVoiceSession();
    if (!voice) {
      throw new Error('voice_service_unavailable');
    }
    appendVoiceConversationUserText({
      conversationSessionId: opts.conversationSessionId,
      text: opts.text,
      localId: opts.localId,
    });
    if (!isVoiceSessionStarted()) {
      await startRealtimeSession(opts.controlSessionId, undefined, false, { textOnly: true, providerId: id });
    }
    const activeVoice = getVoiceSession();
    if (!activeVoice) {
      throw new Error('voice_service_unavailable');
    }
    activeVoice.sendTextMessage(opts.text);
  };

  const subscribe = (listener: () => void) => {
    return storage.subscribe((state, prevState) => {
      if (state?.realtimeStatus !== prevState?.realtimeStatus) {
        listener();
        return;
      }
      if (state?.realtimeMode !== prevState?.realtimeMode) {
        listener();
      }
    });
  };

  return {
    id,
    start,
    stop,
    toggle,
    interrupt,
    sendContextUpdate,
    sendTextTurn,
    getSnapshot,
    subscribe,
  };
}
