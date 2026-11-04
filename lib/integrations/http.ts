export class ApiError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** Bound streamed bodies too: Content-Length alone is client controlled. */
export async function readJson(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new ApiError("application/json required", 415);
  }
  try { return JSON.parse(await readText(request, maxBytes)); }
  catch (error) { throw error instanceof ApiError ? error : new ApiError("Invalid JSON"); }
}

export async function readText(request: Request, maxBytes = 64 * 1024): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError("Empty body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new ApiError("Body too large", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const expected = new URL(process.env.NEXTAUTH_URL ?? request.url).origin;
  if (origin !== expected) throw new ApiError("Origin not allowed", 403);
}

/**
 * For browser form posts that act on the signed-in session: the Origin header must
 * be present and be this site, as configured or as seen through a reverse proxy.
 */
export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const allowed = [new URL(request.url).origin];
  if (process.env.NEXTAUTH_URL) allowed.push(new URL(process.env.NEXTAUTH_URL).origin);
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost) allowed.push(`${request.headers.get("x-forwarded-proto") ?? "https"}://${forwardedHost}`);
  if (!origin || !allowed.includes(origin)) throw new ApiError("Origin not allowed", 403);
}

export function apiError(error: unknown) {
  const status = error instanceof ApiError ? error.status : 500;
  return Response.json({ error: status === 500 ? "Internal error" : (error as Error).message }, {
    status, headers: { "Cache-Control": "no-store" },
  });
}
