import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => {
  const clients = new Map<string, Row>();
  const grants = new Map<string, Row>();
  const members = new Set<string>();
  const matches = (row: Row, where: Row) => Object.entries(where).every(([key, value]) =>
    value === null ? row[key] == null : value && typeof value === "object" && "not" in value ? row[key] != null : row[key] === value);
  const prisma = {
    oAuthClient: {
      create: vi.fn(async ({ data }: { data: Row }) => { clients.set(data.id as string, { secretHash: null, ...data }); return data; }),
      findUnique: vi.fn(async ({ where }: { where: Row }) => clients.get(where.id as string) ?? null),
    },
    oAuthGrant: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `grant_${grants.size + 1}`, codeUsedAt: null, accessTokenHash: null, accessExpiresAt: null, refreshTokenHash: null,
          refreshExpiresAt: null, previousRefreshHash: null, refreshRotatedAt: null, revokedAt: null, lastUsedAt: null, ...data };
        grants.set(row.id, row); return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: Row }) => [...grants.values()].find(row => matches(row, where)) ?? null),
      update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => Object.assign(grants.get(where.id as string)!, data)),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const rows = [...grants.values()].filter(row => matches(row, where));
        rows.forEach(row => Object.assign(row, data));
        return { count: rows.length };
      }),
      findMany: vi.fn<(args: { where: Row }) => Promise<Row[]>>(async () => []),
    },
    workspaceMember: {
      findUnique: vi.fn(async ({ where }: { where: { workspaceId_userId: { workspaceId: string; userId: string } } }) =>
        members.has(`${where.workspaceId_userId.workspaceId}:${where.workspaceId_userId.userId}`) ? { id: "member" } : null),
    },
    serviceKey: { findUnique: vi.fn(async () => null), update: vi.fn() },
  };
  return { clients, grants, members, prisma, eval: vi.fn(), context: vi.fn() };
});
vi.mock("@/lib/db/client", () => ({ prisma: state.prisma }));
vi.mock("ioredis", () => ({ default: class { status = "ready"; eval = state.eval; listenerCount() { return 1; } } }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: state.context,
  canManageWorkspace: (role: string) => ["OWNER", "ADMIN"].includes(role),
}));

import {
  authenticateMcp, authorizationServerMetadata, exchangeToken, isValidRedirectUri, issueAuthorizationCode,
  matchesRedirectUri, parseAuthorizationRequest, pkceChallenge, protectedResourceMetadata, registerClient,
} from "../lib/integrations/oauth";
import { POST as mcp } from "../app/api/mcp/route";
import { GET as resourceMetadata } from "../app/.well-known/oauth-protected-resource/[[...path]]/route";
import { POST as token } from "../app/api/oauth/token/route";
import { POST as register } from "../app/api/oauth/register/route";
import { POST as consent } from "../app/api/oauth/authorize/route";
import { GET as listApps, DELETE as disconnectApp } from "../app/api/integrations/oauth/route";

const base = "https://example.test";
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const redirectUri = "https://client.example/callback";
const form = (values: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(`${base}/api/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(values) });
const mcpRequest = (authorization?: string) => new Request(`${base}/api/mcp`, {
  method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(authorization ? { authorization } : {}) },
});

async function publicClient() {
  return (await registerClient({ redirect_uris: [redirectUri], client_name: "Test client", token_endpoint_auth_method: "none" })).client_id;
}
async function authorize(clientId: string, extra: Record<string, string> = {}) {
  const parsed = await parseAuthorizationRequest({ client_id: clientId, redirect_uri: redirectUri, response_type: "code",
    code_challenge: challenge, code_challenge_method: "S256", state: "xyz", ...extra });
  if (!parsed.ok) throw new Error("authorization request rejected");
  return issueAuthorizationCode(parsed.value, "user", "workspace");
}
async function tokens(clientId: string) {
  const code = await authorize(clientId);
  return exchangeToken(form({}), new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXTAUTH_URL", base);
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  state.clients.clear(); state.grants.clear(); state.members.clear();
  state.members.add("workspace:user");
  state.eval.mockReset().mockResolvedValue(1);
  state.context.mockResolvedValue({ userId: "user", workspaceId: "workspace", role: "MEMBER" });
});

describe("discovery", () => {
  it("publishes resource and authorization server metadata from NEXTAUTH_URL", async () => {
    const request = new Request("http://internal:3000/x");
    expect(protectedResourceMetadata(request)).toMatchObject({ resource: `${base}/api/mcp`, authorization_servers: [base], scopes_supported: ["campaigns:read"] });
    expect(authorizationServerMetadata(request)).toMatchObject({
      issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/api/oauth/token`,
      registration_endpoint: `${base}/api/oauth/register`, code_challenge_methods_supported: ["S256"],
    });
    const ok = await resourceMetadata(request, { params: Promise.resolve({ path: ["api", "mcp"] }) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    expect((await resourceMetadata(request, { params: Promise.resolve({ path: ["other"] }) })).status).toBe(404);
  });
  it("answers an unauthenticated MCP request with the OAuth challenge", async () => {
    const response = await mcp(mcpRequest());
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/api/mcp", scope="campaigns:read"`);
    const invalid = await mcp(mcpRequest(`Bearer ora_${"x".repeat(43)}`));
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toMatch(/^Bearer error="invalid_token", resource_metadata=/);
  });
});

