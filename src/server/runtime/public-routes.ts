import {Router} from 'express';
import {ApiError} from './errors.js';
import {AUTHORED_REPLAY_IDS} from '../replay/export.js';

/** The local reading surface forwards only bounded public GETs to its configured cloud. */
export function createPublicReadRouter(options: {
  cloudOrigin?: string;
  authored?: (request: Request) => Promise<Response>;
  fetch?: typeof fetch;
}) {
  const router = Router();
  router.use(async (req, res, next) => {
    try {
      if (req.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'This address is read only.');
      const path = req.path;
      if (!/^\/(?:channels\/[a-z0-9_]{1,25}|sessions\/[A-Za-z0-9_.:%-]{1,200}|replays(?:\/[A-Za-z0-9_-]{1,120}(?:\/assets\/[A-Za-z0-9_-]{1,120})?)?)$/.test(path)) throw new ApiError(404, 'not_found', 'This recap address does not exist.');
      const query = new URLSearchParams();
      for (const name of ['untilMs', 'revision']) {
        const value = req.query[name];
        if (value !== undefined) {
          if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) throw new ApiError(400, 'invalid_request', 'The reading position is invalid.');
          query.set(name, value);
        }
      }
      const suffix = query.size ? `?${query}` : '';
      const headers = new Headers();
      if (req.headers.range) headers.set('Range', req.headers.range);
      const authoredId = /^\/replays\/([A-Za-z0-9_-]{1,120})(?:\/|$)/.exec(path)?.[1];
      const authored = options.authored && (!!authoredId && AUTHORED_REPLAY_IDS.includes(authoredId) || path === '/replays' && !options.cloudOrigin);
      let response: Response;
      if (authored) response = await options.authored!(new Request(`https://local-replay.invalid/api/public${path}${suffix}`, {headers}));
      else {
        if (!options.cloudOrigin) throw new ApiError(503, 'cloud_unconfigured', 'Connect public publishing to open the live recap.');
        const origin = new URL(options.cloudOrigin);
        if (origin.protocol !== 'https:') throw new ApiError(503, 'cloud_unconfigured', 'Public publishing requires HTTPS.');
        response = await (options.fetch ?? fetch)(new URL(`/api/public${path}${suffix}`, origin), {headers, cache: 'no-store', signal: AbortSignal.timeout(5000), redirect: 'error'});
        if(path==='/replays'&&options.authored&&[404,410].includes(response.status)){
          await response.body?.cancel();
          response=await options.authored(new Request('https://local-replay.invalid/api/public/replays'));
        }
      }
      const reader = response.body?.getReader(), parts: Uint8Array[] = []; let length = 0;
      if (reader) for (;;) {const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 3_500_000) {await reader.cancel(); throw new ApiError(502, 'public_response_too_large', 'The public recap could not be loaded.');} parts.push(part.value);}
      res.status(response.status).set('Cache-Control', 'no-store');
      for (const name of ['Content-Type', 'Content-Range', 'Accept-Ranges']) {const value = response.headers.get(name); if (value) res.set(name, value);}
      res.send(Buffer.concat(parts));
    } catch (error) {next(error instanceof ApiError ? error : new ApiError(503, 'public_unavailable', 'The live recap is temporarily unavailable.', true));}
  });
  return router;
}
