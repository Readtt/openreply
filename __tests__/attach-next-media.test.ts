/**
 * Binding a "next post or reel" campaign to the post that goes up after it.
 *
 * Until a campaign is bound it matches nothing, so every comment on the new reel
 * is dropped — no DM, no public reply, no error. These cover what may be bound
 * (the builder promises "next post or reel", not reels only) and when.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockGetUserMedia, mockDecryptToken } = vi.hoisted(() => ({
  mockPrisma: {
    automation: { findMany: vi.fn(), update: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  mockGetUserMedia: vi.fn(),
  mockDecryptToken: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/client", () => ({ getUserMedia: mockGetUserMedia }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mockDecryptToken }));

import {
  attachPendingNextMedia,
  isBindableMedia,
} from "../lib/polling/attach-next-media";

const CAMPAIGN_CREATED_AT = new Date("2026-03-01T12:00:00.000Z");

const ACCOUNT = {
  id: "acct_1",
  instagramId: "17841400000000000",
  accessToken: "encrypted",
};

function campaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "auto_1",
    name: "Next reel link",
    workspaceId: "ws_1",
    instagramAccountId: ACCOUNT.id,
    createdAt: CAMPAIGN_CREATED_AT,
    instagramAccount: ACCOUNT,
    ...overrides,
  };
}

function media(overrides: Record<string, unknown> = {}) {
  return {
    id: "media_1",
    media_type: "VIDEO",
    media_product_type: "REELS",
    timestamp: "2026-03-01T18:00:00.000Z",
    permalink: "https://instagram.com/reel/abc",
    ...overrides,
  };
}

describe("isBindableMedia", () => {
  it("accepts a reel", () => {
    expect(isBindableMedia(media() as never)).toBe(true);
  });

  it("accepts a photo post — the builder offers 'next post or reel'", () => {
    expect(
      isBindableMedia(
        media({ media_type: "IMAGE", media_product_type: "FEED" }) as never
      )
    ).toBe(true);
  });

  it("accepts media Instagram returns without a product type", () => {
    expect(
      isBindableMedia(media({ media_product_type: undefined }) as never)
    ).toBe(true);
  });

  it("rejects stories and ad copies", () => {
    expect(
      isBindableMedia(media({ media_product_type: "STORY" }) as never)
    ).toBe(false);
    expect(isBindableMedia(media({ media_product_type: "AD" }) as never)).toBe(
      false
    );
  });
});

describe("attachPendingNextMedia", () => {
  beforeEach(() => {
    mockPrisma.automation.findMany.mockReset();
    mockPrisma.automation.update.mockReset().mockResolvedValue({});
    mockPrisma.operationalEvent.create.mockReset().mockResolvedValue({});
    mockGetUserMedia.mockReset();
    mockDecryptToken.mockReset().mockReturnValue("token");
  });

  it("binds the campaign to the earliest post published after it", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([campaign()]);
    mockGetUserMedia.mockResolvedValue([
      media({ id: "later", timestamp: "2026-03-02T09:00:00.000Z" }),
      media({ id: "first_after", timestamp: "2026-03-01T18:00:00.000Z" }),
      media({ id: "before", timestamp: "2026-02-28T09:00:00.000Z" }),
    ]);

    await expect(attachPendingNextMedia()).resolves.toEqual({
      checked: 1,
      bound: 1,
      failedAccounts: 0,
    });
    expect(mockPrisma.automation.update).toHaveBeenCalledWith({
      where: { id: "auto_1" },
      data: {
        postId: "first_after",
        postUrl: "https://instagram.com/reel/abc",
        pendingNextReel: false,
      },
    });
  });

  it("binds a photo post too, so the campaign does not stay inert forever", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([campaign()]);
    mockGetUserMedia.mockResolvedValue([
      media({
        id: "photo",
        media_type: "IMAGE",
        media_product_type: "FEED",
        timestamp: "2026-03-01T18:00:00.000Z",
      }),
    ]);

    await attachPendingNextMedia();
    expect(mockPrisma.automation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ postId: "photo" }) })
    );
  });

  it("leaves the campaign waiting when nothing new has been published", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([campaign()]);
    mockGetUserMedia.mockResolvedValue([
      media({ id: "before", timestamp: "2026-02-28T09:00:00.000Z" }),
    ]);

    await expect(attachPendingNextMedia()).resolves.toEqual({
      checked: 1,
      bound: 0,
      failedAccounts: 0,
    });
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("never binds to a story or an ad copy", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([campaign()]);
    mockGetUserMedia.mockResolvedValue([
      media({
        id: "story",
        media_product_type: "STORY",
        timestamp: "2026-03-01T13:00:00.000Z",
      }),
      media({ id: "reel", timestamp: "2026-03-01T18:00:00.000Z" }),
    ]);

    await attachPendingNextMedia();
    expect(mockPrisma.automation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ postId: "reel" }) })
    );
  });

  it("fetches an account's media once for all of its waiting campaigns", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      campaign({ id: "auto_1" }),
      campaign({ id: "auto_2" }),
    ]);
    mockGetUserMedia.mockResolvedValue([media({ id: "reel" })]);

    await expect(attachPendingNextMedia()).resolves.toEqual({
      checked: 2,
      bound: 2,
      failedAccounts: 0,
    });
    expect(mockGetUserMedia).toHaveBeenCalledTimes(1);
  });

  it("reports a media fetch failure instead of throwing, so other accounts still bind", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([campaign()]);
    mockGetUserMedia.mockRejectedValue(new Error("Meta 190: token expired"));

    await expect(attachPendingNextMedia()).resolves.toEqual({
      checked: 1,
      bound: 0,
      failedAccounts: 1,
    });
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("skips an account with no stored token", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      campaign({ instagramAccount: { ...ACCOUNT, accessToken: null } }),
    ]);

    await expect(attachPendingNextMedia()).resolves.toEqual({
      checked: 1,
      bound: 0,
      failedAccounts: 0,
    });
    expect(mockGetUserMedia).not.toHaveBeenCalled();
  });

  it("can be narrowed to one account, for the on-demand bind on a comment", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);

    await attachPendingNextMedia({ instagramId: ACCOUNT.instagramId });
    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          pendingNextReel: true,
          instagramAccount: { instagramId: ACCOUNT.instagramId },
        },
      })
    );
  });

  it("records the campaign going live so it is visible in the logs", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([campaign()]);
    mockGetUserMedia.mockResolvedValue([media({ id: "reel" })]);

    await attachPendingNextMedia();
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "ws_1",
          level: "INFO",
        }),
      })
    );
  });
});
