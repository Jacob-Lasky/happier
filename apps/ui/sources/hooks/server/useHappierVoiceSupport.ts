import { useFeatureDecision } from './useFeatureDecision';

/** A resolved server denial may clear managed voice; loading and local policy never do.
 * Callers offering voice controls must require `true` explicitly.
 */
export function useHappierVoiceSupport(providerId: string = 'realtime_elevenlabs'): boolean | null {
    const decision = useFeatureDecision(providerId === 'realtime_deepgram' ? 'voice.deepgram' : 'voice.happierVoice', { scopeKind: 'runtime' });
    if (decision?.state === 'enabled') return true;
    if (decision?.blockedBy === 'server' && (decision.state === 'disabled' || decision.state === 'unsupported')) return false;
    return null;
}
