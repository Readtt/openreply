import { apiError, ApiError, readText, requireSameOrigin } from "@/lib/integrations/http";
import { AUTHORIZE_PATH, authorizationRedirect, issueAuthorizationCode, parseAuthorizationRequest } from "@/lib/integrations/oauth";
import { scopesForRole } from "@/lib/integrations/scopes";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

const seeOther = (location: string) => new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });

/**
 * The consent form on /oauth/authorize posts here. Nothing is granted without the
 * signed-in user's click, and only the permissions they ticked that their role allows.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    if (!request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")) throw new ApiError("Form submission required", 415);
    const form = new URLSearchParams(await readText(request, 16 * 1024));
    const params: Record<string, string | string[]> = {};
    for (const key of new Set(form.keys())) {
      const values = form.getAll(key);
      params[key] = values.length === 1 ? values[0] : values;
    }
    const parsed = await parseAuthorizationRequest(params, request);
    if (!parsed.ok) throw new ApiError(parsed.detail ?? "Invalid authorization request", 400);
    const { value } = parsed;
    const deny = () => seeOther(authorizationRedirect(value.redirectUri, { error: "access_denied", state: value.state }, request));
    if (params.decision !== "allow") return deny();
    const context = await getCurrentWorkspaceContext();
    if (!context) {
      const query = new URLSearchParams([...form].filter(([key]) => !["decision", "workspace_id", "grant"].includes(key)));
      return seeOther(`/login?callbackUrl=${encodeURIComponent(`${AUTHORIZE_PATH}?${query}`)}`);
    }
    if (params.workspace_id !== context.workspaceId) throw new ApiError("Your workspace changed. Start the connection again from your app.", 409);
    const granted = scopesForRole(context.role).filter(scope => form.getAll("grant").includes(scope));
    // Allowing nothing is the same as cancelling.
    if (!granted.length) return deny();
    const code = await issueAuthorizationCode(value, context.userId, context.workspaceId, granted);
    return seeOther(authorizationRedirect(value.redirectUri, { code, state: value.state }, request));
  } catch (error) { return apiError(error); }
}
