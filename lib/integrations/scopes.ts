/** Client-safe constants; do not import the database into client components. */
export const SERVICE_SCOPES = ["campaigns:read"] as const;

/**
 * What an app connected with an OpenReply sign-in may do. The user picks these on the
 * consent screen, and an app never gets more than the user's own role allows: like the
 * dashboard, changing campaigns needs an owner or admin.
 */
export const OAUTH_SCOPES = [
  "campaigns:read",
  "campaigns:write",
  "campaigns:activate",
  "instagram:read",
  "inbox:read",
  "inbox:send",
  "workspace:read",
] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/** Pre-selected on the consent screen and advertised in the 401 challenge. */
export const DEFAULT_OAUTH_SCOPES: OAuthScope[] = ["campaigns:read", "instagram:read"];

const MANAGER_SCOPES: OAuthScope[] = ["campaigns:write", "campaigns:activate"];

export function scopesForRole(role: "OWNER" | "ADMIN" | "MEMBER"): OAuthScope[] {
  return role === "MEMBER" ? OAUTH_SCOPES.filter(scope => !MANAGER_SCOPES.includes(scope)) : [...OAUTH_SCOPES];
}

export const isOAuthScope = (value: string): value is OAuthScope => (OAUTH_SCOPES as readonly string[]).includes(value);
