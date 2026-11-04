import { AsyncLocalStorage } from "node:async_hooks";

export type DelegatedUser = { userId: string; workspaceId: string };

const storage = new AsyncLocalStorage<DelegatedUser>();

/**
 * Runs `fn` as a user who signed in some other way than the session cookie (an MCP
 * OAuth grant), pinned to the workspace they granted. The session helpers in
 * lib/auth.ts and lib/workspace-access.ts read it, so dashboard routes scope data and
 * check roles exactly as they would for that user in the browser.
 */
export function runAsWorkspaceUser<T>(user: DelegatedUser, fn: () => Promise<T>) {
  return storage.run(user, fn);
}

export function getDelegatedUser() {
  return storage.getStore();
}
