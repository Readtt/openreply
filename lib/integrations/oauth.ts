import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { authenticateService, consumeRateLimit, type ServiceContext } from "./auth";
import { ApiError } from "./http";
import { SERVICE_SCOPES } from "./scopes";

/**
 * OAuth 2.1 authorization for the MCP endpoint (MCP authorization spec), so a
 * client can connect with nothing but the server URL: it discovers this server
 * through the 401 challenge, registers itself (RFC 7591), sends the user here to
 * sign in and approve, then exchanges the code with PKCE (RFC 7636).
 *
 * Grants are read-only and bound to one user in one workspace. A token stops
 * working as soon as that user leaves the workspace or revokes the connection.
 */

export const MCP_PATH = "/api/mcp";
export const AUTHORIZE_PATH = "/oauth/authorize";
const CODE_TTL_MS = 5 * 60_000;
const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_MS = 30 * 86_400_000;
// A rotated-out refresh token presented again means a copy leaked, so the grant is
// revoked. Within this window it is more likely the same client refreshing twice.
const REFRESH_REUSE_GRACE_MS = 60_000;
const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
const GRANT_TYPES = ["authorization_code", "refresh_token"];
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const UNSAFE_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "ws:", "wss:", "ftp:"]);
const ACCESS_TOKEN = /^Bearer (ora_[A-Za-z0-9_-]{43})$/;
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};
const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const newSecret = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export class OAuthError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

export function oauthErrorResponse(error: unknown) {
  const headers = { ...NO_STORE, ...CORS_HEADERS };
  if (error instanceof OAuthError) {
    return Response.json({ error: error.code, error_description: error.message }, { status: error.status, headers });
  }
  if (error instanceof ApiError) {
    const code = error.status === 429 || error.status === 503 ? "temporarily_unavailable" : "invalid_request";
    return Response.json({ error: code, error_description: error.message }, { status: error.status, headers });
  }
  return Response.json({ error: "server_error" }, { status: 500, headers });
}

/** NEXTAUTH_URL is the public origin; it wins so a proxy's Host header cannot change the issuer. */
export function publicOrigin(request?: Request) {
  if (process.env.NEXTAUTH_URL) return new URL(process.env.NEXTAUTH_URL).origin;
  return request ? new URL(request.url).origin : "http://localhost:3000";
}
export const mcpResource = (request?: Request) => `${publicOrigin(request)}${MCP_PATH}`;
const resourceMetadataUrl = (request: Request) => `${publicOrigin(request)}/.well-known/oauth-protected-resource${MCP_PATH}`;

