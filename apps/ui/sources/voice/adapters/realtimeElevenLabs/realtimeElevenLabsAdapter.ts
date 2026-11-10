import { createRealtimeVoiceAdapter } from '../realtimeVoiceAdapter';

export function createRealtimeElevenLabsVoiceAdapter() {
  return createRealtimeVoiceAdapter('realtime_elevenlabs');
}
