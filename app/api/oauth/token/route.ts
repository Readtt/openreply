import { readText } from "@/lib/integrations/http";
import { CORS_HEADERS, exchangeToken, oauthErrorResponse, tokenRequestBody } from "@/lib/integrations/oauth";

export async function POST(request: Request) {
  try {
    const body = tokenRequestBody(request.headers.get("content-type") ?? "", await readText(request, 16 * 1024));
    const tokens = await exchangeToken(request, body);
    return Response.json(tokens, { headers: { ...CORS_HEADERS, "Cache-Control": "no-store", Pragma: "no-cache" } });
  } catch (error) { return oauthErrorResponse(error); }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
