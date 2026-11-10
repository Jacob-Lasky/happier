import { createRealtimeVoiceAdapter } from '../realtimeVoiceAdapter';

export function createRealtimeDeepgramVoiceAdapter() {
  return createRealtimeVoiceAdapter('realtime_deepgram');
}
