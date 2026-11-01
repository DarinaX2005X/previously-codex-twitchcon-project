import type { ErrorRequestHandler, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable = false) { super(message); }
}
export const requestIdentity: RequestHandler = (_req, res, next) => {
  res.locals.requestId = randomUUID(); res.setHeader('X-Request-ID', res.locals.requestId as string); next();
};
export const apiErrorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (res.headersSent) { res.end(); return; }
  let safe = error instanceof ApiError ? error : new ApiError(500, 'internal_error', 'The request could not be completed.');
  if (typeof error === 'object' && error !== null && 'type' in error) {
    if (error.type === 'entity.too.large') safe = new ApiError(413, 'body_too_large', 'The request exceeds its size limit.');
    if (error.type === 'entity.parse.failed') safe = new ApiError(400, 'invalid_json', 'The request body must be valid JSON.');
  }
  res.status(safe.status).json({error: {code: safe.code, message: safe.message, retryable: safe.retryable, requestId: res.locals.requestId}});
};
