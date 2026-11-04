import { authorizationServerMetadata, CORS_HEADERS } from "@/lib/integrations/oauth";

export function GET(request: Request) {
  return Response.json(authorizationServerMetadata(request), { headers: CORS_HEADERS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
