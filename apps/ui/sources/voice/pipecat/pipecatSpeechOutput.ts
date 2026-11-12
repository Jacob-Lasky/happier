import type { VoiceSpeechOutput } from '@/voice/output/speakAssistantText';

import type { PipecatRuntimeClient } from './pipecatRuntimeClient';

/**
 * Speaks reply text through the runtime's TTS. Every speak call (a reply, or a chunk of a streamed
 * reply) becomes one runtime reply with its own increasing `seq`; the runtime queues them in order.
 *
 * Only the newest reply needs a stopper: cancelling it interrupts the runtime's speech, which also
 * drops everything still queued, and every earlier reply is already closed by then.
 */
export function createPipecatSpeechOutput(getClient: () => PipecatRuntimeClient | null): VoiceSpeechOutput {
  let nextSeq = 0;
  let releaseStopper: (() => void) | null = null;

  return {
    speak: async ({ text, registerPlaybackStopper, onSpeaking }) => {
      const client = getClient();
      if (!client) throw new Error('voice_runtime_disconnected');
      const seq = nextSeq;
      nextSeq += 1;
      client.speak(seq, text, true);
      releaseStopper?.();
      releaseStopper = registerPlaybackStopper(() => client.cancel(seq));
      onSpeaking();
    },
  };
}
