import { z } from "zod";

const DEEPGRAM_API_BASE_URL = "https://api.deepgram.com";

/**
 * Lifetime of a browser grant. DO NOT derive it from the lease duration: the grant only
 * authenticates the WebSocket handshake, a connected session outlives it, and one grant can open
 * several sessions (both measured live 2026-11-10). Deepgram's own default keeps that reuse window
 * to the mint-then-connect step.
 */
export const DEEPGRAM_GRANT_TTL_SECONDS = 30;

/**
 * Right after the socket closes Deepgram answers 200 with, in turn, a `null` body (not recorded
 * yet), a record whose `response` is null, a record whose `completed` and duration are null, and
 * then the finalized record, within ~0.3-3s (measured 2026-11-10/11). Anything short of a
 * `completed` timestamp is therefore "not yet", never a verification failure.
 */
const USAGE_FINALIZATION_POLL_MS = 500;

export function resolveDeepgramApiKey(env: NodeJS.ProcessEnv): string {
    return env.DEEPGRAM_API_KEY?.trim() ?? "";
}

export function deepgramApiUrl(path: string): string {
    return `${DEEPGRAM_API_BASE_URL}${path}`;
}

const pendingUsageSchema = z.object({
    response: z.object({ completed: z.string().nullish() }).nullish(),
}).nullable();

const finalizedUsageSchema = z.object({
    request_id: z.string(),
    path: z.string(),
    created: z.string().datetime({ offset: true }),
    response: z.object({
        completed: z.string().datetime({ offset: true }),
        details: z.object({ tags: z.array(z.string()) }),
        sts_details: z.object({ duration: z.number().finite().nonnegative() }),
    }),
});

export type DeepgramRequestUsage = z.infer<typeof finalizedUsageSchema>;

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

async function resolveProjectId(env: NodeJS.ProcessEnv, headers: Record<string, string>, signal: AbortSignal): Promise<string> {
    const configured = env.DEEPGRAM_PROJECT_ID?.trim();
    if (configured) return configured;
    const response = await fetch(deepgramApiUrl("/v1/projects"), { headers, signal });
    if (!response.ok) throw new Error("deepgram_projects_unavailable");
    const projects = z.object({ projects: z.array(z.object({ project_id: z.string() })) }).parse(await response.json()).projects;
    // A member key can see multiple projects; never guess which account should be charged.
    if (projects.length !== 1) throw new Error("deepgram_project_configuration_required");
    return projects[0].project_id;
}

/**
 * Reads a Voice Agent request's usage once Deepgram has finalized it. Polling stays inside the
 * caller's abort budget rather than adding a second deadline.
 */
export async function fetchFinalizedDeepgramUsage(
    env: NodeJS.ProcessEnv,
    requestId: string,
    signal: AbortSignal,
): Promise<DeepgramRequestUsage> {
    const headers = { Authorization: `Token ${resolveDeepgramApiKey(env)}` };
    const projectId = await resolveProjectId(env, headers, signal);
    const url = deepgramApiUrl(`/v1/projects/${encodeURIComponent(projectId)}/requests/${encodeURIComponent(requestId)}`);
    for (;;) {
        const response = await fetch(url, { headers, signal });
        if (!response.ok) throw new Error("deepgram_usage_unavailable");
        const body: unknown = await response.json();
        if (pendingUsageSchema.parse(body)?.response?.completed) return finalizedUsageSchema.parse(body);
        await waitFor(USAGE_FINALIZATION_POLL_MS, signal);
    }
}
