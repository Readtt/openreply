import { consumeRateLimit } from "@/lib/integrations/auth";
import { readJson } from "@/lib/integrations/http";
import { CORS_HEADERS, oauthErrorResponse, registerClient } from "@/lib/integrations/oauth";

/** RFC 7591 dynamic client registration, open to any MCP client and bounded per address. */
export async function POST(request: Request) {
  try {
    const address = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || request.headers.get("x-real-ip") || "direct";
    await consumeRateLimit(`oauth-register:${address}`, 20, 3600);
    const client = await registerClient(await readJson(request, 16 * 1024));
    return Response.json(client, { status: 201, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
  } catch (error) { return oauthErrorResponse(error); }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
