import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";

const state = vi.hoisted(() => ({ db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient }));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
vi.mock("ioredis", () => ({ default: class { status = "ready"; eval = async () => 1; listenerCount() { return 1; } } }));
// Tools act through the real dashboard routes; only the cookie session is out of the picture.
vi.mock("next-auth", () => ({ default: () => ({ handlers: {}, auth: async () => null, signIn: async () => undefined, signOut: async () => undefined }) }));
import { authenticateMcp, exchangeToken, issueAuthorizationCode, parseAuthorizationRequest, registerClient } from "../lib/integrations/oauth";
import { callTool } from "../lib/integrations/mcp";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `mcp_oauth_${randomBytes(4).toString("hex")}`;
const migration = "20261104055312_mcp_oauth";
const base = "https://example.test";
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const redirectUri = "http://127.0.0.1:43210/callback";
let sql: Client;

const mcpRequest = (accessToken: string) => new Request(`${base}/api/mcp`, { method: "POST", headers: { authorization: `Bearer ${accessToken}` } });
const tokenRequest = (values: Record<string, string>) => exchangeToken(new Request(`${base}/api/oauth/token`, { method: "POST" }), new URLSearchParams(values));

describe.skipIf(!databaseUrl)("MCP OAuth on real PostgreSQL", () => {
  beforeAll(async () => {
    vi.stubEnv("NEXTAUTH_URL", base);
    vi.stubEnv("NEXTAUTH_SECRET", "db-test-secret-for-refresh-token-macs");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    sql = new Client({ connectionString: databaseUrl });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);
    const root = path.join(__dirname, "..", "prisma", "migrations");
    const dirs = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
    for (const dir of dirs.filter(name => name !== migration)) await sql.query(readFileSync(path.join(root, dir, "migration.sql"), "utf8"));
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }) });
    await state.db.user.create({ data: { id: "user", email: "oauth@example.test" } });
    for (const id of ["workspace", "other"]) {
      await state.db.workspace.create({ data: { id, name: id, ownerId: "user" } });
      await state.db.instagramAccount.create({ data: { id: `account_${id}`, workspaceId: id, instagramId: id, username: id, accessToken: "local-only-secret" } });
      await state.db.automation.create({ data: { id: `campaign_${id}`, workspaceId: id, instagramAccountId: `account_${id}`, name: id, keywords: ["LINK"], dmMessage: "Hi", isActive: false } });
    }
    await state.db.workspaceMember.create({ data: { workspaceId: "workspace", userId: "user", role: "MEMBER" } });
    const before = await state.db.automation.findMany({ orderBy: { id: "asc" } });
    await sql.query(readFileSync(path.join(root, migration, "migration.sql"), "utf8"));
    expect(await state.db.automation.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  }, 60_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await state.db?.$disconnect();
    if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); }
  });

  it("runs register, consent, code exchange, MCP calls, rotation and revocation against the real schema", async () => {
    const client = await registerClient({ redirect_uris: ["http://127.0.0.1:3333/callback"], token_endpoint_auth_method: "none", client_name: "DB client" });
    const parsed = await parseAuthorizationRequest({ client_id: client.client_id, redirect_uri: redirectUri, response_type: "code",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", resource: `${base}/api/mcp` });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const code = await issueAuthorizationCode(parsed.value, "user", "workspace", ["campaigns:read"]);
    const issued = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, client_id: client.client_id });

    const row = await state.db.oAuthGrant.findFirstOrThrow({ where: { clientId: client.client_id } });
    const stored = JSON.stringify(row);
    for (const secret of [code, issued.access_token, issued.refresh_token]) expect(stored).not.toContain(secret);
    expect(row).toMatchObject({ userId: "user", workspaceId: "workspace", scopes: ["campaigns:read"], redirectUri, resource: `${base}/api/mcp` });

    const context = await authenticateMcp(mcpRequest(issued.access_token));
    expect(context).toEqual({ workspaceId: "workspace", keyId: row.id, userId: "user", scopes: ["campaigns:read"] });
    const campaigns = await callTool(context, "list_campaigns", {}) as { id: string }[];
    expect(campaigns.map(campaign => campaign.id)).toEqual(["campaign_workspace"]);
    await expect(callTool(context, "get_campaign", { id: "campaign_other" })).rejects.toMatchObject({ status: 404 });
    expect((await state.db.oAuthGrant.findUniqueOrThrow({ where: { id: row.id } })).lastUsedAt).toBeInstanceOf(Date);

    const rotated = await tokenRequest({ grant_type: "refresh_token", refresh_token: issued.refresh_token, client_id: client.client_id });
    await expect(authenticateMcp(mcpRequest(issued.access_token))).rejects.toMatchObject({ status: 401 });
    expect(await authenticateMcp(mcpRequest(rotated.access_token))).toMatchObject({ workspaceId: "workspace" });
    const latest = await tokenRequest({ grant_type: "refresh_token", refresh_token: rotated.refresh_token, client_id: client.client_id });
    expect(await authenticateMcp(mcpRequest(latest.access_token))).toMatchObject({ workspaceId: "workspace" });

    // The first refresh token, two rotations later and past the grace window, revokes the grant.
    await state.db.oAuthGrant.update({ where: { id: row.id }, data: { refreshRotatedAt: new Date(Date.now() - 120_000) } });
    await expect(tokenRequest({ grant_type: "refresh_token", refresh_token: issued.refresh_token, client_id: client.client_id }))
      .rejects.toMatchObject({ code: "invalid_grant" });
    expect((await state.db.oAuthGrant.findUniqueOrThrow({ where: { id: row.id } })).revokedAt).toBeInstanceOf(Date);
    await expect(authenticateMcp(mcpRequest(latest.access_token))).rejects.toMatchObject({ status: 401 });
    await expect(tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id }))
      .rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("runs dashboard actions through the real routes as the signed-in user", async () => {
    await state.db.user.createMany({ data: [{ id: "admin", email: "admin@example.test" }, { id: "viewer", email: "viewer@example.test" }] });
    await state.db.workspace.create({ data: { id: "acme", name: "Acme", ownerId: "admin" } });
    await state.db.workspaceMember.createMany({ data: [{ workspaceId: "acme", userId: "admin", role: "OWNER" }, { workspaceId: "acme", userId: "viewer", role: "MEMBER" }] });
    await state.db.instagramAccount.create({ data: { id: "account_acme", workspaceId: "acme", instagramId: "acme", username: "acme_shop", accessToken: "local-only-secret" } });
    const as = (userId: string, scopes: string[]) => ({ workspaceId: "acme", keyId: "grant", userId, scopes });
    const admin = as("admin", ["campaigns:read", "campaigns:write", "campaigns:activate", "instagram:read", "workspace:read"]);
    const row = (id: string) => state.db.automation.findUnique({ where: { id } });

    const created = await callTool(admin, "create_campaign", { name: "Spring guide", dmMessage: "Here is the guide", matchAnyPost: true,
      keywords: ["GUIDE"], trackedDestinationUrl: "https://example.test/guide" }) as { id: string };
    expect(await row(created.id)).toMatchObject({ workspaceId: "acme", instagramAccountId: "account_acme", isActive: false, keywords: ["GUIDE"] });
    await expect(callTool(admin, "create_campaign", { name: "No trigger", dmMessage: "x", keywords: ["A"] })).rejects.toThrow(/Choose which post/);

    await callTool(admin, "update_campaign", { campaign_id: created.id, name: "Spring guide v2" });
    await callTool(admin, "activate_campaign", { campaign_id: created.id });
    expect(await row(created.id)).toMatchObject({ name: "Spring guide v2", isActive: true });
    await expect(callTool(as("admin", ["campaigns:write"]), "update_campaign", { campaign_id: created.id, name: "Sneaky" })).rejects.toMatchObject({ status: 403 });
    await expect(callTool(admin, "delete_campaign", { campaign_id: created.id })).rejects.toMatchObject({ status: 409 });
    expect((await row(created.id))?.name).toBe("Spring guide v2");

    const copy = await callTool(admin, "duplicate_campaign", { campaign_id: created.id }) as { id: string; isActive: boolean };
    expect(copy.isActive).toBe(false);
    await state.db.dmLog.create({ data: { workspaceId: "acme", automationId: created.id, instagramAccountId: "account_acme", commenterId: "ig-commenter",
      commenterName: "ana", commentText: "GUIDE please", commentId: "ig-comment", matchedKeyword: "GUIDE", status: "SENT", dmSentAt: new Date() } });
    const results = await callTool(admin, "get_campaign_results", { campaign_id: created.id }) as { campaigns: { results: { sent: number }; links: unknown[] }[] };
    expect(results.campaigns[0]).toMatchObject({ name: "Spring guide v2", account: "acme_shop", results: { sent: 1 } });
    expect(results.campaigns[0].links).toHaveLength(1);
    const logs = await callTool(admin, "list_dm_logs", {});
    expect(logs).toMatchObject({ logs: [{ commenter: "ana", campaign: "Spring guide v2", status: "SENT" }], pagination: { total: 1 } });
    expect(JSON.stringify(logs)).not.toContain("ig-commenter");
    expect(await callTool(admin, "get_dashboard_stats", {})).toMatchObject({ campaigns: { total: 2, active: 1 }, dms: { total: 1 } });
    expect(await callTool(admin, "list_instagram_accounts", {})).toEqual({ accounts: [{ id: "account_acme", username: "acme_shop", name: null }] });
    expect(await callTool(admin, "get_workspace_members", {})).toMatchObject({ yourRole: "OWNER", members: [{ email: "admin@example.test" }, { email: "viewer@example.test" }] });

    // The dashboard's own role check still applies through delegation, and other workspaces stay out of reach.
    await expect(callTool(as("viewer", ["campaigns:write"]), "pause_campaign", { campaign_id: created.id })).rejects.toMatchObject({ status: 403 });
    await expect(callTool(admin, "update_campaign", { campaign_id: "campaign_workspace", name: "Hijack" })).rejects.toMatchObject({ status: 404 });
    expect((await row("campaign_workspace"))?.name).toBe("workspace");

    await callTool(admin, "pause_campaign", { campaign_id: created.id });
    await callTool(admin, "delete_campaign", { campaign_id: created.id });
    expect(await row(created.id)).toBeNull();
    expect(await row(copy.id)).toMatchObject({ isActive: false });
  });

  it("cuts access when membership ends and deletes grants with their user", async () => {
    const client = await registerClient({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" });
    const parsed = await parseAuthorizationRequest({ client_id: client.client_id, response_type: "code",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256" });
    if (!parsed.ok) throw new Error("rejected");
    const code = await issueAuthorizationCode(parsed.value, "user", "workspace", ["campaigns:read"]);
    const issued = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id });
    await state.db.workspaceMember.deleteMany({ where: { userId: "user" } });
    await expect(authenticateMcp(mcpRequest(issued.access_token))).rejects.toMatchObject({ status: 401 });
    await state.db.user.delete({ where: { id: "user" } });
    expect(await state.db.oAuthGrant.count()).toBe(0);
    expect(await state.db.oAuthClient.count()).toBe(2);
  });
});
