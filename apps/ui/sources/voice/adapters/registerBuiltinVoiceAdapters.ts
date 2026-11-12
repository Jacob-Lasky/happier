import type { VoiceAdapterController } from '@/voice/session/types';
import { createLocalConversationVoiceAdapter } from './localConversation/localConversationAdapter';
import { createLocalDirectVoiceAdapter } from './localDirect/localDirectAdapter';
import { createRealtimeElevenLabsVoiceAdapter } from './realtimeElevenLabs/realtimeElevenLabsAdapter';
import { createRealtimePipecatVoiceAdapter } from './realtimePipecat/realtimePipecatAdapter';

export function createBuiltinVoiceAdapters(): ReadonlyArray<VoiceAdapterController> {
  return [
    createRealtimeElevenLabsVoiceAdapter(),
    createRealtimePipecatVoiceAdapter(),
    createLocalDirectVoiceAdapter(),
    createLocalConversationVoiceAdapter(),
  ];
}

