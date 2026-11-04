import { apiError, ApiError, readText, requireSameOrigin } from "@/lib/integrations/http";
import { AUTHORIZE_PATH, authorizationRedirect, issueAuthorizationCode, parseAuthorizationRequest } from "@/lib/integrations/oauth";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

const seeOther = (location: string) => new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });

/** The consent form on /oauth/authorize posts here. Nothing is granted without the signed-in user's click. */
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
    if (params.decision !== "allow") return seeOther(authorizationRedirect(value.redirectUri, { error: "access_denied", state: value.state }, request));
    const context = await getCurrentWorkspaceContext();
    if (!context) {
      const query = new URLSearchParams([...form].filter(([key]) => key !== "decision" && key !== "workspace_id"));
      return seeOther(`/login?callbackUrl=${encodeURIComponent(`${AUTHORIZE_PATH}?${query}`)}`);
    }
    if (params.workspace_id !== context.workspaceId) throw new ApiError("Your workspace changed. Start the connection again from your app.", 409);
    const code = await issueAuthorizationCode(value, context.userId, context.workspaceId);
    return seeOther(authorizationRedirect(value.redirectUri, { code, state: value.state }, request));
  } catch (error) { return apiError(error); }
}