/** RFC 9728 Protected Resource Metadata for /api/mcp. */
export function protectedResourceMetadata(request: Request) {
  return {
    resource: mcpResource(request),
    authorization_servers: [publicOrigin(request)],
    scopes_supported: [...SERVICE_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "OpenReply",
  };
}

/** RFC 8414 Authorization Server Metadata. */
export function authorizationServerMetadata(request: Request) {
  const issuer = publicOrigin(request);
  return {
    issuer,
    authorization_endpoint: `${issuer}${AUTHORIZE_PATH}`,
    token_endpoint: `${issuer}/api/oauth/token`,
    registration_endpoint: `${issuer}/api/oauth/register`,
    scopes_supported: [...SERVICE_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: GRANT_TYPES,
    token_endpoint_auth_methods_supported: [...AUTH_METHODS],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  };
}

/** Adds the 401 challenge that lets an MCP client discover how to sign in. */
export function withMcpChallenge(request: Request, response: Response) {
  if (response.status !== 401) return response;
  const params = [`resource_metadata="${resourceMetadataUrl(request)}"`, `scope="${SERVICE_SCOPES.join(" ")}"`];
  if (request.headers.has("authorization")) params.unshift('error="invalid_token"');
  response.headers.set("WWW-Authenticate", `Bearer ${params.join(", ")}`);
  return response;
}

/** HTTPS, loopback HTTP (RFC 8252 §7.3) or a native app's private-use scheme; never a fragment. */
export function isValidRedirectUri(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (value.includes("#") || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !UNSAFE_SCHEMES.has(url.protocol);
}

/** Exact match, except that a loopback redirect may use any port (RFC 8252 §7.3). */
export function matchesRedirectUri(registered: string[], requested: string) {
  if (registered.includes(requested)) return true;
  let url: URL;
  try { url = new URL(requested); } catch { return false; }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) return false;
  return registered.some(value => {
    try { const candidate = new URL(value); candidate.port = url.port; return candidate.href === url.href; }
    catch { return false; }
  });
}

function normalizeResource(value: string) {
  try { const url = new URL(value); url.hash = ""; return url.href.replace(/\/$/, ""); }
  catch { return ""; }
}

const registrationSchema = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().max(500).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

/** RFC 7591 dynamic client registration. Unknown metadata (including scope) is ignored. */
export async function registerClient(input: unknown) {
  const parsed = registrationSchema.safeParse(input);
  if (!parsed.success) throw new OAuthError("invalid_client_metadata", "redirect_uris must list 1 to 10 URIs");
  const { client_name, grant_types = GRANT_TYPES, response_types = ["code"] } = parsed.data;
  // RFC 7591 §2: an omitted method means client_secret_basic.
  const authMethod = parsed.data.token_endpoint_auth_method ?? "client_secret_basic";
  if (!(AUTH_METHODS as readonly string[]).includes(authMethod)) {
    throw new OAuthError("invalid_client_metadata", `token_endpoint_auth_method must be one of: ${AUTH_METHODS.join(", ")}`);
  }
  const redirectUris = [...new Set(parsed.data.redirect_uris)];
  if (!redirectUris.every(isValidRedirectUri)) {
    throw new OAuthError("invalid_redirect_uri", "Redirect URIs must use HTTPS, loopback HTTP or a private app scheme, without a fragment");
  }
  if (!grant_types.includes("authorization_code") || grant_types.some(type => !GRANT_TYPES.includes(type))) {
    throw new OAuthError("invalid_client_metadata", "Only the authorization_code and refresh_token grants are supported");
  }
  if (response_types.some(type => type !== "code")) throw new OAuthError("invalid_client_metadata", "Only response_type code is supported");
  const clientId = `mcp_${randomBytes(16).toString("base64url")}`;
  const clientSecret = authMethod === "none" ? undefined : newSecret("ors");
  const name = client_name?.trim().slice(0, 100) || "MCP client";
  await prisma.oAuthClient.create({
    data: { id: clientId, name, redirectUris, authMethod, secretHash: clientSecret ? sha256(clientSecret) : null },
  });
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: redirectUris,
    grant_types: [...new Set(grant_types)],
    response_types: ["code"],
    token_endpoint_auth_method: authMethod,
    scope: SERVICE_SCOPES.join(" "),
    ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
  };
}

export type AuthorizationRequest = {
  clientId: string; clientName: string; redirectUri: string; codeChallenge: string;
  state?: string; scopes: string[]; resource: string;
};
export type AuthorizationFailure = "missing_client" | "unknown_client" | "redirect_mismatch" | "invalid_request";
export type ParsedAuthorization =
  | { ok: true; value: AuthorizationRequest }
  | { ok: false; failure: AuthorizationFailure; detail?: string };

/** Adds the response parameters, plus the issuer (RFC 9207), to the client's redirect URI. */
export function authorizationRedirect(redirectUri: string, values: Record<string, string | undefined>, request?: Request) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries({ ...values, iss: publicOrigin(request) })) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Validates an authorization request. Every failure is shown to the user rather than
 * redirected: anyone can register a client with any redirect URI, so redirecting errors
 * would make this endpoint an open redirector (RFC 9700 §4.11.1). The only redirects are
 * the user's own Allow or Cancel on the consent screen, which names the destination.
 * Unknown scopes are ignored; the grant is always the read-only scope (RFC 6749 §3.3).
 */
export async function parseAuthorizationRequest(params: Record<string, string | string[] | undefined>, request?: Request): Promise<ParsedAuthorization> {
  const single = (name: string) => { const value = params[name]; return Array.isArray(value) ? null : value || undefined; };
  const clientId = single("client_id");
  if (!clientId || clientId.length > 100) return { ok: false, failure: "missing_client" };
  const client = await prisma.oAuthClient.findUnique({ where: { id: clientId }, select: { name: true, redirectUris: true } });
  if (!client) return { ok: false, failure: "unknown_client" };
  const requested = single("redirect_uri");
  const redirectUri = requested ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (requested === null || !redirectUri || !matchesRedirectUri(client.redirectUris, redirectUri)) return { ok: false, failure: "redirect_mismatch" };
  const fail = (detail: string) => ({ ok: false as const, failure: "invalid_request" as const, detail });
  if (single("response_type") !== "code") return fail("Only response_type=code is supported.");
  const codeChallenge = single("code_challenge");
  if (single("code_challenge_method") !== "S256" || !codeChallenge || !CODE_CHALLENGE.test(codeChallenge)) {
    return fail("PKCE with code_challenge_method=S256 is required.");
  }
  const state = single("state");
  if (state === null || (state && state.length > 2048)) return fail("The state parameter is invalid.");
  const resource = single("resource");
  if (resource === null || (resource && normalizeResource(resource) !== mcpResource(request))) {
    return fail(`This server only issues tokens for ${mcpResource(request)}.`);
  }
  return { ok: true, value: {
    clientId, clientName: client.name, redirectUri, codeChallenge, state,
    scopes: [...SERVICE_SCOPES], resource: mcpResource(request),
  } };
}

