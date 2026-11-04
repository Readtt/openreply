import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const ok = (data: unknown, status = 200) => Response.json({ success: true, data }, { status });
  return {
    ok,
    prisma: {
      automation: { findFirst: vi.fn() },
      workspaceMember: { findUnique: vi.fn() },
    },
    routes: {
      automations: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
      duplicate: { POST: vi.fn() },
      logs: { GET: vi.fn() },
      members: { GET: vi.fn() },
      diagnostics: { GET: vi.fn() },
    },
  };
});
vi.mock("@/lib/db/client", () => ({ prisma: state.prisma }));
vi.mock("next-auth", () => ({ default: () => ({ handlers: {}, auth: async () => ({ user: { id: "cookie-user" } }), signIn: vi.fn(), signOut: vi.fn() }) }));
vi.mock("next-auth/providers/nodemailer", () => ({ default: () => ({}) }));
vi.mock("next-auth/providers/resend", () => ({ default: () => ({}) }));
vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }));
vi.mock("@/app/api/automations/route", () => state.routes.automations);
vi.mock("@/app/api/automations/duplicate/route", () => state.routes.duplicate);
vi.mock("@/app/api/logs/route", () => state.routes.logs);
vi.mock("@/app/api/workspace/members/route", () => state.routes.members);
vi.mock("@/app/api/admin/diagnostics/route", () => state.routes.diagnostics);

import { getCurrentUserId, getCurrentWorkspaceId } from "../lib/auth";
import { runAsWorkspaceUser } from "../lib/delegated-user";
import { callDashboard } from "../lib/integrations/dashboard";
import { callTool, listTools } from "../lib/integrations/mcp";
import { OAUTH_SCOPES } from "../lib/integrations/scopes";
import { getCurrentWorkspaceContext } from "../lib/workspace-access";

const serviceKey = { workspaceId: "workspace", keyId: "key", scopes: ["campaigns:read"] };
const user = (scopes: string[] = [...OAUTH_SCOPES]) => ({ workspaceId: "workspace", keyId: "grant", userId: "user", scopes });
const campaign = { id: "c1", name: "Guide", isActive: false, instagramAccountId: "ig", postId: null, postUrl: null, pendingNextReel: false,
  matchAnyPost: true, keywords: ["GUIDE"], matchAnyWord: false, dmMessage: "Here you go" };

beforeEach(() => {
  vi.clearAllMocks();
  state.prisma.automation.findFirst.mockResolvedValue({ isActive: false });
  for (const handler of [state.routes.automations.POST, state.routes.automations.PATCH, state.routes.duplicate.POST]) {
    handler.mockImplementation(async () => state.ok(campaign));
  }
  state.routes.automations.DELETE.mockImplementation(async () => state.ok({ deleted: true }));
});

describe("tool catalogue", () => {
  it("lists only what the credential and its permissions allow", () => {
    expect(listTools(serviceKey).map(tool => tool.name)).toEqual(["list_campaigns", "get_campaign", "get_campaign_stats"]);
    expect(listTools(user(["inbox:read"])).map(tool => tool.name)).toEqual(["list_conversations", "get_conversation"]);
    expect(listTools(user()).map(tool => tool.name)).toEqual([
      "list_campaigns", "get_campaign", "get_campaign_stats", "get_campaign_results", "get_dashboard_stats", "list_dm_logs",
      "create_campaign", "update_campaign", "duplicate_campaign", "pause_campaign", "activate_campaign", "delete_campaign",
      "list_instagram_accounts", "get_instagram_profile", "get_instagram_overview", "list_instagram_posts",
      "list_conversations", "get_conversation", "send_message", "get_workspace_members", "get_diagnostics",
    ]);
    expect(listTools(user([]))).toEqual([]);
  });
  it("describes every tool with a title, an object input schema and honest annotations", () => {
    const tools = listTools(user());
    for (const tool of tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.inputSchema).toMatchObject({ type: "object" });
      expect(tool.inputSchema).not.toHaveProperty("$schema");
    }
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool.annotations]));
    for (const name of ["list_campaigns", "get_dashboard_stats", "list_dm_logs", "get_instagram_overview", "list_conversations", "get_diagnostics"]) {
      expect(byName[name].readOnlyHint, name).toBe(true);
    }
    for (const name of ["activate_campaign", "delete_campaign", "send_message", "update_campaign"]) {
      expect(byName[name]).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    expect(byName.create_campaign).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    const create = tools.find(tool => tool.name === "create_campaign")!.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(create.properties).not.toHaveProperty("isActive");
    expect(create.required).toEqual(expect.arrayContaining(["name", "dmMessage"]));
  });
  it("refuses unknown tools, missing permissions, service keys on user tools and bad arguments", async () => {
    await expect(callTool(user(), "drop_database", {})).rejects.toMatchObject({ status: 404 });
    await expect(callTool(user(["campaigns:read"]), "pause_campaign", { campaign_id: "c1" })).rejects.toMatchObject({ status: 403 });
    await expect(callTool({ ...serviceKey, scopes: [...OAUTH_SCOPES] }, "list_dm_logs", {})).rejects.toMatchObject({ status: 403 });
    await expect(callTool(user(), "pause_campaign", { campaign_id: "c1", extra: true })).rejects.toThrow(/Invalid arguments/);
    await expect(callTool(user(), "list_dm_logs", { limit: 500 })).rejects.toThrow(/limit/);
    expect(state.routes.automations.PATCH).not.toHaveBeenCalled();
    expect(state.routes.logs.GET).not.toHaveBeenCalled();
  });
});

