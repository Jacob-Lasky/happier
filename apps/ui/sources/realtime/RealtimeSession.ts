import { isRealtimeVoiceProviderId, type RealtimeVoiceProviderId } from '@/sync/domains/settings/voiceSettings';
import type { VoiceSession } from './types';
import { completeHappierVoiceSession, fetchHappierVoiceToken, VoiceSessionCompleteError } from '@/sync/api/voice/apiVoice';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { t } from '@/text';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';
import { fetchElevenLabsConversationSignedUrlByo, fetchElevenLabsConversationTokenByo } from './elevenLabsByo';
import { disableVoiceBackgroundCallAudioMode, enableVoiceBackgroundCallAudioMode } from '@/voice/runtime/voiceAudioMode';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceSessionBindingManager } from '@/voice/sessionBinding/voiceSessionBindingRuntime';
import { resolveVoiceSessionBindingByControlSessionId } from '@/voice/sessionBinding/resolveVoiceSessionBinding';
import { appendVoiceConversationNoteText } from '@/voice/sessionBinding/voiceConversationTranscript';
import { applyVoiceSessionTargetSelection } from '@/voice/sessionBinding/applyVoiceSessionTargetSelection';

type RealtimeProviderId = RealtimeVoiceProviderId;
const voiceSessions = new Map<RealtimeProviderId, VoiceSession>();
let voiceSession: VoiceSession | null = null;
let currentAdapterId: RealtimeProviderId = 'realtime_elevenlabs';
let voiceSessionStarted: boolean = false;
let startInFlight: Promise<void> | null = null;
let startInFlightAbortController: AbortController | null = null;
let currentLeaseId: string | null = null;
let currentLeaseOwner: ManagedLeaseOwner | null = null;
let currentProviderConversationId: string | null = null;
let currentBilledMode: 'happier' | 'byo' | null = null;
let currentControlSessionId: string | null = null;
let currentLeaseExpiresAtMs: number | null = null;
let currentLeaseWarningTimer: ReturnType<typeof setTimeout> | null = null;
let currentLeaseExpiryTimer: ReturnType<typeof setTimeout> | null = null;
let latestRequestedTargetSessionId: string | null = null;

function clearRealtimeLeaseTimers(): void {
    if (currentLeaseWarningTimer) {
        clearTimeout(currentLeaseWarningTimer);
        currentLeaseWarningTimer = null;
    }
    if (currentLeaseExpiryTimer) {
        clearTimeout(currentLeaseExpiryTimer);
        currentLeaseExpiryTimer = null;
    }
}

function resetRealtimeUiState(): void {
    const state = storage.getState();
    state.setRealtimeStatus('disconnected');
    state.setRealtimeMode('idle', true);
    state.clearRealtimeModeDebounce();
}

function formatVoiceLeaseDurationShort(ms: number): string {
    const bounded = Math.max(0, Math.floor(ms));
    if (bounded < 90_000) {
        return `${Math.max(1, Math.ceil(bounded / 1000))}s`;
    }
    return `${Math.max(1, Math.ceil(bounded / 60_000))}m`;
}

function appendRealtimeLeaseNote(text: string): void {
    const controlSessionId = currentControlSessionId;
    if (!controlSessionId) return;
    const binding = resolveVoiceSessionBindingByControlSessionId({
        controlSessionId,
        adapterId: currentAdapterId,
    });
    const conversationSessionId = binding?.conversationSessionId?.trim();
    if (!conversationSessionId) return;
    appendVoiceConversationNoteText({
        conversationSessionId,
        text,
    });
}

