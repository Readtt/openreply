import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getI18n } from "@/lib/i18n/server";
import { AUTHORIZE_PATH, parseAuthorizationRequest } from "@/lib/integrations/oauth";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

type SearchParams = Record<string, string | string[] | undefined>;

// Only the OAuth request travels through the consent form; nothing else is echoed back.
const FORWARDED = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope", "resource"];

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

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="panel w-full max-w-md rounded p-8 shadow-black/40">
        <h1 className="text-xl font-semibold text-foreground">{t("Connect {app} to OpenReply", { app })}</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          {t("{app} is asking for read-only access to {workspace}.", { app, workspace: context.workspace.name })}
        </p>
        <p className="mt-5 text-sm font-medium text-foreground">{t("It will be able to:")}</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-foreground">
          <li>{t("Read your campaigns, their settings and destination links")}</li>
          <li>{t("Read campaign send counts and link clicks")}</li>
        </ul>
        <p className="mt-3 text-sm text-muted">{t("It cannot edit campaigns, send messages or see your Instagram connection.")}</p>
        <div className="mt-5 space-y-1 border-t border-border pt-4 text-xs leading-relaxed text-muted">
          <p>{t("Signed in as {email}", { email: session.user.email ?? "" })}</p>
          <p>{t("After you allow access, you will be sent to {destination}.", { destination: destination(parsed.value.redirectUri) })}</p>
          <p>{t("Only connect apps you trust. You can disconnect it at any time under API & MCP.")}</p>
        </div>
        <form method="post" action="/api/oauth/authorize" className="mt-6 flex gap-3">
          {forwarded.map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
          <input type="hidden" name="workspace_id" value={context.workspaceId} />
          <button type="submit" name="decision" value="deny"
            className="flex-1 rounded border border-border px-4 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-surface">
            {t("Cancel")}
          </button>
          <button type="submit" name="decision" value="allow"
            className="flex-1 rounded bg-accent px-4 py-3 text-sm font-semibold text-white shadow-indigo-500/25 transition-all hover:shadow-indigo-500/30">
            {t("Allow access")}
          </button>
        </form>
      </div>
    </div>
  );
}
