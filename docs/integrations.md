# Read-only API and MCP

Workspace owners and admins can create keys at **API & MCP** (`/integrations`).
The UI offers 30, 60 or 90 days (default: 30). The API accepts whole days from
1 to 90. Existing keys are never extended. Copy the token at creation; only its
SHA-256 hash is stored. Revocation takes effect on subsequent authenticated requests.
Use HTTPS and never put a token in a URL, source control, screenshots or prompts.
Keys belong to the workspace, not their creator, and remain valid until expiry,
revocation or workspace deletion. Review keys when team members leave.

Apply migrations and regenerate Prisma before starting the new web version:

```sh
npm run db:migrate
npm run db:generate
```

The additive migrations only create `ServiceKey`, `OAuthClient` and `OAuthGrant`;
they do not change campaigns, authentication providers or worker behavior.
`REDIS_URL` is required for service requests. Each key or connected app allows
120 requests per fixed 60-second window. Redis failures reject requests with 503
instead of disabling the limiter.

## Connect with your OpenReply account (OAuth)

Clients that support MCP authorization (Claude, ChatGPT, Claude Code, Cursor,
VS Code, MCP Inspector) need only the server URL:

```text
https://YOUR-DOMAIN/api/mcp
```

- **Claude / ChatGPT:** add a custom connector with that URL.
- **Claude Code:** `claude mcp add --transport http openreply https://YOUR-DOMAIN/api/mcp`,
  then run `/mcp` and choose **Authenticate**.

The client is challenged with `401` and `WWW-Authenticate: Bearer resource_metadata=...`,
reads `/.well-known/oauth-protected-resource/api/mcp` and
`/.well-known/oauth-authorization-server`, registers itself at
`/api/oauth/register` (RFC 7591) and opens `/oauth/authorize`. You sign in with
your usual magic link and tick what the app may do. The consent screen shows the
app's self-declared name and the address you will be sent back to; approve only
apps you started connecting yourself.

### Permissions

| Permission | Tools | Who can grant it |
| --- | --- | --- |
| View campaigns and results (`campaigns:read`) | `list_campaigns`, `get_campaign`, `get_campaign_stats`, `get_campaign_results`, `get_dashboard_stats`, `list_dm_logs` | everyone |
| Create and edit campaigns (`campaigns:write`) | `create_campaign`, `update_campaign`, `duplicate_campaign`, `pause_campaign`, `delete_campaign` | owners, admins |
| Turn campaigns on (`campaigns:activate`) | `activate_campaign`; also needed to edit a live campaign | owners, admins |
| View Instagram accounts and posts (`instagram:read`) | `list_instagram_accounts`, `get_instagram_profile`, `get_instagram_overview` (followers, per-post views, reach, likes, comments, saves, shares), `list_instagram_posts` | everyone |
| Read your inbox (`inbox:read`) | `list_conversations`, `get_conversation` | everyone |
| Send DMs (`inbox:send`) | `send_message` | everyone |
| View workspace (`workspace:read`) | `get_workspace_members`, `get_diagnostics` | everyone |

The read permissions for campaigns and Instagram start ticked; the rest are
opt-in. The tools behind a permission call the same API routes as the dashboard,
as the user who connected, so they see exactly what that user sees and the
dashboard's role checks still apply. Each grant is cut to the user's current
role on every request: an admin who is made a member loses the write tools.

Safety rules on top of the dashboard's:

- Campaigns created through MCP, and duplicates, always start paused. Turning
  one on, or editing one that is live, needs `campaigns:activate`.
- `delete_campaign` only deletes paused campaigns; it removes their DM history
  and tracked links and cannot be undone.
- `send_message` sends a real DM; Instagram allows it within 24 hours of the
  person's last message.