function scheduleRealtimeLeaseAnnouncements(expiresAtMs: number): void {
    clearRealtimeLeaseTimers();
    currentLeaseExpiresAtMs = expiresAtMs;

    const remainingMs = expiresAtMs - Date.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return;

    appendRealtimeLeaseNote(t('errors.voiceSessionLimitStarted', { duration: formatVoiceLeaseDurationShort(remainingMs) }));

    const warningLeadMs = 60_000;
    const warningDelayMs = remainingMs - warningLeadMs;
    if (warningDelayMs <= 0) {
        appendRealtimeLeaseNote(t('errors.voiceSessionLimitExpiring', { duration: formatVoiceLeaseDurationShort(remainingMs) }));
    } else {
        currentLeaseWarningTimer = setTimeout(() => {
            appendRealtimeLeaseNote(t('errors.voiceSessionLimitExpiring', { duration: formatVoiceLeaseDurationShort(Math.max(0, expiresAtMs - Date.now())) }));
        }, warningDelayMs);
    }

    currentLeaseExpiryTimer = setTimeout(() => {
        appendRealtimeLeaseNote(t('errors.voiceSessionLimitExpired'));
        void stopRealtimeSession();
    }, remainingMs);
}

function normalizeRequestedTargetSessionId(sessionId: string | null): string | null {
    const trimmed = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!trimmed || trimmed === VOICE_AGENT_GLOBAL_SESSION_ID) return null;
    return trimmed;
}

function buildElevenLabsWelcomeContext(welcomeCfg: any): string {
    if (!welcomeCfg || welcomeCfg.enabled !== true) return '';
    const mode = welcomeCfg.mode === 'on_first_turn' ? 'on_first_turn' : 'immediate';
    if (mode === 'on_first_turn') {
        return [
            'On your first reply, start with one short friendly greeting (one sentence).',
            'Then continue with your response.',
        ].join('\n');
    }
    return [
        'Start this session with one short friendly greeting.',
        'Then wait for the user to speak again.',
    ].join('\n');
}

function appendOptionalWelcomeToContext(baseContext: string | null | undefined, welcomeCfg: any): string | undefined {
    const base = typeof baseContext === 'string' ? baseContext.trim() : '';
    const welcome = buildElevenLabsWelcomeContext(welcomeCfg).trim();
    if (!base && !welcome) return undefined;
    if (!welcome) return base;
    if (!base) return welcome;
    return `${base}\n\n${welcome}`;
}

