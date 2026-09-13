import { parseCookie } from 'cookie';

export const COOKIE_NAME = 'am_session';

export function sessionIdFromCookieHeader(
  header: string | undefined,
): string | undefined {
  if (!header) return undefined;
  return parseCookie(header)[COOKIE_NAME];
}
