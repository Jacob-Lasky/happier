import type { FeaturesPayloadDelta } from "./types";
import { resolveElevenLabsAgentId } from "@/voice/elevenLabsEnv";
import { resolveDeepgramApiKey } from "@/voice/deepgramVoice";
import { readVoiceFeatureEnv } from "./catalog/readFeatureEnv";

/** Single owner of "is this managed voice provider configured"; the mint route reuses it for deny reasons. */
export function resolveVoiceProviderConfiguration(env: NodeJS.ProcessEnv): Readonly<{ elevenlabs: boolean; deepgram: boolean }> {
    const requireSubscription = readVoiceFeatureEnv(env).requireSubscription;
    const revenueCatConfigured = !requireSubscription || Boolean(env.REVENUECAT_SECRET_KEY?.trim());
    const elevenLabsConfigured = Boolean(env.ELEVENLABS_API_KEY?.trim()) && Boolean(resolveElevenLabsAgentId(env));
    return {
        elevenlabs: elevenLabsConfigured && revenueCatConfigured,
        deepgram: Boolean(resolveDeepgramApiKey(env)) && revenueCatConfigured,
    };
}

export function resolveVoiceFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const enabled = readVoiceFeatureEnv(env).enabled;
    const configuration = resolveVoiceProviderConfiguration(env);
    const configured = configuration.elevenlabs;

    return {
        features: {
            voice: {
                enabled,
                happierVoice: { enabled: enabled && configured },
                deepgram: { enabled: enabled && configuration.deepgram },
            },
        },
        capabilities: {
            voice: {
                configured,
                provider: configured ? "elevenlabs" : null,
                requested: enabled,
            },
        },
    };
}