export async function startRealtimeSession(
    sessionId: string,
    initialContext?: string,
    retryAfterPaywall = false,
    options?: Readonly<{ textOnly?: boolean; providerId?: RealtimeProviderId }>,
) {
    // The calling adapter names its provider; callers without one (QA) use the saved selection.
    const selectedProviderId = options?.providerId ?? storage.getState().settings.voice.providerId;
    if (!isRealtimeVoiceProviderId(selectedProviderId)) return;
    const session = voiceSessions.get(selectedProviderId);
    if (!session) {
        // Synced settings can select a provider this platform has no runtime for (Deepgram is web-only).
        Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
        return;
    }

    const normalizedSessionId = String(sessionId ?? '').trim();
    const requestedTargetSessionId = normalizeRequestedTargetSessionId(normalizedSessionId);
    const controlSessionId = normalizedSessionId || VOICE_AGENT_GLOBAL_SESSION_ID;
    latestRequestedTargetSessionId = requestedTargetSessionId;
    if (requestedTargetSessionId) {
        applyVoiceSessionTargetSelection({
            controlSessionId,
            targetSessionId: requestedTargetSessionId,
            updateLastFocused: true,
        });
    }

    const settings: any = storage.getState().settings;

    // Realtime voice is account-scoped: if a start is already in-flight, dedupe and await it.
    if (startInFlight) {
        await startInFlight;
        return;
    }
    
    if (voiceSessionStarted) {
        if (currentAdapterId === selectedProviderId) return;
        await stopRealtimeSession();
    }
    currentAdapterId = selectedProviderId;
    voiceSession = session;
    const abortController = new AbortController();
    startInFlightAbortController = abortController;

    const run = async () => {
        try {
            clearRealtimeLeaseTimers();
            currentLeaseExpiresAtMs = null;
            if (options?.textOnly !== true) {
                // Request microphone permission before starting voice session
                // Critical for iOS/Android - first session will fail without this
                const permissionResult = await requestMicrophonePermission();
                if (!permissionResult.granted) {
                    showMicrophonePermissionDeniedAlert(permissionResult.canAskAgain);
                    return;
                }
            }

            if (abortController.signal.aborted) {
                return;
            }

            const realtimeCfg = settings?.voice?.adapters?.[selectedProviderId] ?? null;
            const billingMode = selectedProviderId === 'realtime_elevenlabs' && realtimeCfg?.billingMode === 'byo' ? 'byo' : 'happier';
            const effectiveInitialContext = appendOptionalWelcomeToContext(initialContext, realtimeCfg?.welcome);
            await voiceSessionBindingManager.ensureBound({
                adapterId: currentAdapterId,
                controlSessionId,
                requestedTargetSessionId,
            });

            if (billingMode === 'byo') {
                const agentId = String(realtimeCfg?.byo?.agentId ?? '').trim();
                const apiKey = sync.decryptSecretValue(realtimeCfg?.byo?.apiKey) ?? '';
                if (!agentId || !apiKey) {
                    Modal.alert(t('common.error'), t('settingsVoice.byo.notConfigured'));
                    return;
                }

                const signedUrl = options?.textOnly === true
                    ? await fetchElevenLabsConversationSignedUrlByo({ agentId, apiKey })
                    : null;
                const token = signedUrl
                    ? null
                    : await fetchElevenLabsConversationTokenByo({ agentId, apiKey });
                if (abortController.signal.aborted) return;

                await enableVoiceBackgroundCallAudioMode();
                const conversationId = await session.startSession({
                    sessionId: controlSessionId,
                    initialContext: effectiveInitialContext,
                    token: token ?? undefined,
                    signedUrl: signedUrl ?? undefined,
                    textOnly: options?.textOnly === true,
                });
                if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
                    await disableVoiceBackgroundCallAudioMode();
                    return;
                }
                if (abortController.signal.aborted) {
                    try {
                        await session.endSession();
                    } catch {
                        // best-effort cleanup
                    }
                    await disableVoiceBackgroundCallAudioMode();
                    return;
                }
                currentProviderConversationId = conversationId;
                currentLeaseId = null;
                currentBilledMode = 'byo';
                currentControlSessionId = controlSessionId;
                voiceSessionStarted = true;
                if (latestRequestedTargetSessionId && latestRequestedTargetSessionId !== requestedTargetSessionId) {
                    applyVoiceSessionTargetSelection({
                        controlSessionId,
                        targetSessionId: latestRequestedTargetSessionId,
                        updateLastFocused: false,
                    });
                }
                return;
            }

            // Happier Voice: always use authenticated server-minted conversation tokens.
            // An unverified earlier lease still holds the account's concurrency slot; release it first.
            await flushManagedVoiceCompletions();
            const credentials = await TokenStorage.getCredentials();
            if (!credentials) {
                Modal.alert(t('common.error'), t('errors.authenticationFailed'));
                return;
            }

            let hasRetriedAfterPaywall = retryAfterPaywall;
            for (;;) {
                const response = await fetchHappierVoiceToken(credentials, {
                    sessionId: requestedTargetSessionId,
                    ...(selectedProviderId === 'realtime_deepgram' ? { providerId: 'deepgram' as const } : {}),
                    signal: abortController.signal,
                });
                if (abortController.signal.aborted) return;
                if (response.allowed) {
                    const leaseOwner = resolveManagedLeaseOwner();
                    currentLeaseId = response.leaseId;
                    currentLeaseOwner = leaseOwner;
                    currentBilledMode = 'happier';
                    currentControlSessionId = controlSessionId;
                    await enableVoiceBackgroundCallAudioMode();
                    const conversationId = await session.startSession({
                        sessionId: controlSessionId,
                        initialContext: effectiveInitialContext,
                        token: response.token,
                        ...(selectedProviderId === "realtime_deepgram" ? {
                            leaseId: response.leaseId,
                            signal: abortController.signal,
                            onConversationId: (id: string) => { if (!abortController.signal.aborted) currentProviderConversationId = id; },
                        } : {}),
                        textOnly: options?.textOnly === true,
                    });
                    if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
                        await disableVoiceBackgroundCallAudioMode();
                        return;
                    }
                    if (abortController.signal.aborted) {
                        try {
                            await session.endSession();
                        } catch {
                            // best-effort cleanup
                        }
                        // Stop raced the connect: the provider call exists, so its lease must still be completed.
                        retainManagedVoiceCompletion(response.leaseId, conversationId, leaseOwner);
                        void flushManagedVoiceCompletions();
                        await disableVoiceBackgroundCallAudioMode();
                        return;
                    }
                    currentProviderConversationId = conversationId;
                    currentLeaseId = response.leaseId;
                    currentLeaseOwner = leaseOwner;
                    currentBilledMode = 'happier';
                    currentControlSessionId = controlSessionId;
                    voiceSessionStarted = true;
                    if (latestRequestedTargetSessionId && latestRequestedTargetSessionId !== requestedTargetSessionId) {
                        applyVoiceSessionTargetSelection({
                            controlSessionId,
                            targetSessionId: latestRequestedTargetSessionId,
                            updateLastFocused: false,
                        });
                    }
                    scheduleRealtimeLeaseAnnouncements(response.expiresAtMs);
                    return;
                }

                // Subscription/quota: show paywall.
                if (response.reason === 'subscription_required' || response.reason === 'quota_exceeded') {
                    if (hasRetriedAfterPaywall) {
                        Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
                        return;
                    }
                    const result = await sync.presentPaywall();
                    if (result.purchased) {
                        hasRetriedAfterPaywall = true;
                        continue;
                    }
                    return;
                }

                Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
                return;
            }
        } catch (error) {
            if (abortController.signal.aborted) {
                // If stop requested while start is in-flight, don't surface a spurious error.
                return;
            }
            console.error('Failed to start realtime session:', error);
            await session.endSession().catch(() => {});
            retainCurrentManagedVoiceCompletion();
            await flushManagedVoiceCompletions();
            voiceSessionStarted = false;
            currentBilledMode = null;
            currentControlSessionId = null;
            Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
        }
    };

    const promise = run();
    startInFlight = promise;
    try {
        await promise;
    } finally {
        if (startInFlight === promise) {
            startInFlight = null;
            startInFlightAbortController = null;
        }
    }
}

