import { useEffect } from 'react';
import { buildRealtimeVoiceAgentPrompt } from '@happier-dev/agents';
import type { VoiceSession, VoiceSessionConfig } from './types';
import { DeepgramVoiceSession } from './deepgram/DeepgramVoiceSession';
import { buildDeepgramAgentSettings } from './deepgram/deepgramAgentSettings';
import { createDeepgramAudio } from './deepgram/deepgramAudio.web';
import { registerVoiceSession, setCurrentRealtimeControlSessionId, stopRealtimeSession, unregisterVoiceSession } from './RealtimeSession';
import { resolveRequiredVoiceClientTools } from './requiredClientTools';
import { realtimeClientTools } from './realtimeClientTools';
import { storage } from '@/sync/domains/state/storage';
import { resolveDisabledVoiceActionIdsFromState } from '@/voice/tools/resolveDisabledVoiceActionIds';
import { resolveVoiceSessionBindingByControlSessionId } from '@/voice/sessionBinding/resolveVoiceSessionBinding';
import { appendRealtimeVoiceTranscriptEvent } from './realtimeVoiceTranscriptBridge';
import { useVoiceQaStore } from '@/voice/qa/voiceQaStore';

class WebDeepgramVoiceSession implements VoiceSession {
  private active: DeepgramVoiceSession | null = null;
  private connected = false;

  async startSession(config: VoiceSessionConfig): Promise<string | null> {
    await this.endSession();
    const state = storage.getState();
    const functions = resolveRequiredVoiceClientTools(state);
    setCurrentRealtimeControlSessionId(config.sessionId);
    const runtime = new DeepgramVoiceSession({
      // Only the bearer subprotocol on /v1/agent/converse opened from a browser (probed live 2026-11-10;
      // the bare host and the `token` query parameter were refused).
      createSocket: token => new WebSocket('wss://agent.deepgram.com/v1/agent/converse', ['bearer', token]),
      audio: createDeepgramAudio(speaking => storage.getState().setRealtimeMode(speaking ? 'speaking' : 'idle', true)),
      settings: buildDeepgramAgentSettings({
        prompt: buildRealtimeVoiceAgentPrompt({ initialConversationContextPlaceholder: config.initialContext ?? '', sessionIdPlaceholder: config.sessionId, disabledActionIds: resolveDisabledVoiceActionIdsFromState(state) }),
        functions,
      }),
      tools: Object.fromEntries(functions.filter(tool => typeof realtimeClientTools[tool.name] === 'function').map(tool => [tool.name, realtimeClientTools[tool.name]])),
      onStatus: status => {
        storage.getState().setRealtimeStatus(status);
        if (status === 'connected') this.connected = true;
        if (status === 'disconnected' && this.connected) {
          this.connected = false;
          void stopRealtimeSession();
        }
      },
      onError: error => {
        console.warn('Deepgram voice session failed:', error.message);
        useVoiceQaStore.getState().appendSystem(error.message);
      },
      onMessage: message => {
        useVoiceQaStore.getState().appendRealtimeProviderPayload(message);
        if (message.type !== 'ConversationText') return;
        const binding = resolveVoiceSessionBindingByControlSessionId({ controlSessionId: config.sessionId, adapterId: 'realtime_deepgram' });
        appendRealtimeVoiceTranscriptEvent({ conversationSessionId: binding?.conversationSessionId ?? null, payload: { role: message.role, text: message.content } });
      },
    });
    this.active = runtime;
    return runtime.startSession(config);
  }

  async endSession(): Promise<void> {
    this.connected = false;
    const runtime = this.active;
    this.active = null;
    await runtime?.endSession();
  }

  sendTextMessage(message: string): void { this.active?.sendTextMessage(message); }
  sendContextualUpdate(update: string): void { this.active?.sendContextualUpdate(update); }
}

export function RealtimeDeepgramVoiceSession() {
  useEffect(() => {
    const session = new WebDeepgramVoiceSession();
    registerVoiceSession(session, 'realtime_deepgram');
    // Unmount must settle an active call's lease, not just close its socket.
    return () => { void unregisterVoiceSession(session, 'realtime_deepgram'); };
  }, []);
  return null;
}
