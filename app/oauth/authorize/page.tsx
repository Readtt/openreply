import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import type { StaticMessageKey } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";
import { AUTHORIZE_PATH, parseAuthorizationRequest } from "@/lib/integrations/oauth";
import { DEFAULT_OAUTH_SCOPES, scopesForRole, type OAuthScope } from "@/lib/integrations/scopes";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

type SearchParams = Record<string, string | string[] | undefined>;

// Only the OAuth request travels through the consent form; nothing else is echoed back.
const FORWARDED = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope", "resource"];

const SCOPE_TEXT: Record<OAuthScope, [StaticMessageKey, StaticMessageKey]> = {
  "campaigns:read": ["View campaigns and results", "Settings, links, DMs sent, clicks, DM logs and the dashboard."],
  "campaigns:write": ["Create and edit campaigns", "Create, edit, duplicate, pause and delete paused campaigns. New campaigns start paused."],
  "campaigns:activate": ["Turn campaigns on", "Start campaigns and edit live ones. A live campaign sends DMs to people who comment."],
  "instagram:read": ["View Instagram accounts and posts", "Followers, posts, reels and videos with views, reach, likes, comments, saves and shares."],
  "inbox:read": ["Read your inbox", "Your Instagram DM conversations and messages."],
  "inbox:send": ["Send DMs", "Reply to people from your Instagram account. Messages can't be unsent."],
  "workspace:read": ["View workspace", "Members, roles, pending invitations and diagnostics."],
};

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  return { title: t("Connect an app - OpenReply"), robots: { index: false, follow: false } };
}

/** Where the user lands after deciding. App names are self-declared; this is not. */
function destination(redirectUri: string) {
  const url = new URL(redirectUri);
  return url.protocol === "https:" || url.protocol === "http:" ? url.host : `${url.protocol}//${url.host}`;
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const { t } = await getI18n();
  const parsed = await parseAuthorizationRequest(params);
  if (!parsed.ok) {
    const reason = {
      missing_client: t("The link is missing the app's client ID. Start the connection again from your app."),
      unknown_client: t("This app is not registered with OpenReply. Start the connection again from your app."),
      redirect_mismatch: t("The return address does not match the one this app registered."),
      invalid_request: t("The app sent an invalid connection request: {detail}", { detail: parsed.detail ?? "" }),
    }[parsed.failure];
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="panel w-full max-w-md rounded p-8 shadow-black/40">
          <h1 className="text-lg font-semibold text-foreground">{t("This connection link is not valid")}</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">{reason}</p>
        </div>
      </div>
    );
  }

  const forwarded = FORWARDED.flatMap(name => typeof params[name] === "string" ? [[name, params[name]] as [string, string]] : []);
  const session = await auth();
  const context = session?.user?.id ? await getCurrentWorkspaceContext() : null;
  if (!session?.user || !context) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`${AUTHORIZE_PATH}?${new URLSearchParams(forwarded)}`)}`);
  }
  const app = parsed.value.clientName;
  // Only what the user's role allows is offered. The app's request, or else the read
  // defaults, starts ticked; the user decides.
  const offered = scopesForRole(context.role);
  const requested = parsed.value.requestedScopes.filter(scope => offered.includes(scope));
  const preselected = requested.length ? requested : DEFAULT_OAUTH_SCOPES.filter(scope => offered.includes(scope));

  return (
    <div className="min-h-screen flex items-center justify-center px-6 py-10">
      <div className="panel w-full max-w-md rounded p-8 shadow-black/40">
        <h1 className="text-xl font-semibold text-foreground">{t("Connect {app} to OpenReply", { app })}</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          {t("{app} wants access to {workspace}.", { app, workspace: context.workspace.name })}
        </p>
        <form method="post" action="/api/oauth/authorize" className="mt-5">
          <fieldset>
            <legend className="text-sm font-medium text-foreground">{t("Choose what it can do:")}</legend>
            <div className="mt-3 space-y-3">
              {offered.map(scope => (
                <label key={scope} className="flex items-start gap-3 text-sm">
                  <input type="checkbox" name="grant" value={scope} defaultChecked={preselected.includes(scope)} className="mt-1 h-4 w-4 shrink-0" />
                  <span>
                    <span className="block font-medium text-foreground">{t(SCOPE_TEXT[scope][0])}</span>
                    <span className="block text-muted">{t(SCOPE_TEXT[scope][1])}</span>
                  </span>
                </label>
              ))}
            </div>
            {context.role === "MEMBER" && <p className="mt-3 text-xs text-muted">{t("Creating and changing campaigns needs an owner or admin.")}</p>}
          </fieldset>
          <div className="mt-5 space-y-1 border-t border-border pt-4 text-xs leading-relaxed text-muted">
            <p>{t("Signed in as {email}", { email: session.user.email ?? "" })}</p>
            <p>{t("After you allow access, you will be sent to {destination}.", { destination: destination(parsed.value.redirectUri) })}</p>
            <p>{t("Only connect apps you trust. You can disconnect it at any time under API & MCP.")}</p>
          </div>
          {forwarded.map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
          <input type="hidden" name="workspace_id" value={context.workspaceId} />
          <div className="mt-6 flex gap-3">
            <button type="submit" name="decision" value="deny"
              className="flex-1 rounded border border-border px-4 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-surface">
              {t("Cancel")}
            </button>
            <button type="submit" name="decision" value="allow"
              className="flex-1 rounded bg-accent px-4 py-3 text-sm font-semibold text-white shadow-indigo-500/25 transition-all hover:shadow-indigo-500/30">
              {t("Allow access")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
