"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";

type Key = { id: string; name: string; expiresAt: string; revokedAt: string | null };
type ConnectedApp = { id: string; name: string; userEmail: string | null; createdAt: string; lastUsedAt: string | null };

export default function IntegrationsPage() {
  const { t, locale } = useI18n();
  const [keys, setKeys] = useState<Key[]>([]);
  const [apps, setApps] = useState<ConnectedApp[]>([]);
  const [origin, setOrigin] = useState("");
  const [name, setName] = useState("");
  const [days, setDays] = useState(30);
  const [token, setToken] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await fetch("/api/integrations/keys");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    setKeys(data.keys);
  }

  async function loadApps() {
    const response = await fetch("/api/integrations/oauth");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    setApps(data.apps);
  }

  useEffect(() => {
    void Promise.resolve().then(() => setOrigin(window.location.origin));
    void Promise.resolve().then(loadApps).catch(e => setNotice(e.message));
    void Promise.resolve().then(load).catch(e => setNotice(e.message));
  }, []);

  async function disconnect(app: ConnectedApp) {
    if (!window.confirm(t("Disconnect {app}? It will lose access immediately.", { app: app.name }))) return;
    setBusy(true); setNotice("");
    try {
      const response = await fetch(`/api/integrations/oauth?id=${encodeURIComponent(app.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error((await response.json()).error);
      await loadApps();
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }

  async function create() {
    if (!window.confirm(t("Create a read-only workspace key for {days} days? Anyone with this key can read your campaigns.", { days }))) return;
    setBusy(true); setToken(""); setNotice("");
    try {
      const response = await fetch("/api/integrations/keys", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, days, scopes: ["campaigns:read"] }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setToken(data.token);
      await load();
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }

  async function revoke(key: Key) {
    if (!window.confirm(t("Revoke this key? Connected clients will lose access immediately."))) return;
    setBusy(true); setNotice("");
    try {
      const response = await fetch(`/api/integrations/keys?id=${encodeURIComponent(key.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error((await response.json()).error);
      setToken("");
      await load();
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="mx-auto max-w-4xl space-y-6 p-6">
    <h1 className="text-2xl font-semibold">{t("API & MCP")}</h1>
    <p className="text-muted">{t("Workspace-scoped, read-only keys. No key can modify campaigns or send messages. Only admins and owners can manage keys.")}</p>
    {notice && <p role="status">{notice}</p>}
    <section className="space-y-3 rounded border border-border p-4">
      <label className="block">{t("Key name")}<input maxLength={100} disabled={busy} className="w-full rounded border border-border p-2" value={name} onChange={e => setName(e.target.value)} /></label>
      <label className="block">{t("Key lifetime")}<select disabled={busy} value={days} onChange={e => setDays(Number(e.target.value))} className="ml-3 rounded border border-border p-2">
        {[30, 60, 90].map(value => <option key={value} value={value}>{t("{days} days", { days: value })}</option>)}
      </select></label>
      <p className="text-sm text-muted">{t("Applies only to new keys. Existing expiration dates do not change.")}</p>
      <button disabled={busy || !name.trim()} onClick={create} className="rounded bg-accent px-4 py-2 text-white disabled:opacity-50">{t("Create key for {days} days", { days })}</button>
      {token && <div role="status" className="space-y-2">
        <p>{t("Shown once. Store securely; never put keys in URLs, screenshots or GitHub.")}</p>
        <input aria-label={t("New service key")} type="password" readOnly value={token} className="w-full rounded border border-border p-2" />
        <button onClick={() => navigator.clipboard.writeText(token).catch(() => setNotice(t("Could not copy key. Use a secure HTTPS connection.")))}>{t("Copy")}</button>
        <button className="ml-4" onClick={() => setToken("")}>{t("Hide key")}</button>
      </div>}
    </section>
    <section className="space-y-3">{keys.map(key => <div key={key.id} className="rounded border border-border p-4">
      <strong>{key.name}</strong>
      <p className="text-sm">campaigns:read · {t("Expires: {date}", { date: new Date(key.expiresAt).toLocaleDateString(locale) })}</p>
      {key.revokedAt ? <span>{t("Revoked")}</span> : <button disabled={busy} onClick={() => revoke(key)} className="text-red-500">{t("Revoke key")}</button>}
    </div>)}</section>
    <section className="space-y-3">
      <h2 className="font-semibold">{t("Connected apps")}</h2>
      <p className="text-sm text-muted">{t("Apps connected by signing in with an OpenReply account. Members see their own; owners and admins see every connection in this workspace.")}</p>
      {apps.length === 0 && <p className="text-sm text-muted">{t("No apps connected yet.")}</p>}
      {apps.map(app => <div key={app.id} className="rounded border border-border p-4">
        <strong>{app.name}</strong>
        <p className="text-sm">campaigns:read · {t("Connected {date}", { date: new Date(app.createdAt).toLocaleDateString(locale) })}{app.userEmail ? ` · ${app.userEmail}` : ""}</p>
        <button disabled={busy} onClick={() => disconnect(app)} className="text-red-500">{t("Disconnect")}</button>
      </div>)}
    </section>
    <section className="space-y-2 text-sm">
      <h2 className="font-semibold">{t("Connection")}</h2>
      <p>MCP: <code>{origin}/api/mcp</code> · REST: <code>/api/v1/campaigns</code></p>
      <p>{t("Clients that support OAuth, such as Claude, ChatGPT, Cursor and VS Code, only need the MCP URL: you sign in with your OpenReply account and approve read-only access.")}</p>
      <p>{t("Clients without OAuth, and the REST API, send a service key in an Authorization: Bearer header.")}</p>
      <p>{t("Campaign lists are limited to 100. Use get_campaign for complete settings and destination links; clicks are raw requests, not unique recipients.")}</p>
    </section>
  </div>;
}
