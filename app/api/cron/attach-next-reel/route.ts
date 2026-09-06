import { NextRequest, NextResponse } from "next/server";
import { attachPendingNextMedia } from "@/lib/polling/attach-next-media";

/**
 * Scheduled entry point for binding "next post or reel" campaigns to the post
 * that was published after them. The work itself lives in
 * lib/polling/attach-next-media.ts because the worker runs it on a few-minute
 * interval too — this route alone is not enough, since Vercel's free plan caps a
 * cron at one run per day.
 */

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { checked, bound, failedAccounts } = await attachPendingNextMedia();

  return NextResponse.json({
    success: true,
    data: { checked, bound, failedAccounts },
  });
}
