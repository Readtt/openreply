import { prisma } from "@/lib/db/client";
import { apiError, ApiError, checkOrigin } from "@/lib/integrations/http";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";

/** Apps connected through OAuth. Members see and disconnect their own; owners and admins, the whole workspace's. */
async function scope() {
  const context = await getCurrentWorkspaceContext();
  if (!context) throw new ApiError("Sign in required", 401);
  return { workspaceId: context.workspaceId, ...(canManageWorkspace(context.role) ? {} : { userId: context.userId }) };
}

export async function GET() {
  try {
    const grants = await prisma.oAuthGrant.findMany({
      where: { ...(await scope()), revokedAt: null, codeUsedAt: { not: null }, refreshExpiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" }, take: 100,
      select: { id: true, scopes: true, createdAt: true, lastUsedAt: true, client: { select: { name: true } }, user: { select: { email: true } } },
    });
    const apps = grants.map(({ client, user, ...grant }) => ({ ...grant, name: client.name, userEmail: user.email }));
    return Response.json({ apps }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request) {
  try {
    checkOrigin(request);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new ApiError("Connection id required");
    const result = await prisma.oAuthGrant.updateMany({ where: { id, ...(await scope()), revokedAt: null }, data: { revokedAt: new Date() } });
    if (!result.count) throw new ApiError("Connection not found or already disconnected", 404);
    return Response.json({ success: true });
  } catch (error) { return apiError(error); }
}