describe("acting as the signed-in user", () => {
  it("pins the user and granted workspace only inside a delegated call", async () => {
    state.prisma.workspaceMember.findUnique.mockResolvedValue({ role: "ADMIN", workspace: { id: "granted", name: "Granted" } });
    const seen = await runAsWorkspaceUser({ userId: "user", workspaceId: "granted" }, async () => ({
      userId: await getCurrentUserId(), workspaceId: await getCurrentWorkspaceId(), context: await getCurrentWorkspaceContext(),
    }));
    expect(seen).toMatchObject({ userId: "user", workspaceId: "granted", context: { userId: "user", workspaceId: "granted", role: "ADMIN" } });
    expect(state.prisma.workspaceMember.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_userId: { workspaceId: "granted", userId: "user" } } }));
    expect(await getCurrentUserId()).toBe("cookie-user");
    state.prisma.workspaceMember.findUnique.mockResolvedValue(null);
    expect(await runAsWorkspaceUser({ userId: "user", workspaceId: "left" }, () => getCurrentWorkspaceContext())).toBeNull();
  });
  it("calls the dashboard route with the query and body and surfaces its validation errors", async () => {
    const handler = vi.fn(async (request: Request) => Response.json({ success: false, error: "Invalid input",
      details: { formErrors: [], fieldErrors: { dmMessage: ["Required"] } }, echo: new URL(request.url).search }, { status: 400 }));
    await expect(callDashboard(user(), handler, { method: "POST", query: { id: "c1", skip: undefined }, body: { a: 1 } }))
      .rejects.toMatchObject({ status: 400, message: "Invalid input. dmMessage: Required" });
    const request = handler.mock.calls[0][0];
    expect(request.method).toBe("POST");
    expect(new URL(request.url).search).toBe("?id=c1");
    expect(await request.json()).toEqual({ a: 1 });
    await expect(callDashboard(serviceKey, handler)).rejects.toMatchObject({ status: 403 });
  });
});

