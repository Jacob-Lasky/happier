import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createEnvReset } from "../../testkit/env";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

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

    it.each([true, false])("verifies Deepgram usage and lease tag before releasing the slot (tag matches: %s)", async (matches) => {
        resetVoiceEnv({ DEEPGRAM_API_KEY: "dg_key", DEEPGRAM_PROJECT_ID: "project_1", VOICE_REQUIRE_SUBSCRIPTION: "0" });
        leaseFindFirst.mockResolvedValue({ id: "lease_1", accountId: "u1", providerId: "deepgram", providerAgentId: "", createdAt: new Date("2026-02-01T00:00:00Z"), expiresAt: new Date("2026-02-01T01:00:00Z") });
        vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(JSON.stringify({
            request_id: "request_1", path: "/v1/agent/converse?", created: "2026-02-01T00:00:32Z",
            response: { completed: "2026-02-01T00:01:14Z", details: { tags: [matches ? "lease_1" : "another_lease"] }, sts_details: { duration: 42.5 } },
        }), { status: 200 }));
        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({ method: "POST", path: "/v1/voice/session/complete", registerRoutes(app) { voiceRoutes(app as any); } });
        const { response, reply } = await route.invoke({ userId: "u1", body: { leaseId: "lease_1", providerConversationId: "request_1" } });
        if (matches) {
            expect(response).toEqual({ ok: true, durationSeconds: 42 });
            expect(conversationUpsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ leaseId: "lease_1", providerId: "deepgram", durationSeconds: 42 }) }));
        } else {
            expect(reply.code).toHaveBeenCalledWith(404);
            expect(conversationUpsert).not.toHaveBeenCalled();
        }
        expect(globalThis.fetch).toHaveBeenCalledWith("https://api.deepgram.com/v1/projects/project_1/requests/request_1", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Token dg_key" }) }));
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
