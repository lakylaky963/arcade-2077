// Who is this player? Ask the dashboard (CT 105) about the hub SSO cookie.
//
// The browser sends `homelab_session` with the WebSocket handshake (same origin
// through CT 101). We forward only that one cookie to GET /api/game/me and
// trust the dashboard's answer. No cookie, a rejected cookie, or an
// unreachable dashboard all mean "guest": guests can play but earn no XP.

import { cleanName } from '../lib/names.ts';
import type { Identity } from '../types.ts';

export const SESSION_COOKIE = 'homelab_session';
export const DEFAULT_DASHBOARD_BASE = 'http://10.0.0.223:3000';
export const DEFAULT_ME_TIMEOUT_MS = 2500;

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: unknown;
}
export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponse>;

export function defaultFetch(): FetchLike {
  const f = (globalThis as { fetch?: unknown }).fetch;
  if (typeof f !== 'function') throw new Error('global fetch is not available (Node 18+ required)');
  return f as FetchLike;
}

/** Value of one cookie from a Cookie header, or null. The value is returned as sent (not decoded). */
export function parseCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

export type SessionLookup =
  | { ok: true; user: { handle: string; displayName: string; role: string | null } }
  | { ok: false; reason: 'no_cookie' | 'rejected' | 'unreachable' | 'bad_response' };

export interface SessionClientOptions {
  /** Full URL of the dashboard's GET /api/game/me. */
  meUrl: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export function meUrlFromEnv(env: Record<string, string | undefined>): string {
  const base = (env.DASHBOARD_BASE_URL || DEFAULT_DASHBOARD_BASE).replace(/\/+$/, '');
  return `${base}/api/game/me`;
}

/** Same response handling as the hub SDK's pullSession(): `{ ok, user: {...} }` or the user object itself. */
function readUser(body: unknown): { handle: string; displayName: string; role: string | null } | null {
  if (body === null || typeof body !== 'object') return null;
  const root = body as Record<string, unknown>;
  if (root.ok === false) return null;
  const u = (root.user !== null && typeof root.user === 'object' ? root.user : root) as Record<string, unknown>;
  const handleRaw =
    (typeof u.handle === 'string' && u.handle.trim()) || (typeof u.username === 'string' && u.username.trim()) || '';
  if (!handleRaw) return null;
  const display = u.display_name ?? u.displayName;
  return {
    handle: handleRaw.toLowerCase(),
    displayName: typeof display === 'string' && display.trim() ? display : handleRaw,
    role: typeof u.role === 'string' && u.role ? u.role : null,
  };
}

export async function lookupSession(
  cookieHeader: string | null | undefined,
  options: SessionClientOptions,
): Promise<SessionLookup> {
  const token = parseCookie(cookieHeader, SESSION_COOKIE);
  if (token === null) return { ok: false, reason: 'no_cookie' };

  const timeoutMs = options.timeoutMs ?? DEFAULT_ME_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? defaultFetch();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([
      doFetch(options.meUrl, {
        method: 'GET',
        headers: { cookie: `${SESSION_COOKIE}=${token}`, accept: 'application/json' },
        signal: controller?.signal,
      }),
      timeout,
    ]);
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'rejected' };
    if (!res.ok) return { ok: false, reason: 'unreachable' };
    const user = readUser(await res.json());
    return user ? { ok: true, user } : { ok: false, reason: 'bad_response' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** Turn the lookup into a seat identity. Guests use the name the client sent. */
export function toIdentity(lookup: SessionLookup, guestName: unknown): Identity {
  if (lookup.ok) {
    return {
      kind: 'user',
      handle: lookup.user.handle,
      name: cleanName(lookup.user.displayName, lookup.user.handle),
      role: lookup.user.role,
    };
  }
  return { kind: 'guest', handle: null, name: cleanName(guestName, 'Guest'), role: null };
}
