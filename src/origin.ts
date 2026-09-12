/**
 * Same-origin check for cookie-authenticated requests. A browser sends
 * `Origin` on websocket upgrades and on cross-origin or non-GET requests;
 * when it is present it must match the request's own host (the single
 * origin the manager serves) or the configured public origin. Requests
 * without an `Origin` header (curl, same-origin GETs) pass.
 */
export function originAllowed(
  origin: string | undefined,
  host: string | undefined,
  publicOrigin: string | null,
): boolean {
  if (!origin) return true;
  if (publicOrigin && origin === publicOrigin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
