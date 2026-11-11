import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createEnvReset } from "../../testkit/env";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import { readFileSync } from "node:fs";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

const dbMocks = createDbMocks({
    voiceSessionLease: ["findFirst"],
    voiceConversation: ["findUnique", "upsert"],
} as const);

const leaseFindFirst = dbMocks.db.voiceSessionLease.findFirst;
const conversationUpsert = dbMocks.db.voiceConversation.upsert;
const conversationFindUnique = dbMocks.db.voiceConversation.findUnique;

installDbModuleMock(() => ({
    db: dbMocks.db,
}));

describe("voiceRoutes (session complete)", () => {
    const resetVoiceEnv = createEnvReset();
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        dbMocks.reset();
        resetVoiceEnv({
            HAPPIER_FEATURE_VOICE__ENABLED: "1",
            ELEVENLABS_API_KEY: "el_key",
            ELEVENLABS_AGENT_ID: "agent_dev",
        });
        leaseFindFirst.mockResolvedValue({
            id: "lease_1",
            accountId: "u1",
            providerAgentId: "agent_dev",
            providerId: "elevenlabs",
            createdAt: new Date("2026-02-01T00:00:00.000Z"),
            expiresAt: new Date("2026-02-01T01:00:00.000Z"),
        });
        conversationUpsert.mockResolvedValue({ id: "vc_1" });
        conversationFindUnique.mockResolvedValue(null);
        globalThis.fetch = vi.fn() as any;
    });

    afterEach(() => {
        resetVoiceEnv();
        globalThis.fetch = originalFetch;
    });

    // Real `GET /v1/projects/:id/requests/:request_id` body captured live on 2026-11-10.
    const capturedUsage = JSON.parse(readFileSync(new URL("../../../../../../../packages/tests/fixtures/voice/deepgram-usage-2026-11-10.json", import.meta.url), "utf8")).usage;
    const capturedLeaseId = capturedUsage.response.details.tags[0];
    const deepgramLease = { id: capturedLeaseId, accountId: "u1", providerId: "deepgram", providerAgentId: "", createdAt: new Date("2026-11-10T22:21:00Z"), expiresAt: new Date("2026-11-10T22:41:00Z") };
    const usageResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

    async function completeDeepgram(leaseId: string) {
        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({ method: "POST", path: "/v1/voice/session/complete", registerRoutes(app) { voiceRoutes(app as any); } });
        return route.invoke({ userId: "u1", body: { leaseId, providerConversationId: capturedUsage.request_id } });
    }

    it.each([true, false])("verifies Deepgram usage and lease tag before releasing the slot (tag matches: %s)", async (matches) => {
        resetVoiceEnv({ HAPPIER_FEATURE_VOICE__ENABLED: "1", DEEPGRAM_API_KEY: "dg_key", DEEPGRAM_PROJECT_ID: "project_1", HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: "false" });
        leaseFindFirst.mockResolvedValue({ ...deepgramLease, id: matches ? capturedLeaseId : "another_lease" });
        vi.mocked(globalThis.fetch).mockResolvedValueOnce(usageResponse(capturedUsage));
        const { response, reply } = await completeDeepgram(matches ? capturedLeaseId : "another_lease");
        if (matches) {
            expect(response).toEqual({ ok: true, durationSeconds: 13 });
            expect(conversationUpsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ leaseId: capturedLeaseId, providerId: "deepgram", durationSeconds: 13 }) }));
        } else {
            expect(reply.code).toHaveBeenCalledWith(404);
            expect(conversationUpsert).not.toHaveBeenCalled();
        }
        expect(globalThis.fetch).toHaveBeenCalledWith(`https://api.deepgram.com/v1/projects/project_1/requests/${capturedUsage.request_id}`, expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Token dg_key" }) }));
    });

    it("waits for Deepgram to finalize a just-closed request instead of leaving the slot reserved", async () => {
        resetVoiceEnv({ HAPPIER_FEATURE_VOICE__ENABLED: "1", DEEPGRAM_API_KEY: "dg_key", DEEPGRAM_PROJECT_ID: "project_1", HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: "false" });
        leaseFindFirst.mockResolvedValue(deepgramLease);
        // Observed live 2026-11-10: queried at socket close, the record exists (200) with
        // `completed` and `sts_details.duration` still null; both are filled ~2s later.
        // Earlier still (probes 2026-11-11) the request is not recorded yet (200 with a `null` body),
        // or recorded with `response: null`.
        const inProgress = { ...capturedUsage, response: { ...capturedUsage.response, completed: null, sts_details: { ...capturedUsage.response.sts_details, duration: null } } };
        vi.mocked(globalThis.fetch)
            .mockResolvedValueOnce(usageResponse(null))
            .mockResolvedValueOnce(usageResponse({ ...capturedUsage, response: null }))
            .mockResolvedValueOnce(usageResponse(inProgress))
            .mockResolvedValueOnce(usageResponse(capturedUsage));
        const { response } = await completeDeepgram(capturedLeaseId);
        expect(response).toEqual({ ok: true, durationSeconds: 13 });
        expect(globalThis.fetch).toHaveBeenCalledTimes(4);
    });

    it("fetches conversation details and stores duration for a valid lease", async () => {
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                conversation_id: "conv_123",
                agent_id: "agent_dev",
                metadata: {
                    start_time_unix_secs: 1769904632,
                    call_duration_secs: 42,
                },
            }),
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/session/complete",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });
        const { response: res, reply } = await route.invoke({
            userId: "u1",
            body: { leaseId: "lease_1", providerConversationId: "conv_123" },
        });

        expect(reply.code).not.toHaveBeenCalled();
        expect(res).toEqual(expect.objectContaining({ ok: true, durationSeconds: 42 }));
        expect(globalThis.fetch).toHaveBeenCalledWith(
            "https://api.elevenlabs.io/v1/convai/conversations/conv_123",
            expect.objectContaining({
                method: "GET",
                headers: expect.objectContaining({ "xi-api-key": "el_key" }),
            }),
        );
        expect(conversationUpsert).toHaveBeenCalledTimes(1);
    });

    it("returns 404 when Happier Voice is disabled", async () => {
        resetVoiceEnv({ HAPPIER_FEATURE_VOICE__ENABLED: "0" });

        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/session/complete",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });
        const { response: res, reply } = await route.invoke({
            userId: "u1",
            body: { leaseId: "lease_1", providerConversationId: "conv_123" },
        });

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(res).toEqual({ ok: false, reason: "not_found" });
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("returns 503 when persisting the conversation fails", async () => {
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                conversation_id: "conv_123",
                agent_id: "agent_dev",
                metadata: {
                    start_time_unix_secs: 1769904632,
                    call_duration_secs: 42,
                },
            }),
        });
        conversationUpsert.mockRejectedValueOnce(new Error("db-down"));

        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/session/complete",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });
        const { response: res, reply } = await route.invoke({
            userId: "u1",
            body: { leaseId: "lease_1", providerConversationId: "conv_123" },
        });

        expect(reply.code).toHaveBeenCalledWith(503);
        expect(res).toEqual({ ok: false, reason: "upstream_error" });
    });
});