describe("campaign safety rules", () => {
  it("always creates campaigns paused", async () => {
    const created = await callTool(user(["campaigns:write"]), "create_campaign", { name: "Guide", dmMessage: "Here you go", matchAnyPost: true, keywords: ["GUIDE"] });
    expect(await state.routes.automations.POST.mock.calls[0][0].json()).toMatchObject({ name: "Guide", isActive: false });
    expect(created).toMatchObject({ id: "c1", isActive: false, trigger: "any_post" });
    await expect(callTool(user(), "create_campaign", { name: "Live", dmMessage: "x", matchAnyPost: true, isActive: true })).rejects.toThrow(/isActive/);
  });
  it("edits a live campaign only with permission to turn campaigns on", async () => {
    state.prisma.automation.findFirst.mockResolvedValue({ isActive: true });
    await expect(callTool(user(["campaigns:write"]), "update_campaign", { campaign_id: "c1", name: "New" })).rejects.toMatchObject({ status: 403 });
    expect(state.routes.automations.PATCH).not.toHaveBeenCalled();
    await callTool(user(["campaigns:write", "campaigns:activate"]), "update_campaign", { campaign_id: "c1", name: "New" });
    const request = state.routes.automations.PATCH.mock.calls[0][0];
    expect(new URL(request.url).searchParams.get("id")).toBe("c1");
    expect(await request.json()).toEqual({ name: "New" });
    await expect(callTool(user(), "update_campaign", { campaign_id: "c1" })).rejects.toThrow(/at least one field/);
    await expect(callTool(user(), "update_campaign", { campaign_id: "c1", reportShareEnabled: true })).rejects.toThrow(/Invalid arguments/);
  });
  it("needs its own permission to turn a campaign on, and deletes only paused campaigns", async () => {
    await expect(callTool(user(["campaigns:write"]), "activate_campaign", { campaign_id: "c1" })).rejects.toMatchObject({ status: 403 });
    await callTool(user(["campaigns:activate"]), "activate_campaign", { campaign_id: "c1" });
    expect(await state.routes.automations.PATCH.mock.calls[0][0].json()).toEqual({ isActive: true });
    await callTool(user(["campaigns:write"]), "pause_campaign", { campaign_id: "c1" });
    expect(await state.routes.automations.PATCH.mock.calls[1][0].json()).toEqual({ isActive: false });
    state.prisma.automation.findFirst.mockResolvedValueOnce({ isActive: true });
    await expect(callTool(user(), "delete_campaign", { campaign_id: "c1" })).rejects.toMatchObject({ status: 409 });
    expect(state.routes.automations.DELETE).not.toHaveBeenCalled();
    expect(await callTool(user(), "delete_campaign", { campaign_id: "c1" })).toEqual({ deleted: true, campaign_id: "c1" });
    state.prisma.automation.findFirst.mockResolvedValueOnce(null);
    await expect(callTool(user(), "delete_campaign", { campaign_id: "other-workspace" })).rejects.toMatchObject({ status: 404 });
    expect(state.prisma.automation.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: "other-workspace", workspaceId: "workspace" } }));
  });
});

describe("outputs", () => {
  it("leave out Instagram ids, invite links and raw payloads", async () => {
    state.routes.logs.GET.mockResolvedValue(state.ok({ logs: [{ id: "l1", createdAt: "2026-11-01", status: "SENT", commenterId: "ig-user-1", commentId: "ig-comment-1",
      commenterName: "ana", commentText: "GUIDE please", matchedKeyword: "GUIDE", errorMessage: null, dmSentAt: "2026-11-01", publicReplySentAt: null,
      publicReplyError: null, automation: { name: "Guide" }, instagramAccount: { username: "shop" } }], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } }));
    const logs = await callTool(user(), "list_dm_logs", { status: "SENT" });
    expect(JSON.stringify(logs)).not.toMatch(/ig-user-1|ig-comment-1/);
    expect(logs).toMatchObject({ logs: [{ commenter: "ana", campaign: "Guide", account: "shop", status: "SENT" }], pagination: { total: 1 } });
    expect(new URL(state.routes.logs.GET.mock.calls[0][0].url).searchParams.get("status")).toBe("SENT");

    state.routes.members.GET.mockResolvedValue(state.ok({ currentUserRole: "MEMBER", members: [{ role: "OWNER", createdAt: "2026-01-01", user: { email: "o@example.test", name: "O" } }],
      invitations: [{ email: "new@example.test", role: "ADMIN", token: "secret-token", inviteUrl: "https://example.test/invite/secret-token", expiresAt: "2026-12-01" }] }));
    const members = await callTool(user(), "get_workspace_members", {});
    expect(JSON.stringify(members)).not.toContain("secret-token");
    expect(members).toMatchObject({ yourRole: "MEMBER", pendingInvitations: [{ email: "new@example.test", role: "ADMIN" }] });

    state.routes.diagnostics.GET.mockResolvedValue(state.ok({ queueCounts: { failed: 1 },
      dmFailures: [{ id: "d", status: "FAILED", commentId: "ig-comment-2", commentText: "LINK", errorMessage: "window closed", automation: { name: "Guide" } }],
      tokenRefreshFailures: [{ id: "t", message: "expired", payload: { token: "raw" } }] }));
    const diagnostics = await callTool(user(), "get_diagnostics", {});
    expect(diagnostics).toEqual({ queueCounts: { failed: 1 },
      dmFailures: [{ id: "d", status: "FAILED", commentText: "LINK", errorMessage: "window closed", automation: { name: "Guide" } }],
      tokenRefreshFailures: [{ id: "t", message: "expired" }] });
  });
});
