/**
 * Binds "next post or reel" campaigns to a real post.
 *
 * Instagram sends no webhook when a new media is published, so we poll: for
 * every campaign waiting on the creator's next post, find the earliest one
 * published after the campaign was created and attach the campaign to it.
 *
 * Until that happens the campaign matches nothing — `postId` is null and
 * `matchAnyPost` is false — so every comment on the new reel is dropped with no
 * DM and no public reply. That makes how often this runs the whole story: it is
 * called from the worker's poll loop (every few minutes, see worker/dm-worker.ts)
 * as well as from /api/cron/attach-next-reel, because Vercel's free plan caps a
 * cron at one run per day and a day of silence is the entire first evening of a
 * reel, when most comments arrive. The comment sweep runs right after the bind
 * in the same tick, so comments left in the minutes before it are still answered.
 */

import { prisma } from "@/lib/db/client";
import { getUserMedia, type InstagramMedia } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";

/** How many recent media to look at per account when hunting for the new post. */
const MEDIA_LOOKBACK = 25;

/**
 * Whether a media is something a "next post or reel" campaign can bind to.
 *
 * The campaign builder offers "next post or reel", so this deliberately accepts
 * more than reels: a photo or carousel published after the campaign has to bind
 * too. Requiring `media_product_type === "REELS"` left every such campaign inert
 * forever — no DM, no public reply, no error — and also missed a reel Instagram
 * reports without the field.
 *
 * Stories and ad copies are excluded: neither is the post the campaign is
 * waiting on. `/me/media` does not return stories today, so this is a guard
 * rather than a filter that fires.
 */
export function isBindableMedia(media: InstagramMedia): boolean {
  const productType = media.media_product_type?.toUpperCase();
  return productType !== "STORY" && productType !== "AD";
}

export interface AttachNextMediaOptions {
  /**
   * Restrict the run to one connected account, by its Instagram user id. Used
   * by the comment path, which binds on demand for the account a comment just
   * arrived for rather than sweeping every account on every comment.
   */
  instagramId?: string;
}

export interface AttachNextMediaResult {
  /** Campaigns waiting on a post at the start of this run. */
  checked: number;
  /** Campaigns bound to a post by this run. */
  bound: number;
  /** Accounts whose media could not be fetched (token or API failure). */
  failedAccounts: number;
}

/** Bind every campaign waiting on the account's next post. Safe to call often. */
export async function attachPendingNextMedia(
  options: AttachNextMediaOptions = {}
): Promise<AttachNextMediaResult> {
  const pending = await prisma.automation.findMany({
    where: {
      pendingNextReel: true,
      ...(options.instagramId
        ? { instagramAccount: { instagramId: options.instagramId } }
        : {}),
    },
    include: { instagramAccount: true },
  });

  // Group by connected account so we fetch each account's media only once.
  const byAccount = new Map<
    string,
    {
      account: (typeof pending)[number]["instagramAccount"];
      automations: typeof pending;
    }
  >();
  for (const automation of pending) {
    const key = automation.instagramAccountId;
    const entry = byAccount.get(key);
    if (entry) entry.automations.push(automation);
    else
      byAccount.set(key, {
        account: automation.instagramAccount,
        automations: [automation],
      });
  }

  let bound = 0;
  let checked = 0;
  let failedAccounts = 0;

  for (const { account, automations } of byAccount.values()) {
    checked += automations.length;
    if (!account?.accessToken) continue;

    let media: InstagramMedia[];
    try {
      const token = decryptToken(account.accessToken);
      const recent = await getUserMedia(token, MEDIA_LOOKBACK);
      media = recent
        .filter(isBindableMedia)
        .filter((m) => Number.isFinite(Date.parse(m.timestamp)))
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    } catch (err) {
      failedAccounts += 1;
      console.error("[attach-next-media] media fetch failed", account.id, err);
      continue;
    }

    for (const automation of automations) {
      // The "next" post = the earliest one published after the campaign was made.
      const next = media.find(
        (m) => Date.parse(m.timestamp) > automation.createdAt.getTime()
      );
      if (!next) continue;

      await prisma.automation.update({
        where: { id: automation.id },
        data: {
          postId: next.id,
          postUrl: next.permalink ?? null,
          pendingNextReel: false,
        },
      });
      bound += 1;

      // Visible in the dashboard logs: until now a campaign going live was
      // silent, so "nothing happened" and "not bound yet" looked identical.
      await prisma.operationalEvent
        .create({
          data: {
            workspaceId: automation.workspaceId,
            source: "SYSTEM",
            level: "INFO",
            message: `Campaign "${automation.name}" is now live on your latest post`,
            payload: {
              automationId: automation.id,
              mediaId: next.id,
              permalink: next.permalink ?? null,
              mediaProductType: next.media_product_type ?? next.media_type,
            },
          },
        })
        .catch(() => {});
    }
  }

  return { checked, bound, failedAccounts };
}
