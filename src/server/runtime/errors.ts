import type { ErrorRequestHandler, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { StorageError } from '../storage/database.js';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable = false) { super(message); }
}
export const requestIdentity: RequestHandler = (_req, res, next) => {
  res.locals.requestId = randomUUID(); res.setHeader('X-Request-ID', res.locals.requestId as string); next();
};
export const apiErrorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (res.headersSent) { res.end(); return; }
  let safe = error instanceof ApiError ? error : new ApiError(500, 'internal_error', 'The request could not be completed.');
  if (error instanceof StorageError) {
    const mapped = {
      inaccessible: [404, 'This resource is unavailable.'],
      conflict: [409, 'This resource changed. Refresh before trying again.'],
      invalid_input: [400, 'The request is invalid.'],
      save_failed: [503, 'The change could not be saved.'],
      key_setup: [503, 'Restore the storage encryption configuration before continuing.'],
      capacity: [429, 'The configured capacity has been reached.'],
      paid_disabled: [503, 'Paid provider work is disabled.'],
    } as const;
    const [status, message] = mapped[error.code];
    safe = new ApiError(status, error.code, message, error.code === 'save_failed' || error.code === 'capacity');
  }
  if (typeof error === 'object' && error !== null && 'type' in error) {
    if (error.type === 'entity.too.large') safe = new ApiError(413, 'body_too_large', 'The request exceeds its size limit.');
    if (error.type === 'entity.parse.failed') safe = new ApiError(400, 'invalid_json', 'The request body must be valid JSON.');
  }
  res.status(safe.status).json({error: {code: safe.code, message: safe.message, retryable: safe.retryable, requestId: res.locals.requestId}});
};