type ManagedLeaseOwner = Readonly<{ serverId: string; accountId: string }>;
type PendingManagedCompletion = ManagedLeaseOwner & Readonly<{ providerConversationId: string }>;

/** Managed leases whose provider usage is not yet verified, keyed by lease id. */
const pendingManagedCompletions = new Map<string, PendingManagedCompletion>();
let managedCompletionFlight: Promise<void> | null = null;

/** The server and account a lease was minted on; only they can verify it. */
function resolveManagedLeaseOwner(): ManagedLeaseOwner {
    return { serverId: getActiveServerSnapshot().serverId, accountId: storage.getState().profile?.id ?? '' };
}

function retainManagedVoiceCompletion(leaseId: string, providerConversationId: string, owner: ManagedLeaseOwner): void {
    pendingManagedCompletions.set(leaseId, { ...owner, providerConversationId });
}

/** Moves the active managed lease into the pending set so later awaits cannot see or reuse it. */
function retainCurrentManagedVoiceCompletion(): void {
    if (currentBilledMode === 'happier' && currentLeaseId && currentProviderConversationId && currentLeaseOwner) {
        retainManagedVoiceCompletion(currentLeaseId, currentProviderConversationId, currentLeaseOwner);
    }
    currentLeaseId = null;
    currentLeaseOwner = null;
    currentProviderConversationId = null;
}

/**
 * Completes pending managed leases owned by the active server and account (single flight). A
 * lease retained while the flight runs is picked up by the same flight, so a caller awaiting it
 * never mints past one. A lease the server could not verify stays pending and is retried before
 * the next mint, because it holds the account's concurrency slot until verified or expired. A
 * rejected lease (404) is dropped: retrying cannot change it. Leases of another server or account
 * wait until that owner is active again; sending them elsewhere would read as a rejection.
 */