- Tools never return Instagram tokens, commenter or comment ids, invitation
  links or report share links. Connecting Instagram, managing members, API keys
  and public report sharing stay in the dashboard.

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`) so clients can ask before changes, and
object results are also returned as `structuredContent`.

- Any workspace member can connect, and a grant is bound to that user and their
  workspace: it stops working as soon as the user leaves the workspace.
- See and disconnect apps under **API & MCP → Connected apps**. Members see
  their own connections; owners and admins see and can disconnect everyone's.
- PKCE (`S256`) is required. Access tokens last one hour; refresh tokens last
  30 days and rotate on every use. Replaying a used code, or an old refresh
  token, revokes the connection. Only SHA-256 hashes of codes, tokens and client
  secrets are stored.
- Redirect URIs must be HTTPS, loopback HTTP (any port, RFC 8252) or a native
  app's private scheme. Registration is limited to 20 per hour per IP address.
- A malformed authorization request shows an error page instead of redirecting,
  so `/oauth/authorize` cannot be used as an open redirect. The only redirects
  follow the user's own **Allow** or **Cancel**.
- `NEXTAUTH_URL` must be your public HTTPS origin: it is the OAuth issuer and
  the token audience, so changing it requires reconnecting clients.

OAuth tokens are accepted only by `/api/mcp`. The REST API keeps using service keys.
Service keys are not tied to a person, so with a key the MCP server offers only
the three read-only campaign tools below.

## MCP clients with a service key

Clients without OAuth support can connect to `https://YOUR-DOMAIN/api/mcp`
using Streamable HTTP and a custom header:

```text
Authorization: Bearer <service-key>
```

Never put the key in the URL, and never switch to public access to work around a
client limitation.

Tools (all read-only; scope `campaigns:read`):

- `list_campaigns`: up to 100 compact campaign summaries, newest first.
- `get_campaign` with `{ "id": "..." }`: settings, ordered `trackedLinks`, and
  `trackedDestinationUrl`, `secondaryDestinationUrl`, `secondaryButtonLabel`.
  Missing links are `[]` / `null`. Link order matches the existing DM worker.
- `get_campaign_stats` with `{ "id": "..." }`: aggregate send outcomes and raw
  link requests. These are **not** unique recipients or CRM conversions.

Example safe verification: ask your client to list campaigns, then read one
campaign's destination URLs without changing anything. There are no mutation,
activation, publish, account-token or messaging tools in this contribution.

## REST

Use the same Bearer header:

```text
GET /api/v1/campaigns
GET /api/v1/campaigns?id=<campaign-id>
GET /api/v1/campaigns?id=<campaign-id>&stats=1
```

Responses use `{ "data": ... }`. Lists are capped at 100; pagination is not yet
provided. Detail responses use an explicit safe projection: no provider tokens,
report-share secrets, recipient logs or account relations. A campaign outside
the key's workspace returns 404. Invalid/expired/revoked keys return 401, missing
scope returns 403, rate limits return 429. Results are `Cache-Control: no-store`.

Admin key management uses session authentication at `/api/integrations/keys`:
GET lists metadata (never hashes/tokens), POST creates a key, DELETE with `?id=`
revokes it. A supplied Origin must match `NEXTAUTH_URL` (or the request origin).
JSON request bodies are bounded to 64 KiB including streamed/chunked requests.

## Verification

`npm test` includes mocked authentication/route tests. Set `TEST_DATABASE_URL`
to a disposable local PostgreSQL database to also exercise full migrations,
workspace isolation, deterministic link ordering and fixed key expiration.
The DB suites create and remove their own schemas.

For actual HTTP verification, migrate a **disposable local** database, start
the web app with that `DATABASE_URL`, local `REDIS_URL` and loopback
`NEXTAUTH_URL`, then run:

```sh
TEST_BASE_URL=http://127.0.0.1:3317 \
TEST_DATABASE_URL=postgresql://postgres:local-test@127.0.0.1:54456/postgres \
npx tsx scripts/verify-readonly-integrations.ts
```

The script refuses non-loopback URLs, creates dummy fixtures and keys, and
removes its test user/workspace in `finally`. It must never run against a real
deployment, including one tunneled through localhost. No Meta messages are sent.
