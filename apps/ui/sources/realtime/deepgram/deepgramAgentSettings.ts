import type { RequiredVoiceClientToolSpec } from '../requiredClientTools';

/**
 * Deepgram Voice Agent `Settings` frame for the managed provider.
 *
 * DO NOT add `agent.language`: Deepgram deprecated it, and any non-English value conflicts with
 * the English-only Flux listen model and is rejected with INVALID_SETTINGS (measured live
 * 2026-11-10 for `de` and `de-DE`; `en`/`en-US` were accepted). These models are English-only, so
 * the user's assistant-language preference cannot be honoured here.
 */
export function buildDeepgramAgentSettings(params: Readonly<{ prompt: string; functions: ReadonlyArray<RequiredVoiceClientToolSpec> }>) {
  return {
    audio: { input: { encoding: 'linear16', sample_rate: 16000 }, output: { encoding: 'linear16', sample_rate: 24000, container: 'none' } },
    agent: {
      listen: { provider: { type: 'deepgram', version: 'v2', model: 'flux-general-en' } },
      think: { provider: { type: 'open_ai', model: 'gpt-4o-mini' }, prompt: params.prompt, functions: params.functions },
      speak: { provider: { type: 'deepgram', model: 'aura-2-thalia-en' } },
    },
  };
}
