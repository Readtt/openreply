import { createHash, randomBytes } from "node:crypto";
import Redis from "ioredis";
import { prisma } from "@/lib/db/client";
import { ApiError } from "./http";

import { SERVICE_SCOPES } from "./scopes";
export { SERVICE_SCOPES } from "./scopes";
export type ServiceScope = typeof SERVICE_SCOPES[number];
export type ServiceContext = { workspaceId: string; keyId: string; scopes: string[] };
export const hashServiceToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newServiceToken = () => `orp_${randomBytes(32).toString("base64url")}`;
let redis: Redis | undefined;
let connecting: Promise<unknown> | undefined;

async function limiter() {
  if (!process.env.REDIS_URL) throw new ApiError("Integration rate limiter unavailable", 503);
  redis ??= new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true,
    connectTimeout: 3000, retryStrategy: () => null });
  // Prevent connection errors from being logged with infrastructure details.
  if (!redis.listenerCount("error")) redis.on("error", () => undefined);
  if (redis.status !== "ready") {
    if (!connecting) connecting = redis.connect().finally(() => { connecting = undefined; });
    await connecting;
  }
  return redis;
}

export function requireScope(context: ServiceContext, scope: ServiceScope) {
  if (!context.scopes.includes(scope)) throw new ApiError(`Missing scope: ${scope}`, 403);
}

/** Fixed-window counter. Fails closed: a Redis outage must not turn a public endpoint unlimited. */
export async function consumeRateLimit(key: string, limit: number, windowSeconds: number) {
  let count: number;
  try {
    count = Number(await (await limiter()).eval(
    'local n=redis.call("INCR",KEYS[1]); if n==1 then redis.call("EXPIRE",KEYS[1],ARGV[1]) end; return n',
    1, key, windowSeconds,
    ));
  } catch { throw new ApiError("Integration rate limiter unavailable", 503); }
  if (count > limit) throw new ApiError("Rate limit exceeded", 429);
}

export async function authenticateService(request: Request): Promise<ServiceContext> {
  const token = request.headers.get("authorization")?.match(/^Bearer (orp_[A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw new ApiError("Bearer service key required", 401);
  const key = await prisma.serviceKey.findUnique({ where: { tokenHash: hashServiceToken(token) } });
  if (!key || key.revokedAt || key.expiresAt <= new Date()) throw new ApiError("Invalid or expired service key", 401);
  await consumeRateLimit(`integration-rate:${key.id}`, 120, 60);
  await prisma.serviceKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
  return { workspaceId: key.workspaceId, keyId: key.id, scopes: key.scopes };
}
