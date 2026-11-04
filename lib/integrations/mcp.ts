import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { createCampaignFields, updateAutomationSchema } from "@/lib/campaigns/schemas";
import { getCampaign, getCampaignStats, listCampaigns } from "./campaigns";
import { requireScope, type ServiceContext } from "./auth";
import { callDashboard } from "./dashboard";
import { ApiError } from "./http";
import type { OAuthScope } from "./scopes";

/**
 * MCP tools. The first three read campaigns directly and also work with service keys.
 * The rest call the dashboard's own API routes as the signed-in user behind an OAuth
 * grant, so an app can see and do what that user can in the dashboard, limited to the
 * permissions they approved. Outputs are trimmed to what an assistant needs.
 */

type Annotations = { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
type Tool = {
  name: string;
  title: string;
  description: string;
  scope: OAuthScope;
  /** Acts as the signed-in user, so it needs an OAuth grant rather than a service key. */
  user?: true;
  input: z.ZodType;
  annotations: Annotations;
  run: (context: ServiceContext, args: never) => Promise<unknown>;
};

const READ: Annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const READ_INSTAGRAM: Annotations = { ...READ, openWorldHint: true };
const id = z.string().min(1).max(100);
const accountId = id.optional().describe("Instagram account id from list_instagram_accounts. Defaults to the most recently connected account.");
const campaignId = z.object({ campaign_id: id.describe("Campaign id from list_campaigns.") }).strict();
const clip = (text: string | null | undefined, max = 300) => !text ? text ?? null : text.length > max ? `${text.slice(0, max)}…` : text;

type LogRow = {
  createdAt: string; status: string; commenterName: string | null; commentText: string; matchedKeyword: string | null;
  errorMessage: string | null; dmSentAt: string | null; publicReplySentAt: string | null; publicReplyError: string | null;
  dmDeliveryUnconfirmed?: boolean; automation?: { name: string } | null; instagramAccount?: { username: string } | null;
};
const toLogEntry = (log: LogRow) => ({
  at: log.createdAt, status: log.status, campaign: log.automation?.name ?? null, account: log.instagramAccount?.username ?? null,
  commenter: log.commenterName, comment: clip(log.commentText), keyword: log.matchedKeyword, error: log.errorMessage,
  dmSentAt: log.dmSentAt, deliveryUnconfirmed: log.dmDeliveryUnconfirmed ?? false,
  publicReplySentAt: log.publicReplySentAt, publicReplyError: log.publicReplyError,
});

type Campaign = {
  id: string; name: string; isActive: boolean; instagramAccountId: string; postId: string | null; postUrl: string | null;
  pendingNextReel: boolean; matchAnyPost: boolean; keywords: string[]; matchAnyWord: boolean; dmMessage: string;
  trackedLinks?: { label: string | null; destinationUrl: string }[];
};
const toCampaignSummary = (campaign: Campaign) => ({
  id: campaign.id, name: campaign.name, isActive: campaign.isActive, instagramAccountId: campaign.instagramAccountId,
  trigger: campaign.pendingNextReel ? "next_reel" : campaign.matchAnyPost ? "any_post" : "post",
  postId: campaign.postId, postUrl: campaign.postUrl, keywords: campaign.keywords, matchAnyWord: campaign.matchAnyWord,
  dmMessage: clip(campaign.dmMessage),
  ...(campaign.trackedLinks ? { links: campaign.trackedLinks.map(link => ({ label: link.label, destinationUrl: link.destinationUrl })) } : {}),
});

async function findCampaign(context: ServiceContext, campaign: string) {
  const found = await prisma.automation.findFirst({ where: { id: campaign, workspaceId: context.workspaceId }, select: { isActive: true } });
  if (!found) throw new ApiError("Campaign not found", 404);
  return found;
}

const automations = () => import("@/app/api/automations/route");
const setActive = async (context: ServiceContext, campaign: string, isActive: boolean) => {
  const { PATCH } = await automations();
  return toCampaignSummary(await callDashboard<Campaign>(context, PATCH, { method: "PATCH", query: { id: campaign }, body: { isActive } }));
};

const tools: Tool[] = [
  {
    name: "list_campaigns", title: "List campaigns", scope: "campaigns:read", annotations: READ, input: z.object({}).strict(),
    description: "List up to 100 campaigns in this workspace, newest first. Use get_campaign for complete settings and destination links, and get_campaign_results for sends and clicks.",
    run: context => listCampaigns(context),
  },
  {
    name: "get_campaign", title: "Get campaign", scope: "campaigns:read", annotations: READ, input: z.object({ id }).strict(),
    description: "Read one campaign's settings and ordered destination links. Missing links are null, not invented.",
    run: (context, args: { id: string }) => getCampaign(context, args.id),
  },
  {
    name: "get_campaign_stats", title: "Get campaign stats", scope: "campaigns:read", annotations: READ, input: z.object({ id }).strict(),
    description: "Read one campaign's aggregate send outcomes and raw link requests (not unique recipients or conversions).",
    run: (context, args: { id: string }) => getCampaignStats(context, args.id),
  },
  {
    name: "get_campaign_results", title: "Get campaign results", scope: "campaigns:read", user: true, annotations: READ,
    input: z.object({ campaign_id: id.optional().describe("Only this campaign."), instagram_account_id: accountId }).strict(),
    description: "Results as shown on the Campaigns page: DMs sent, skipped and failed, unique link clicks, click-through rate, top matched keywords and clicks per link. Covers every campaign unless campaign_id is given.",
    run: async (context, args: { campaign_id?: string; instagram_account_id?: string }) => {
      const { GET } = await automations();
      type Row = Omit<Campaign, "trackedLinks"> & { instagramAccount: { username: string } | null; trackedLinks: { label: string | null; destinationUrl: string; trackedUrl: string; _count: { clicks: number } }[];
        analytics: { sent: number; skipped: number; failed: number; clicks: number; ctr: number; topKeywords: { keyword: string; count: number }[] } };
      const rows = await callDashboard<Row[]>(context, GET, { query: { instagramAccountId: args.instagram_account_id } });
      const selected = args.campaign_id ? rows.filter(row => row.id === args.campaign_id) : rows;
      if (args.campaign_id && !selected.length) throw new ApiError("Campaign not found", 404);
      return {
        campaigns: selected.slice(0, 100).map(row => ({
          ...toCampaignSummary(row), account: row.instagramAccount?.username ?? null, dmMessage: undefined,
          results: { sent: row.analytics.sent, skipped: row.analytics.skipped, failed: row.analytics.failed, uniqueClicks: row.analytics.clicks,
            clickThroughRate: row.analytics.ctr, topKeywords: row.analytics.topKeywords },
          links: row.trackedLinks.map(link => ({ label: link.label, destinationUrl: link.destinationUrl, trackedUrl: link.trackedUrl, rawClicks: link._count.clicks })),
        })),
        total: selected.length, truncated: selected.length > 100,
      };
    },
  },
  {
    name: "get_dashboard_stats", title: "Get dashboard stats", scope: "campaigns:read", user: true, annotations: READ,
    input: z.object({ instagram_account_id: accountId.describe("Only this Instagram account. Defaults to all accounts.") }).strict(),
    description: "The Dashboard page: DMs sent today, this week, this month and in total, skipped and failed DMs this month, link clicks, click-through rate, unique contacts, active campaigns, top keywords, DMs per day for the last 7 days and the 10 latest DMs.",
    run: async (context, args: { instagram_account_id?: string }) => {
      const { GET } = await import("@/app/api/dashboard/stats/route");
      const data = await callDashboard<Record<string, unknown> & { recentLogs: LogRow[]; workspace: { name: string } | null; instagramAccounts?: { id: string; username: string }[] }>(
        context, GET, { query: { instagramAccountId: args.instagram_account_id } });
      return {
        workspace: data.workspace?.name ?? null,
        accounts: (data.instagramAccounts ?? []).map(account => ({ id: account.id, username: account.username })),
        campaigns: { total: data.totalAutomations, active: data.activeAutomations },
        dms: { today: data.dmsSentToday, thisWeek: data.dmsSentWeek, thisMonth: data.dmsSentMonth, skippedThisMonth: data.dmsSkippedMonth,
          failedThisMonth: data.dmsFailedMonth, total: data.totalDMs },
        clicks: { thisMonth: data.clicksThisMonth, total: data.totalClicks, clickThroughRateThisMonth: data.ctrThisMonth },
        uniqueContacts: data.contactsCount, topKeywords: data.topKeywords, dmsPerDay: data.dailyDMs,
        latestDms: data.recentLogs.map(toLogEntry),
      };
    },
  },
  {
    name: "list_dm_logs", title: "List DM logs", scope: "campaigns:read", user: true, annotations: READ,
    input: z.object({
      status: z.enum(["PENDING", "SENT", "FAILED", "SKIPPED_DEDUP", "SKIPPED_RATE_LIMIT", "SKIPPED_PLAN_LIMIT", "SKIPPED_NO_MATCH"]).optional(),
      instagram_account_id: accountId.describe("Only this Instagram account. Defaults to all accounts."),
      page: z.number().int().min(1).optional().default(1), limit: z.number().int().min(1).max(50).optional().default(20),
    }).strict(),
    description: "The DM Logs page: every comment that triggered a campaign, newest first, with the commenter, comment, matched keyword, DM status and error, and the public reply outcome. Paginated.",
    run: async (context, args: { status?: string; instagram_account_id?: string; page: number; limit: number }) => {
      const { GET } = await import("@/app/api/logs/route");
      const data = await callDashboard<{ logs: LogRow[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>(
        context, GET, { query: { status: args.status, instagramAccountId: args.instagram_account_id, page: args.page, limit: args.limit } });
      return { logs: data.logs.map(toLogEntry), pagination: data.pagination };
    },
  },
  {
    name: "create_campaign", title: "Create campaign", scope: "campaigns:write", user: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    input: createCampaignFields.omit({ isActive: true }).strict(),
    description: "Create a comment-to-DM campaign. It always starts paused; turn it on with activate_campaign. Required: name, dmMessage, a trigger (postId from list_instagram_posts, matchAnyPost, or pendingNextReel), and keywords unless matchAnyWord. trackedDestinationUrl adds a tracked link button to the DM.",
    run: async (context, args: Record<string, unknown>) => {
      const { POST } = await automations();
      const created = await callDashboard<Campaign>(context, POST, { method: "POST", body: { ...args, isActive: false } });
      return { ...toCampaignSummary(created), note: "Created paused. Use activate_campaign to start sending DMs." };
    },
  },
  {
    name: "update_campaign", title: "Update campaign", scope: "campaigns:write", user: true,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    input: campaignId.extend(updateAutomationSchema.omit({ isActive: true, reportShareEnabled: true }).shape).strict(),
    description: "Change a campaign's settings. Only the fields you pass change. Editing a live campaign needs the permission to turn campaigns on; otherwise pause it first with pause_campaign. Use pause_campaign and activate_campaign to change whether it runs.",
    run: async (context, { campaign_id, ...changes }: { campaign_id: string } & Record<string, unknown>) => {
      if (!Object.keys(changes).length) throw new ApiError("Pass at least one field to change");
      if ((await findCampaign(context, campaign_id)).isActive && !context.scopes.includes("campaigns:activate")) {
        throw new ApiError("This campaign is live. Pause it with pause_campaign before editing, or reconnect with permission to turn campaigns on.", 403);
      }
      const { PATCH } = await automations();
      return toCampaignSummary(await callDashboard<Campaign>(context, PATCH, { method: "PATCH", query: { id: campaign_id }, body: changes }));
    },
  },
  {
    name: "duplicate_campaign", title: "Duplicate campaign", scope: "campaigns:write", user: true, input: campaignId,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Copy a campaign with its settings and links. The copy starts paused.",
    run: async (context, args: { campaign_id: string }) => {
      const { POST } = await import("@/app/api/automations/duplicate/route");
      return toCampaignSummary(await callDashboard<Campaign>(context, POST, { method: "POST", query: { id: args.campaign_id } }));
    },
  },
  {
    name: "pause_campaign", title: "Pause campaign", scope: "campaigns:write", user: true, input: campaignId,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Stop a campaign from sending DMs. Its settings and history stay.",
    run: (context, args: { campaign_id: string }) => setActive(context, args.campaign_id, false),
  },
  {
    name: "activate_campaign", title: "Turn campaign on", scope: "campaigns:activate", user: true, input: campaignId,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    description: "Turn a campaign on. From then on it sends real DMs, and any public replies, to people who comment with a matching keyword.",
    run: (context, args: { campaign_id: string }) => setActive(context, args.campaign_id, true),
  },
  {
    name: "delete_campaign", title: "Delete campaign", scope: "campaigns:write", user: true, input: campaignId,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: "Permanently delete a paused campaign together with its DM history and tracked links. This cannot be undone. Pause a live campaign first.",
    run: async (context, args: { campaign_id: string }) => {
      if ((await findCampaign(context, args.campaign_id)).isActive) throw new ApiError("Pause the campaign with pause_campaign before deleting it.", 409);
      const { DELETE } = await automations();
      await callDashboard(context, DELETE, { method: "DELETE", query: { id: args.campaign_id } });
      return { deleted: true, campaign_id: args.campaign_id };
    },
  },
  {
    name: "list_instagram_accounts", title: "List Instagram accounts", scope: "instagram:read", user: true, annotations: READ, input: z.object({}).strict(),
    description: "The Instagram accounts connected to this workspace, most recently connected first.",
    run: async context => {
      const { GET } = await import("@/app/api/instagram/accounts/route");
      const data = await callDashboard<{ instagramAccounts: { id: string; username: string; name: string | null }[] }>(context, GET);
      return { accounts: data.instagramAccounts.map(account => ({ id: account.id, username: account.username, name: account.name })) };
    },
  },
  {
    name: "get_instagram_profile", title: "Get Instagram profile", scope: "instagram:read", user: true, annotations: READ_INSTAGRAM,
    input: z.object({ instagram_account_id: accountId }).strict(),
    description: "Live username, display name and profile picture of a connected Instagram account.",
    run: async (context, args: { instagram_account_id?: string }) => {
      const { GET } = await import("@/app/api/instagram/profile/route");
      return callDashboard(context, GET, { query: { instagramAccountId: args.instagram_account_id } });
    },
  },
  {
    name: "get_instagram_overview", title: "Get Instagram overview", scope: "instagram:read", user: true, annotations: READ_INSTAGRAM,
    input: z.object({ instagram_account_id: accountId, post_count: z.number().int().min(1).max(500).optional().default(25).describe("How many recent posts to analyse.") }).strict(),
    description: "The Overview page: followers and follower history, totals, and per-post performance for recent posts, reels and videos (views, reach, likes, comments, saves, shares). Some metrics need Instagram insights access and may be null.",
    run: async (context, args: { instagram_account_id?: string; post_count: number }) => {
      const { GET } = await import("@/app/api/instagram/overview/route");
      type Post = { id: string; caption: string | null; permalink: string | null; mediaType: string; timestamp: string;
        views: number | null; reach: number | null; likes: number; comments: number; saved: number | null; shares: number | null };
      const data = await callDashboard<{ account: { id: string; username: string }; followers: number | null; followerHistory: unknown[];
        totals: Record<string, number>; insightsAvailable: boolean; truncated: boolean; limitations?: string[]; posts: Post[] }>(
        context, GET, { query: { instagramAccountId: args.instagram_account_id, count: args.post_count } });
      return {
        account: data.account, followers: data.followers, followerHistory: data.followerHistory.slice(-90), totals: data.totals,
        insightsAvailable: data.insightsAvailable, truncated: data.truncated, limitations: data.limitations ?? [],
        posts: data.posts.map(post => ({ ...post, caption: clip(post.caption) })),
      };
    },
  },
  {
    name: "list_instagram_posts", title: "List Instagram posts", scope: "instagram:read", user: true, annotations: READ_INSTAGRAM,
    input: z.object({ instagram_account_id: accountId, limit: z.number().int().min(1).max(50).optional().default(25) }).strict(),
    description: "Recent posts, reels and videos of a connected Instagram account with like and comment counts. Pass an id as create_campaign's postId to trigger on that post.",
    run: async (context, args: { instagram_account_id?: string; limit: number }) => {
      const { GET } = await import("@/app/api/instagram/posts/route");
      type Media = { id: string; caption?: string; media_type?: string; media_product_type?: string; permalink?: string; timestamp?: string; like_count?: number; comments_count?: number };
      const posts = await callDashboard<Media[]>(context, GET, { query: { instagramAccountId: args.instagram_account_id, limit: args.limit } });
      return {
        posts: posts.map(post => ({ id: post.id, type: post.media_product_type ?? post.media_type ?? null, caption: clip(post.caption),
          permalink: post.permalink ?? null, timestamp: post.timestamp ?? null, likes: post.like_count ?? null, comments: post.comments_count ?? null })),
      };
    },
  },
  {
    name: "list_conversations", title: "List DM conversations", scope: "inbox:read", user: true, annotations: READ_INSTAGRAM,
    input: z.object({ instagram_account_id: accountId }).strict(),
    description: "The Inbox: an Instagram account's DM conversations with each contact's id and username and the latest message.",
    run: async (context, args: { instagram_account_id?: string }) => {
      const { GET } = await import("@/app/api/instagram/conversations/route");
      const data = await callDashboard<{ conversations: unknown[]; account: { id: string; username: string } }>(
        context, GET, { query: { instagramAccountId: args.instagram_account_id } });
      return { account: { id: data.account.id, username: data.account.username }, conversations: data.conversations };
    },
  },
  {
    name: "get_conversation", title: "Read DM conversation", scope: "inbox:read", user: true, annotations: READ_INSTAGRAM,
    input: z.object({ conversation_id: id.describe("Conversation id from list_conversations."), instagram_account_id: accountId }).strict(),
    description: "The latest messages of one DM conversation, oldest first.",
    run: async (context, args: { conversation_id: string; instagram_account_id?: string }) => {
      const { GET } = await import("@/app/api/instagram/conversations/[id]/route");
      return callDashboard(context, GET, { params: { id: args.conversation_id }, query: { instagramAccountId: args.instagram_account_id } });
    },
  },
  {
    name: "send_message", title: "Send DM", scope: "inbox:send", user: true,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    input: z.object({
      recipient_id: id.describe("The contact's id from list_conversations."), text: z.string().trim().min(1).max(1000),
      instagram_account_id: accountId,
    }).strict(),
    description: "Send a real Instagram direct message from the connected account, as the Inbox reply box does. Instagram only allows it within 24 hours of the person's last message. It cannot be unsent.",
    run: async (context, args: { recipient_id: string; text: string; instagram_account_id?: string }) => {
      const { POST } = await import("@/app/api/instagram/conversations/route");
      await callDashboard(context, POST, { method: "POST", body: { recipientId: args.recipient_id, text: args.text, instagramAccountId: args.instagram_account_id } });
      return { sent: true, recipient_id: args.recipient_id };
    },
  },
  {
    name: "get_workspace_members", title: "Get workspace members", scope: "workspace:read", user: true, annotations: READ, input: z.object({}).strict(),
    description: "The workspace's members with their roles, your own role, and pending invitations.",
    run: async context => {
      const { GET } = await import("@/app/api/workspace/members/route");
      const data = await callDashboard<{ currentUserRole?: string; members: { role: string; createdAt: string; user: { email: string | null; name: string | null } }[];
        invitations: { email: string; role: string; expiresAt: string }[] }>(context, GET);
      return {
        yourRole: data.currentUserRole ?? null,
        members: data.members.map(member => ({ name: member.user.name, email: member.user.email, role: member.role, joinedAt: member.createdAt })),
        // Invite links are left out: anyone holding one can join the workspace.
        pendingInvitations: data.invitations.map(invitation => ({ email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt })),
      };
    },
  },
  {
    name: "get_diagnostics", title: "Get diagnostics", scope: "workspace:read", user: true, annotations: READ, input: z.object({}).strict(),
    description: "The Diagnostics page: DM queue counts, worker health and alerts, and recent webhook failures, failed DMs, token refresh failures and operational events. Use it to explain why DMs are not going out.",
    run: async context => {
      const { GET } = await import("@/app/api/admin/diagnostics/route");
      type Rows = Record<string, unknown>[] | undefined;
      const data = await callDashboard<Record<string, unknown> & { dmFailures?: Rows; tokenRefreshFailures?: Rows }>(context, GET);
      return {
        ...data,
        dmFailures: (data.dmFailures ?? []).map(({ commentId, ...failure }) => (void commentId, failure)),
        tokenRefreshFailures: (data.tokenRefreshFailures ?? []).map(({ payload, ...failure }) => (void payload, failure)),
      };
    },
  },
];

function inputSchema(schema: z.ZodType) {
  const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

const allowed = (context: ServiceContext, tool: Tool) => context.scopes.includes(tool.scope) && (!tool.user || Boolean(context.userId));

export function listTools(context: ServiceContext) {
  return tools.filter(tool => allowed(context, tool)).map(tool => ({
    name: tool.name, title: tool.title, description: tool.description, inputSchema: inputSchema(tool.input),
    annotations: { title: tool.title, ...tool.annotations },
  }));
}

export async function callTool(context: ServiceContext, name: string, args: unknown) {
  const tool = tools.find(candidate => candidate.name === name);
  if (!tool) throw new ApiError("Unknown tool", 404);
  requireScope(context, tool.scope);
  if (!allowed(context, tool)) throw new ApiError("This tool needs an app connected with an OpenReply sign-in, not a service key", 403);
  const input = tool.input.safeParse(args);
  if (!input.success) {
    throw new ApiError(`Invalid arguments: ${input.error.issues.map(issue => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`);
  }
  return tool.run(context, input.data as never);
}