describe("redirect URIs and PKCE", () => {
  it.each([
    ["https://claude.ai/api/mcp/auth_callback", true], ["http://localhost:6274/oauth/callback", true], ["http://127.0.0.1:33418/", true],
    ["http://[::1]:8080/cb", true], ["cursor://anysphere.cursor-retrieval/oauth/callback", true], ["http://evil.example/cb", false],
    ["https://client.example/cb#fragment", false], ["javascript:alert(1)", false], ["data:text/html,hi", false], ["not a url", false],
    ["https://user:pass@client.example/cb", false],
  ])("validates %s", (uri, valid) => expect(isValidRedirectUri(uri)).toBe(valid));
  it("lets loopback redirects change port and nothing else", () => {
    expect(matchesRedirectUri(["http://localhost:3333/callback"], "http://localhost:51234/callback")).toBe(true);
    expect(matchesRedirectUri(["http://localhost:3333/callback"], "http://localhost:51234/other")).toBe(false);
    expect(matchesRedirectUri(["https://client.example/callback"], "https://client.example:8443/callback")).toBe(false);
  });
  it("derives S256 challenges like RFC 7636 appendix B", () => expect(pkceChallenge(verifier)).toBe(challenge));
});

describe("dynamic client registration", () => {
  it("registers public clients without a secret and ignores unknown scopes", async () => {
    const client = await registerClient({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none", scope: "claudeai", client_name: "  Claude  " });
    expect(client).toMatchObject({ token_endpoint_auth_method: "none", client_name: "Claude", grant_types: ["authorization_code", "refresh_token"] });
    expect(client).not.toHaveProperty("client_secret");
  });
  it("issues a hashed secret to confidential clients, the RFC 7591 default", async () => {
    const client = await registerClient({ redirect_uris: [redirectUri] });
    expect(client.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(client.client_secret).toMatch(/^ors_/);
    expect(state.clients.get(client.client_id)!.secretHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("rejects unsafe metadata with RFC 7591 errors", async () => {
    const post = (body: unknown) => register(new Request(`${base}/api/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect(await (await post({ redirect_uris: ["http://evil.example/cb"] })).json()).toMatchObject({ error: "invalid_redirect_uri" });
    expect(await (await post({ redirect_uris: [redirectUri], grant_types: ["client_credentials"] })).json()).toMatchObject({ error: "invalid_client_metadata" });
    expect(await (await post({ redirect_uris: [redirectUri], token_endpoint_auth_method: "private_key_jwt" })).json()).toMatchObject({ error: "invalid_client_metadata" });
    expect((await post({})).status).toBe(400);
    const created = await post({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
  });
  it("is rate limited per address and fails closed", async () => {
    const post = () => register(new Request(`${base}/api/oauth/register`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify({ redirect_uris: [redirectUri] }) }));
    state.eval.mockResolvedValueOnce(21);
    expect((await post()).status).toBe(429);
    expect(state.eval.mock.calls[0].slice(2)).toEqual(["oauth-register:203.0.113.9", 3600]);
    state.eval.mockRejectedValueOnce(new Error("down"));
    expect((await post()).status).toBe(503);
  });
});

describe("authorization requests", () => {
  it("never redirects to an unverified client or redirect URI", async () => {
    expect(await parseAuthorizationRequest({ client_id: "missing" })).toEqual({ ok: false, failure: "unknown_client" });
    const clientId = await publicClient();
    expect(await parseAuthorizationRequest({ client_id: clientId, redirect_uri: "https://evil.example/cb" })).toEqual({ ok: false, failure: "redirect_mismatch" });
    expect(await parseAuthorizationRequest({ client_id: [clientId, clientId] })).toEqual({ ok: false, failure: "missing_client" });
  });
  it("shows protocol errors instead of redirecting, so it is not an open redirector", async () => {
    // Registration is open, so a redirect on error would bounce victims to any registered URL.
    const attacker = (await registerClient({ redirect_uris: ["https://evil.example/landing"], token_endpoint_auth_method: "none" })).client_id;
    const cases = [
      { response_type: "token", code_challenge: challenge, code_challenge_method: "S256" },
      { response_type: "code", state: "s1" },
      { response_type: "code", code_challenge: challenge, code_challenge_method: "plain" },
      { response_type: "code", code_challenge: challenge, code_challenge_method: "S256", resource: "https://other.example/mcp" },
      { response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: ["a", "b"] },
    ];
    for (const extra of cases) {
      const parsed = await parseAuthorizationRequest({ client_id: attacker, ...extra });
      expect(parsed).toMatchObject({ ok: false, failure: "invalid_request" });
      expect(JSON.stringify(parsed)).not.toContain("evil.example");
    }
    const target = await parseAuthorizationRequest({ client_id: attacker, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", resource: "https://other.example/mcp" });
    expect(target).toMatchObject({ detail: `This server only issues tokens for ${base}/api/mcp.` });
  });
  it("grants only the read scope, whatever was requested", async () => {
    const clientId = await publicClient();
    const parsed = await parseAuthorizationRequest({ client_id: clientId, response_type: "code", code_challenge: challenge,
      code_challenge_method: "S256", scope: "campaigns:write claudeai", resource: `${base}/api/mcp/` });
    expect(parsed).toMatchObject({ ok: true, value: { redirectUri, scopes: ["campaigns:read"], resource: `${base}/api/mcp` } });
  });
});

describe("token endpoint", () => {
  it("exchanges a code once, with PKCE, for tokens that authenticate MCP requests", async () => {
    const clientId = await publicClient();
    const code = await authorize(clientId);
    const exchange = (values: Record<string, string>) => token(form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri, ...values }));
    const wrong = await exchange({ code_verifier: "a".repeat(43) });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_grant" });
    const ok = await exchange({ code_verifier: verifier });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const body = await ok.json();
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "campaigns:read" });
    expect(body.access_token).toMatch(/^ora_[A-Za-z0-9_-]{43}$/);
    expect(await authenticateMcp(mcpRequest(`Bearer ${body.access_token}`))).toEqual({ workspaceId: "workspace", keyId: "grant_1", scopes: ["campaigns:read"] });
    const listed = await (await mcp(mcpRequest(`Bearer ${body.access_token}`))).json();
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["list_campaigns", "get_campaign", "get_campaign_stats"]);
    // Replaying the code revokes everything issued from it.
    expect(await (await exchange({ code_verifier: verifier })).json()).toMatchObject({ error: "invalid_grant" });
    await expect(authenticateMcp(mcpRequest(`Bearer ${body.access_token}`))).rejects.toMatchObject({ status: 401 });
  });
  it("rejects expired codes, a different redirect URI and a different client", async () => {
    const clientId = await publicClient();
    const other = await publicClient();
    const code = await authorize(clientId);
    const exchange = (values: Record<string, string>) => exchangeToken(form({}), new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, ...values }));
    await expect(exchange({ client_id: other })).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(exchange({ redirect_uri: "https://client.example/other" })).rejects.toMatchObject({ code: "invalid_grant" });
    state.grants.get("grant_1")!.codeExpiresAt = new Date(0);
    await expect(exchange({})).rejects.toMatchObject({ code: "invalid_grant" });
  });
  it("rotates refresh tokens and revokes the grant when a rotated one is replayed", async () => {
    const clientId = await publicClient();
    const first = await tokens(clientId);
    const refresh = (refreshToken: string) => exchangeToken(form({}), new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }));
    const second = await refresh(first.refresh_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    await expect(authenticateMcp(mcpRequest(`Bearer ${first.access_token}`))).rejects.toMatchObject({ status: 401 });
    expect(await authenticateMcp(mcpRequest(`Bearer ${second.access_token}`))).toMatchObject({ workspaceId: "workspace" });
    // A concurrent duplicate refresh moments after rotation fails without revoking.
    await expect(refresh(first.refresh_token)).rejects.toMatchObject({ code: "invalid_grant" });
    expect(state.grants.get("grant_1")!.revokedAt).toBeNull();
    // Later, the same replay means the token leaked: revoke the whole grant.
    state.grants.get("grant_1")!.refreshRotatedAt = new Date(Date.now() - 120_000);
    await expect(refresh(first.refresh_token)).rejects.toMatchObject({ code: "invalid_grant" });
    expect(state.grants.get("grant_1")!.revokedAt).toBeInstanceOf(Date);
    await expect(refresh(second.refresh_token)).rejects.toMatchObject({ code: "invalid_grant" });
  });
  it("stops working as soon as the user leaves the workspace", async () => {
    const clientId = await publicClient();
    const issued = await tokens(clientId);
    state.members.clear();
    await expect(authenticateMcp(mcpRequest(`Bearer ${issued.access_token}`))).rejects.toMatchObject({ status: 401 });
    await expect(exchangeToken(form({}), new URLSearchParams({ grant_type: "refresh_token", refresh_token: issued.refresh_token, client_id: clientId })))
      .rejects.toMatchObject({ code: "invalid_grant" });
  });
  it("authenticates confidential clients with Basic or body credentials", async () => {
    const client = await registerClient({ redirect_uris: [redirectUri], token_endpoint_auth_method: "client_secret_post" });
    const code = await authorize(client.client_id);
    const values = { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri };
    const missing = await token(form({ ...values, client_id: client.client_id }));
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: "invalid_client" });
    const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64");
    expect((await token(form(values, { authorization: `Basic ${basic}` }))).status).toBe(200);
    const secondCode = await authorize(client.client_id);
    expect((await token(form({ ...values, code: secondCode, client_id: client.client_id, client_secret: client.client_secret! }))).status).toBe(200);
  });
  it("answers malformed requests with RFC 6749 errors", async () => {
    expect(await (await token(form({ grant_type: "password", client_id: await publicClient() }))).json()).toMatchObject({ error: "unsupported_grant_type" });
    expect(await (await token(form({ grant_type: "authorization_code" }))).json()).toMatchObject({ error: "invalid_client" });
    const text = await token(new Request(`${base}/api/oauth/token`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" }));
    expect(await text.json()).toMatchObject({ error: "invalid_request" });
  });
});

describe("consent and connected apps", () => {
  const consentForm = (values: Record<string, string>, origin = base) => new Request(`${base}/api/oauth/authorize`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin }, body: new URLSearchParams(values),
  });
  async function consentValues(decision: string) {
    return { client_id: await publicClient(), redirect_uri: redirectUri, response_type: "code", code_challenge: challenge,
      code_challenge_method: "S256", state: "abc", workspace_id: "workspace", decision };
  }
  it("issues a code only for a same-origin approval by the signed-in user", async () => {
    expect((await consent(consentForm(await consentValues("allow"), "https://evil.example"))).status).toBe(403);
    expect((await consent(new Request(`${base}/api/oauth/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" }))).status).toBe(403);
    expect(state.grants.size).toBe(0);
    const approved = await consent(consentForm(await consentValues("allow")));
    expect(approved.status).toBe(303);
    const location = new URL(approved.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(redirectUri);
    expect(location.searchParams.get("code")).toMatch(/^orc_/);
    expect(location.searchParams.get("state")).toBe("abc");
    expect(location.searchParams.get("iss")).toBe(base);
    expect(state.grants.get("grant_1")).toMatchObject({ userId: "user", workspaceId: "workspace", scopes: ["campaigns:read"] });
  });
  it("returns access_denied, sends signed-out users to login, and refuses a changed workspace", async () => {
    const denied = await consent(consentForm(await consentValues("deny")));
    expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
    state.context.mockResolvedValueOnce(null);
    const login = await consent(consentForm(await consentValues("allow")));
    expect(login.headers.get("location")).toMatch(/^\/login\?callbackUrl=%2Foauth%2Fauthorize%3F/);
    state.context.mockResolvedValueOnce({ userId: "user", workspaceId: "other", role: "OWNER" });
    expect((await consent(consentForm(await consentValues("allow")))).status).toBe(409);
    expect(state.grants.size).toBe(0);
  });
  it("scopes connected apps to the member, or the whole workspace for admins", async () => {
    await listApps();
    expect(state.prisma.oAuthGrant.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: "workspace", userId: "user", revokedAt: null });
    state.context.mockResolvedValue({ userId: "user", workspaceId: "workspace", role: "ADMIN" });
    await listApps();
    expect(state.prisma.oAuthGrant.findMany.mock.calls[1][0].where).not.toHaveProperty("userId");
    state.context.mockResolvedValue({ userId: "user", workspaceId: "workspace", role: "MEMBER" });
    expect((await disconnectApp(new Request(`${base}/api/integrations/oauth?id=foreign`, { method: "DELETE" }))).status).toBe(404);
    expect(state.prisma.oAuthGrant.updateMany.mock.calls[0][0].where).toEqual({ id: "foreign", workspaceId: "workspace", userId: "user", revokedAt: null });
    state.context.mockResolvedValue(null);
    expect((await listApps()).status).toBe(401);
  });
});
