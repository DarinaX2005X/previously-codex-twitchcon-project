import express, { type Router, type Request } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RuntimeConfig } from './runtime/config.js';
import { ApiError, apiErrorHandler, requestIdentity } from './runtime/errors.js';
import { closedAuthentication, csrfToken, mutationRateLimit, originGuard, requireRole, type AuthenticationPort, type Principal } from './runtime/security.js';
import { RevisionStream } from './runtime/updates.js';

export type RuntimeStatus = {phase: 'starting' | 'migration' | 'ready' | 'stopping' | 'failed'; storage: 'ready' | 'unavailable'; mode: 'local' | 'replay'};
export interface AppOptions {
  config: RuntimeConfig;
  status: RuntimeStatus;
  staticDirectory?: string;
  auth?: AuthenticationPort;
  updates?: RevisionStream;
  authorizeStream?: (principal: Principal) => boolean | Promise<boolean>;
  now?: () => number;
  setupStatus?: (request: Request) => Record<string, unknown> | Promise<Record<string, unknown>>;
  routers?: {auth?: Router; owner?: Router; overlay?: Router; demo?: Router; media?: Router};
}
/** The route registry is the only place feature routers are mounted. */
export function createApp(options: AppOptions) {
  const {config, status} = options;
  const now = options.now ?? Date.now;
  const auth = options.auth ?? closedAuthentication;
  const updates = options.updates ?? new RevisionStream(1000, now);
  const app = express();
  app.disable('x-powered-by'); app.set('trust proxy', false);
  app.use(requestIdentity);
  app.use((_req, res, next) => {
    res.set({'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'"});
    next();
  });
  app.use(originGuard(config.origin));
  app.get('/health', (_req, res) => {res.json({alive: true});});
  app.get('/ready', (_req, res) => {
    const ready = status.phase === 'ready' && status.storage === 'ready';
    res.status(ready ? 200 : 503).json({ready, phase: status.phase, storage: status.storage, configuration: config.missing.length ? 'incomplete' : 'complete'});
  });
  app.get('/api/setup/status', async (req, res, next) => {
    try {res.json({mode: status.mode, runtime: status.phase, storage: status.storage, missing: config.missing, configured: config.missing.length === 0, twitch: {connected: false}, openai: {connected: false, paidCallsEnabled: false}, auth: {available: Boolean(options.routers?.auth), authenticated: false}, ...await options.setupStatus?.(req)});} catch (error) {next(error);}
  });
  app.use((req, _res, next) => {if (status.phase === 'stopping' && !['GET', 'HEAD'].includes(req.method)) next(new ApiError(503, 'shutting_down', 'The application is stopping.', true)); else next();});
  app.use(mutationRateLimit(now));
  app.use(express.json({limit: '64kb', strict: true}));
  if (options.routers?.auth) app.use(options.routers.auth);
  app.use('/api/owner', requireRole('owner', auth, config.sessionSecret, now));
  app.get('/api/owner/csrf', (_req, res, next) => {
    if (!config.sessionSecret) {next(new ApiError(503, 'setup_required', 'Complete local setup before continuing.')); return;}
    res.json({csrfToken: csrfToken(config.sessionSecret, (res.locals.principal as Principal).sessionId)});
  });
  app.get('/api/owner/updates', updates.handler(options.authorizeStream));
  if (options.routers?.owner) app.use('/api/owner', options.routers.owner);
  app.use('/api/overlay', requireRole('overlay', auth, config.sessionSecret, now));
  app.get('/api/overlay/updates', updates.handler(options.authorizeStream));
  if (options.routers?.overlay) app.use('/api/overlay', options.routers.overlay);
  app.use('/api/demo', requireRole('demo', auth, config.sessionSecret, now));
  if (options.routers?.demo) app.use('/api/demo', options.routers.demo);
  if (options.routers?.media) app.use('/api/media', options.routers.media);
  const staticDirectory = resolve(options.staticDirectory ?? 'dist');
  app.use(express.static(staticDirectory, {index: false, dotfiles: 'deny', redirect: false, maxAge: 0}));
  for (const route of ['/', '/setup', '/foundation', '/dock', '/overlay', '/replay']) {
    app.get(route, (_req, res, next) => {
      if (!existsSync(resolve(staticDirectory, 'index.html'))) {next(new ApiError(503, 'build_required', 'Build the local application before starting it.')); return;}
      res.sendFile(resolve(staticDirectory, 'index.html'));
    });
  }
  app.use((_req, _res, next) => next(new ApiError(404, 'not_found', 'This route does not exist.')));
  app.use(apiErrorHandler);
  return app;
}
