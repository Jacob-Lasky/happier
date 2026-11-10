import { z } from "zod";
import { log } from "@/utils/logging/log";
import { db } from "@/storage/db";
import { resolveElevenLabsApiBaseUrl } from "@/voice/elevenLabsEnv";
import { resolveServerFeaturesForGating } from "@/app/features/catalog/serverFeatureGate";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { type Fastify } from "../../types";

function extractConversationAgentId(payload: any): string | null {
    const direct =
        (typeof payload?.agent_id === "string" && payload.agent_id.trim()) ||
        (typeof payload?.agentId === "string" && payload.agentId.trim()) ||
        (typeof payload?.agent?.id === "string" && payload.agent.id.trim()) ||
        (typeof payload?.metadata?.agent_id === "string" && payload.metadata.agent_id.trim()) ||
        (typeof payload?.metadata?.agentId === "string" && payload.metadata.agentId.trim()) ||
        "";
    return direct || null;
}

function extractConversationStartUnixSecs(payload: any): number | null {
    const raw = Number(payload?.metadata?.start_time_unix_secs);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return Math.floor(raw);
}

export function registerVoiceSessionCompleteRoute(app: Fastify): void {
    app.post('/v1/voice/session/complete', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "voice.sessionComplete"),
        },
        schema: {
            body: z.object({
                leaseId: z.string(),
                providerConversationId: z.string(),
            }),
            response: {
                200: z.object({
                    ok: z.literal(true),
                    durationSeconds: z.number().int().min(0),
                }),
                404: z.object({
                    ok: z.literal(false),
                    reason: z.literal("not_found"),
                }),
                503: z.object({
                    ok: z.literal(false),
                    reason: z.literal("upstream_error"),
                }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { leaseId, providerConversationId } = request.body as { leaseId: string; providerConversationId: string };

        const lease = await db.voiceSessionLease.findFirst({
            where: { id: leaseId, accountId: userId },
            select: { id: true, accountId: true, providerId: true, providerAgentId: true, createdAt: true, expiresAt: true },
        });
        if (!lease) {
            // Fail closed without leaking whether the lease exists for other users.
            return reply.code(404).send({ ok: false, reason: "not_found" as const });
        }

        const providerId = lease.providerId;
        const serverFeatures = resolveServerFeaturesForGating(process.env);
        const enabled = providerId === "deepgram"
            ? serverFeatures.features.voice.deepgram.enabled
            : serverFeatures.features.voice.happierVoice.enabled;
        if (!enabled) return reply.code(404).send({ ok: false, reason: "not_found" as const });
        const conversationProviderId = providerId === "deepgram" ? "deepgram" : "elevenlabs_agents";
        let durationSeconds: number;
        let startedAt: Date;
        let endedAt: Date;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);
        try {
            let duration: number;
            if (providerId === "deepgram") {
                const headers = { Authorization: `Token ${process.env.DEEPGRAM_API_KEY?.trim() ?? ""}` };
                let projectId = process.env.DEEPGRAM_PROJECT_ID?.trim();
                if (!projectId) {
                    const projectsResponse = await fetch("https://api.deepgram.com/v1/projects", { headers, signal: controller.signal });
                    if (!projectsResponse.ok) throw new Error("deepgram_projects_unavailable");
                    const projects = z.object({ projects: z.array(z.object({ project_id: z.string() })) }).parse(await projectsResponse.json()).projects;
                    // A member key can see multiple projects; never guess which account should be charged.
                    if (projects.length !== 1) throw new Error("deepgram_project_configuration_required");
                    projectId = projects[0].project_id;
                }
                const response = await fetch(`https://api.deepgram.com/v1/projects/${encodeURIComponent(projectId)}/requests/${encodeURIComponent(providerConversationId)}`, { headers, signal: controller.signal });
                if (!response.ok) throw new Error("deepgram_usage_unavailable");
                const usage = z.object({
                    request_id: z.string(), path: z.string(), created: z.string().datetime({ offset: true }),
                    response: z.object({ completed: z.string().datetime({ offset: true }), details: z.object({ tags: z.array(z.string()) }), sts_details: z.object({ duration: z.number().finite().nonnegative() }) }),
                }).parse(await response.json());
                if (usage.request_id !== providerConversationId || usage.path.split("?")[0] !== "/v1/agent/converse" || !usage.response.details.tags.includes(lease.id)) {
                    return reply.code(404).send({ ok: false, reason: "not_found" as const });
                }
                duration = usage.response.sts_details.duration;
                startedAt = new Date(usage.created);
            } else {
                const response = await fetch(`${resolveElevenLabsApiBaseUrl(process.env)}/v1/convai/conversations/${encodeURIComponent(providerConversationId)}`, {
                    method: "GET", headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY?.trim() ?? "", Accept: "application/json" }, signal: controller.signal,
                });
                if (!response.ok) throw new Error("elevenlabs_usage_unavailable");
                const json: unknown = await response.json();
                const usage = z.object({ metadata: z.object({ call_duration_secs: z.coerce.number().finite().nonnegative() }) }).parse(json);
                const startUnix = extractConversationStartUnixSecs(json);
                if (extractConversationAgentId(json) !== lease.providerAgentId || startUnix === null) {
                    return reply.code(404).send({ ok: false, reason: "not_found" as const });
                }
                duration = usage.metadata.call_duration_secs;
                startedAt = new Date(startUnix * 1000);
            }
            if (startedAt.getTime() < lease.createdAt.getTime() - 5 * 60 * 1000 || startedAt.getTime() > lease.expiresAt.getTime() + 5 * 60 * 1000) {
                return reply.code(404).send({ ok: false, reason: "not_found" as const });
            }
            durationSeconds = Math.floor(duration);
            endedAt = new Date(startedAt.getTime() + durationSeconds * 1000);
        } catch {
            log({ module: "voice" }, `Failed to verify ${providerId} voice usage`);
            return reply.code(503).send({ ok: false, reason: "upstream_error" as const });
        } finally {
            clearTimeout(timeoutId);
        }

        try {
            const existingForConversation = await db.voiceConversation.findUnique({
                where: {
                    providerId_providerConversationId: {
                        providerId: conversationProviderId,
                        providerConversationId,
                    },
                },
                select: { accountId: true, leaseId: true },
            });
            if (
                existingForConversation &&
                (existingForConversation.accountId !== lease.accountId ||
                    (existingForConversation.leaseId && existingForConversation.leaseId !== lease.id))
            ) {
                return reply.code(404).send({ ok: false, reason: "not_found" as const });
            }

            const existingForLease = await db.voiceConversation.findUnique({
                where: { leaseId: lease.id },
                select: { providerConversationId: true },
            });
            if (existingForLease && existingForLease.providerConversationId !== providerConversationId) {
                return reply.code(404).send({ ok: false, reason: "not_found" as const });
            }

            await db.voiceConversation.upsert({
                where: {
                    providerId_providerConversationId: {
                        providerId: conversationProviderId,
                        providerConversationId,
                    },
                },
                create: {
                    accountId: lease.accountId,
                    leaseId: lease.id,
                    providerId: conversationProviderId,
                    providerConversationId,
                    startedAt,
                    endedAt,
                    durationSeconds,
                    billedUnits: null,
                },
                update: {
                    leaseId: lease.id,
                    startedAt,
                    endedAt,
                    durationSeconds,
                },
            });
        } catch (e) {
            log({ module: "voice" }, "Failed to persist voice conversation", {
                providerConversationId,
                leaseId: lease.id,
                err: e,
            });
            return reply.code(503).send({ ok: false, reason: "upstream_error" as const });
        }

        return reply.send({ ok: true, durationSeconds });
    });
}
