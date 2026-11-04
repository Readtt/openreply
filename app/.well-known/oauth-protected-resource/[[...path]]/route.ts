import { CORS_HEADERS, MCP_PATH, protectedResourceMetadata } from "@/lib/integrations/oauth";

// Served at the root and at the path-suffixed URL for /api/mcp (RFC 9728 §3.1).
export async function GET(request: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  if (path.length && `/${path.join("/")}` !== MCP_PATH) return new Response(null, { status: 404, headers: CORS_HEADERS });
  return Response.json(protectedResourceMetadata(request), { headers: CORS_HEADERS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
