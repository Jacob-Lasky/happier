import { useEffect } from 'react';
import { buildRealtimeVoiceAgentPrompt } from '@happier-dev/agents';
import type { VoiceSession, VoiceSessionConfig } from './types';
import { DeepgramVoiceSession } from './deepgram/DeepgramVoiceSession';
import { createDeepgramAudio } from './deepgram/deepgramAudio.web';
import { registerVoiceSession, setCurrentRealtimeControlSessionId, stopRealtimeSession } from './RealtimeSession';
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
    const settings = state.settings.voice.adapters.realtime_deepgram;
    const functions = resolveRequiredVoiceClientTools(state);
    setCurrentRealtimeControlSessionId(config.sessionId);
    const runtime = new DeepgramVoiceSession({
      createSocket: token => new WebSocket('wss://agent.deepgram.com/v1/agent/converse', ['bearer', token]),
      audio: createDeepgramAudio(speaking => storage.getState().setRealtimeMode(speaking ? 'speaking' : 'idle', true)),
      settings: {
        audio: { input: { encoding: 'linear16', sample_rate: 16000 }, output: { encoding: 'linear16', sample_rate: 24000, container: 'none' } },
        agent: {
          language: settings.assistantLanguage ?? state.settings.voice.assistantLanguage ?? 'en',
          listen: { provider: { type: 'deepgram', version: 'v2', model: settings.listenModel } },
          think: {
            provider: { type: 'open_ai', model: settings.thinkModel },
            prompt: buildRealtimeVoiceAgentPrompt({ initialConversationContextPlaceholder: config.initialContext ?? '', sessionIdPlaceholder: config.sessionId, disabledActionIds: resolveDisabledVoiceActionIdsFromState(state) }),
            functions,
          },
          speak: { provider: { type: 'deepgram', model: settings.speakModel } },
        },
      },
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
    return () => { void session.endSession(); };
  }, []);
  return null;
}