function flushManagedVoiceCompletions(): Promise<void> {
    if (managedCompletionFlight) return managedCompletionFlight;
    if (pendingManagedCompletions.size === 0) return Promise.resolve();
    const flight = (async () => {
        const attempted = new Set<string>();
        for (;;) {
            const owner = resolveManagedLeaseOwner();
            const next = [...pendingManagedCompletions].find(([leaseId, pending]) => (
                !attempted.has(leaseId) && pending.serverId === owner.serverId && pending.accountId === owner.accountId
            ));
            if (!next) return;
            const [leaseId, { providerConversationId }] = next;
            attempted.add(leaseId);
            const credentials = await TokenStorage.getCredentials();
            if (!credentials) return;
            try {
                await completeHappierVoiceSession(credentials, { leaseId, providerConversationId });
                pendingManagedCompletions.delete(leaseId);
            } catch (error) {
                const rejected = error instanceof VoiceSessionCompleteError && error.status === 404;
                if (rejected) pendingManagedCompletions.delete(leaseId);
                console.warn('Failed to complete Happier voice session:', { leaseId, providerConversationId, retained: !rejected, error });
            }
        }
    })();
    managedCompletionFlight = flight.finally(() => { managedCompletionFlight = null; });
    return managedCompletionFlight;
}

let stopInFlight: Promise<void> | null = null;

/** Single flight: overlapping stops (user, provider change, unmount, lease expiry) share one teardown. */
export function stopRealtimeSession(): Promise<void> {
    stopInFlight ??= runStopRealtimeSession().finally(() => { stopInFlight = null; });
    return stopInFlight;
}

async function runStopRealtimeSession(): Promise<void> {
    if (!voiceSession) {
        resetRealtimeUiState();
        return;
    }
    
    try {
        clearRealtimeLeaseTimers();
        // Best-effort cancel any token-minting in-flight so stop can't deadlock.
        startInFlightAbortController?.abort();
        const inFlight = startInFlight;
        if (inFlight) {
            await Promise.race([inFlight.catch(() => {}), new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
            // If start is still stuck (e.g., a hung provider start), clear the in-flight marker so voice can be used again.
            if (startInFlight === inFlight) {
                startInFlight = null;
                startInFlightAbortController = null;
            }
        }
        await voiceSession.endSession();

        retainCurrentManagedVoiceCompletion();
        await flushManagedVoiceCompletions();

        voiceSessionStarted = false;
        latestRequestedTargetSessionId = null;
        currentLeaseExpiresAtMs = null;
        currentBilledMode = null;
        currentControlSessionId = null;
    } catch (error) {
        console.error('Failed to stop realtime session:', error);
    } finally {
        resetRealtimeUiState();
        await disableVoiceBackgroundCallAudioMode();
    }
}

export function registerVoiceSession(session: VoiceSession, providerId: RealtimeProviderId = "realtime_elevenlabs") {
    voiceSessions.set(providerId, session);
    if (!voiceSession || (!voiceSessionStarted && !startInFlight && providerId === storage.getState().settings.voice.providerId)) voiceSession = session;
}

/** Unmount path for a provider runtime: settle its active call through the finalizer, then forget the runtime. */
export async function unregisterVoiceSession(session: VoiceSession, providerId: RealtimeProviderId): Promise<void> {
    if (voiceSessions.get(providerId) === session) voiceSessions.delete(providerId);
    if (voiceSession === session && (voiceSessionStarted || startInFlight)) {
        await stopRealtimeSession();
    } else {
        await session.endSession();
    }
    // A remounted runtime may have taken over while this one stopped; release only our own pointer.
    if (voiceSession === session) voiceSession = null;
}

export function isVoiceSessionStarted(): boolean {
    return voiceSessionStarted;
}

export function getVoiceSession(): VoiceSession | null {
    return voiceSessionStarted ? voiceSession : voiceSessions.get(storage.getState().settings.voice.providerId as RealtimeProviderId) ?? null;
}

export function getCurrentRealtimeControlSessionId(): string | null {
    return currentControlSessionId;
}

export function setCurrentRealtimeControlSessionId(sessionId: string | null): void {
    currentControlSessionId = sessionId;
}

export function getCurrentRealtimeProviderId(): RealtimeVoiceProviderId {
    return currentAdapterId;
}
