import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { ApiError } from './errors.js';

export type Role = 'owner' | 'overlay' | 'demo';
export type Principal = {role: Role; actorId: string; channelId: string; runId: string; sessionId: string; expiresAtMs: number};
export interface AuthenticationPort { authenticate(request: Request, role: Role): Principal | null | Promise<Principal | null> }
export const closedAuthentication: AuthenticationPort = {authenticate: () => null};
export const isMutation = (method: string) => !['GET', 'HEAD', 'OPTIONS'].includes(method);
export function originGuard(origin: string): RequestHandler {
  const host = new URL(origin).host;
  return (req, _res, next) => {
    if (req.headers.host !== host || (req.headers.origin !== undefined && req.headers.origin !== origin) || (isMutation(req.method) && req.headers.origin !== origin)) {
      next(new ApiError(403, 'origin_rejected', 'This request is not from the local application.')); return;
    }
    const oauthReturn = req.method === 'GET' && req.path === '/auth/twitch/callback' && req.headers['sec-fetch-mode'] === 'navigate';
    if (req.headers['sec-fetch-site'] === 'cross-site' && !oauthReturn) { next(new ApiError(403, 'origin_rejected', 'This request is not from the local application.')); return; }
    next();
  };
}
export function csrfToken(secret: string, sessionId: string): string {
  return createHmac('sha256', secret).update('previously:csrf:').update(sessionId).digest('base64url');
}
export function requireRole(role: Role, auth: AuthenticationPort, secret?: string, now: () => number = Date.now): RequestHandler {
  return async (req, res, next) => {
    try {
      const principal = await auth.authenticate(req, role);
      if (!principal || principal.expiresAtMs <= now()) throw new ApiError(401, 'session_required', 'Sign in to continue.');
      if (principal.role !== role || ((role === 'demo') !== (principal.runId !== 'live'))) throw new ApiError(403, 'role_forbidden', 'This session cannot access that resource.');
      if (isMutation(req.method)) {
        const supplied = req.headers['x-csrf-token'];
        const expected = secret ? csrfToken(secret, principal.sessionId) : '';
        if (typeof supplied !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(supplied) || !expected || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new ApiError(403, 'csrf_rejected', 'Reload the application before trying again.');
        if (role === 'owner' && (typeof req.headers['idempotency-key'] !== 'string' || !/^[\w.-]{8,128}$/.test(req.headers['idempotency-key']))) throw new ApiError(400, 'idempotency_required', 'An idempotency key is required.');
      }
      res.locals.principal = principal; next();
    } catch (error) { next(error); }
  };
}
export function mutationRateLimit(now: () => number = Date.now, limit = 120): RequestHandler {
  let start = now(); let count = 0;
  return (req, res, next) => {
    if (!isMutation(req.method)) { next(); return; }
    if (now() - start >= 60_000) { start = now(); count = 0; }
    if (++count > limit) { res.setHeader('Retry-After', '60'); next(new ApiError(429, 'rate_limited', 'Please wait before trying again.', true)); return; }
    next();
  };
}
