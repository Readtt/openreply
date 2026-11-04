import { NextRequest } from "next/server";
import { runAsWorkspaceUser } from "@/lib/delegated-user";
import type { ServiceContext } from "./auth";
import { ApiError } from "./http";

// `never` lets routes with typed dynamic params (e.g. { id: string }) be passed in.
type RouteHandler = (request: NextRequest, context: { params: Promise<never> }) => Promise<Response>;
type Query = Record<string, string | number | boolean | null | undefined>;

/** Flattens a dashboard route's error, including zod field errors, into one readable line. */
function describeFailure(payload: unknown, status: number) {
  const body = (payload ?? {}) as { error?: unknown; details?: { formErrors?: string[]; fieldErrors?: Record<string, string[]> } };
  const parts = [typeof body.error === "string" ? body.error : `Request failed (${status})`];
  for (const message of body.details?.formErrors ?? []) parts.push(message);
  for (const [field, messages] of Object.entries(body.details?.fieldErrors ?? {})) parts.push(`${field}: ${messages.join(", ")}`);
  return parts.join(". ");
}

/**
 * Calls a dashboard API route as the user behind an OAuth grant, pinned to the granted
 * workspace. MCP tools therefore see exactly what that user sees in the dashboard, and
 * the routes' own role checks (owners and admins change campaigns) still apply.
 */
export async function callDashboard<T>(
  context: ServiceContext,
  handler: RouteHandler,
  { method = "GET", query, body, params }: { method?: string; query?: Query; body?: unknown; params?: Record<string, string> } = {},
): Promise<T> {
  if (!context.userId) throw new ApiError("This tool needs an app connected with an OpenReply sign-in, not a service key", 403);
  const url = new URL("http://openreply.internal/api");
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const request = new NextRequest(url, body === undefined
    ? { method }
    : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await runAsWorkspaceUser({ userId: context.userId, workspaceId: context.workspaceId },
    () => handler(request, { params: Promise.resolve(params ?? {}) as Promise<never> }));
  const payload = await response.json().catch(() => null) as { success?: boolean; data?: T } | null;
  if (!response.ok || payload?.success === false) {
    throw new ApiError(describeFailure(payload, response.status), response.status >= 400 && response.status < 500 ? response.status : 502);
  }
  return payload?.data as T;
}