/** Records the user's consent and returns the single-use authorization code. */
export async function issueAuthorizationCode(value: AuthorizationRequest, userId: string, workspaceId: string) {
  const code = newSecret("orc");
  await prisma.oAuthGrant.create({ data: {
    clientId: value.clientId, userId, workspaceId, scopes: value.scopes, resource: value.resource,
    redirectUri: value.redirectUri, codeHash: sha256(code), codeChallenge: value.codeChallenge,
    codeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
  } });
  return code;
}

const isMember = async (userId: string, workspaceId: string) =>
  Boolean(await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, select: { id: true } }));

const revokeGrant = (id: string) => prisma.oAuthGrant.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });

function newTokens() {
  const accessToken = newSecret("ora");
  const refreshToken = newSecret("orr");
  return {
    data: {
      accessTokenHash: sha256(accessToken), accessExpiresAt: new Date(Date.now() + ACCESS_TTL_SECONDS * 1000),
      refreshTokenHash: sha256(refreshToken), refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
    response: (scopes: string[]) => ({
      access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refreshToken, scope: scopes.join(" "),
    }),
  };
}

/** client_secret_basic or client_secret_post for confidential clients; client_id alone for public ones. */
async function authenticateClient(request: Request, body: URLSearchParams) {
  let clientId = body.get("client_id") ?? undefined;
  let clientSecret = body.get("client_secret") ?? undefined;
  const basic = request.headers.get("authorization")?.match(/^Basic ([A-Za-z0-9+/=]+)$/i)?.[1];
  if (basic) {
    const decoded = Buffer.from(basic, "base64").toString("utf8");
    const split = decoded.indexOf(":");
    try {
      if (split < 0) throw new Error("no separator");
      clientId = decodeURIComponent(decoded.slice(0, split));
      clientSecret = decodeURIComponent(decoded.slice(split + 1));
    } catch { throw new OAuthError("invalid_client", "Malformed Basic client credentials", 401); }
  }
  if (!clientId || clientId.length > 100) throw new OAuthError("invalid_client", "client_id is required", 401);
  const client = await prisma.oAuthClient.findUnique({ where: { id: clientId }, select: { id: true, secretHash: true } });
  if (!client) throw new OAuthError("invalid_client", "Unknown client", 401);
  if (client.secretHash && !(clientSecret && sameHash(sha256(clientSecret), client.secretHash))) {
    throw new OAuthError("invalid_client", "Client authentication failed", 401);
  }
  return client.id;
}

async function exchangeAuthorizationCode(clientId: string, body: URLSearchParams) {
  const code = body.get("code");
  const verifier = body.get("code_verifier");
  if (!code || !verifier) throw new OAuthError("invalid_request", "code and code_verifier are required");
  const grant = await prisma.oAuthGrant.findUnique({ where: { codeHash: sha256(code) } });
  if (!grant || grant.clientId !== clientId || grant.revokedAt) throw new OAuthError("invalid_grant", "Invalid authorization code");
  if (grant.codeUsedAt) {
    // RFC 6749 §4.1.2: a replayed code revokes everything issued from it.
    await revokeGrant(grant.id);
    throw new OAuthError("invalid_grant", "Authorization code was already used");
  }
  if (grant.codeExpiresAt <= new Date()) throw new OAuthError("invalid_grant", "Authorization code expired");
  const redirectUri = body.get("redirect_uri");
  if (redirectUri !== null && redirectUri !== grant.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request");
  if (!CODE_VERIFIER.test(verifier) || pkceChallenge(verifier) !== grant.codeChallenge) throw new OAuthError("invalid_grant", "PKCE verification failed");
  const resource = body.get("resource");
  if (resource && normalizeResource(resource) !== grant.resource) throw new OAuthError("invalid_target", "Unknown resource");
  if (!(await isMember(grant.userId, grant.workspaceId))) throw new OAuthError("invalid_grant", "Access to this workspace was removed");
  const tokens = newTokens();
  const updated = await prisma.oAuthGrant.updateMany({
    where: { id: grant.id, codeUsedAt: null, revokedAt: null },
    data: { codeUsedAt: new Date(), ...tokens.data },
  });
  if (updated.count !== 1) throw new OAuthError("invalid_grant", "Authorization code was already used");
  return tokens.response(grant.scopes);
}

async function rotateRefreshToken(clientId: string, body: URLSearchParams) {
  const refreshToken = body.get("refresh_token");
  if (!refreshToken) throw new OAuthError("invalid_request", "refresh_token is required");
  const hash = sha256(refreshToken);
  const grant = await prisma.oAuthGrant.findUnique({ where: { refreshTokenHash: hash } });
  if (!grant) {
    const reused = await prisma.oAuthGrant.findUnique({ where: { previousRefreshHash: hash } });
    const recentRotation = reused?.refreshRotatedAt && Date.now() - reused.refreshRotatedAt.getTime() < REFRESH_REUSE_GRACE_MS;
    if (reused && reused.clientId === clientId && !recentRotation) await revokeGrant(reused.id);
    throw new OAuthError("invalid_grant", "Invalid refresh token");
  }
  if (grant.clientId !== clientId || grant.revokedAt || !grant.refreshExpiresAt || grant.refreshExpiresAt <= new Date()) {
    throw new OAuthError("invalid_grant", "Invalid refresh token");
  }
  if (!(await isMember(grant.userId, grant.workspaceId))) {
    await revokeGrant(grant.id);
    throw new OAuthError("invalid_grant", "Access to this workspace was removed");
  }
  const tokens = newTokens();
  const updated = await prisma.oAuthGrant.updateMany({
    where: { id: grant.id, refreshTokenHash: hash, revokedAt: null },
    data: { ...tokens.data, previousRefreshHash: hash, refreshRotatedAt: new Date() },
  });
  if (updated.count !== 1) throw new OAuthError("invalid_grant", "Invalid refresh token");
  return tokens.response(grant.scopes);
}

/** Token endpoint body: form encoded per RFC 6749, with JSON accepted for lenient clients. */
export function tokenRequestBody(contentType: string, text: string) {
  if (contentType.includes("application/x-www-form-urlencoded")) return new URLSearchParams(text);
  if (contentType.includes("application/json")) {
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new OAuthError("invalid_request", "Invalid JSON body"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new OAuthError("invalid_request", "Invalid body");
    return new URLSearchParams(Object.entries(value).filter(([, v]) => typeof v === "string") as [string, string][]);
  }
  throw new OAuthError("invalid_request", "Use application/x-www-form-urlencoded");
}

export async function exchangeToken(request: Request, body: URLSearchParams) {
  const clientId = await authenticateClient(request, body);
  const grantType = body.get("grant_type");
  if (grantType === "authorization_code") return exchangeAuthorizationCode(clientId, body);
  if (grantType === "refresh_token") return rotateRefreshToken(clientId, body);
  throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

/** MCP requests accept a workspace service key or an OAuth access token issued for /api/mcp. */
export async function authenticateMcp(request: Request): Promise<ServiceContext> {
  const header = request.headers.get("authorization");
  if (!header) throw new ApiError("Bearer token required", 401);
  const token = header.match(ACCESS_TOKEN)?.[1];
  if (!token) return authenticateService(request);
  const grant = await prisma.oAuthGrant.findUnique({
    where: { accessTokenHash: sha256(token) },
    select: { id: true, userId: true, workspaceId: true, scopes: true, resource: true, revokedAt: true, accessExpiresAt: true },
  });
  if (!grant || grant.revokedAt || !grant.accessExpiresAt || grant.accessExpiresAt <= new Date()
    || grant.resource !== mcpResource(request) || !(await isMember(grant.userId, grant.workspaceId))) {
    throw new ApiError("Invalid or expired access token", 401);
  }
  await consumeRateLimit(`integration-rate:${grant.id}`, 120, 60);
  await prisma.oAuthGrant.update({ where: { id: grant.id }, data: { lastUsedAt: new Date() } });
  // keyId identifies the credential: a service key id, or here the OAuth grant id.
  return { workspaceId: grant.workspaceId, keyId: grant.id, scopes: grant.scopes };
}
