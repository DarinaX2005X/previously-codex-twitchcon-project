import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

const optionalText = z.string().trim().max(8192).optional();
const envSchema = z.object({
  PORT: z.coerce.number().int().refine(value => value === 4317).default(4317),
  HOST: z.enum(['127.0.0.1', 'localhost']).default('127.0.0.1'),
  LOCAL_ORIGIN: z.literal('https://localhost:4317').default('https://localhost:4317'),
  DATA_DIR: z.string().min(1).default('.data'),
  LOCAL_TLS_PFX: z.string().min(1).default('.data/tls/localhost.pfx'),
  LOCAL_TLS_PASSPHRASE: optionalText,
  SESSION_SECRET: optionalText,
  TOKEN_ENCRYPTION_KEY: optionalText,
  PUBLISH_SHARED_SECRET: optionalText,
  TWITCH_CLIENT_ID: optionalText,
  TWITCH_CLIENT_SECRET: optionalText,
  TWITCH_CHANNEL_LOGIN: z.string().regex(/^[a-zA-Z0-9_]{1,25}$/).optional(),
  TWITCH_REDIRECT_URI: z.literal('https://localhost:4317/auth/twitch/callback').default('https://localhost:4317/auth/twitch/callback'),
  TWITCH_MARKERS_ENABLED: z.enum(['true', 'false']).default('false'),
  OPENAI_API_KEY: optionalText,
  OPENAI_PAID_CALLS_ENABLED: z.enum(['true', 'false']).default('false'),
  RECAP_PUBLIC_ORIGIN: z.url().refine(value => new URL(value).protocol === 'https:').optional(),
  RECAP_LANGUAGE: z.enum(['en', 'ru']).default('en'),
  PUBLICATION_DELAY_SECONDS: z.coerce.number().int().min(60).max(90).default(75),
});

export class ConfigurationError extends Error {
  constructor(readonly fields: string[]) { super(`Invalid configuration: ${fields.join(', ')}`); this.name = 'ConfigurationError'; }
}

/** Parsing errors reveal setting names only. Never serialize this configuration into HTTP responses. */
export function loadConfig(input: NodeJS.ProcessEnv, cwd = process.cwd()) {
  const cleaned = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value.trim() !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) throw new ConfigurationError([...new Set(parsed.error.issues.map(issue => String(issue.path[0]))) ]);
  const env = parsed.data;
  const invalid: string[] = [];
  for (const name of ['SESSION_SECRET', 'PUBLISH_SHARED_SECRET', 'LOCAL_TLS_PASSPHRASE'] as const) {
    if (env[name] && Buffer.byteLength(env[name]) < 32) invalid.push(name);
  }
  if (env.TOKEN_ENCRYPTION_KEY && (!/^[A-Za-z0-9+/]{43}=$/.test(env.TOKEN_ENCRYPTION_KEY) || Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64').length !== 32)) invalid.push('TOKEN_ENCRYPTION_KEY');
  if (invalid.length) throw new ConfigurationError(invalid);
  const required = ['LOCAL_TLS_PASSPHRASE', 'SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_CHANNEL_LOGIN', 'OPENAI_API_KEY', 'RECAP_PUBLIC_ORIGIN', 'PUBLISH_SHARED_SECRET'] as const;
  const missing = required.filter(name => !env[name]);
  const tlsPfx = resolve(cwd, env.LOCAL_TLS_PFX);
  return {
    port: env.PORT, host: env.HOST, origin: env.LOCAL_ORIGIN,
    dataDir: resolve(cwd, env.DATA_DIR), tlsPfx, tlsPassphrase: env.LOCAL_TLS_PASSPHRASE,
    sessionSecret: env.SESSION_SECRET, tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
    publishSharedSecret: env.PUBLISH_SHARED_SECRET,
    twitch: {clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET, channelLogin: env.TWITCH_CHANNEL_LOGIN, redirectUri: env.TWITCH_REDIRECT_URI, markerEnabled: env.TWITCH_MARKERS_ENABLED === 'true'},
    openaiApiKey: env.OPENAI_API_KEY, paidCallsEnabled: env.OPENAI_PAID_CALLS_ENABLED === 'true', publicOrigin: env.RECAP_PUBLIC_ORIGIN,
    language: env.RECAP_LANGUAGE, publicationDelaySeconds: env.PUBLICATION_DELAY_SECONDS,
    missing: [...missing, ...(!existsSync(tlsPfx) ? ['LOCAL_TLS_PFX'] : [])],
  };
}
export type RuntimeConfig = ReturnType<typeof loadConfig>;

/** Process environment wins; reading the file never logs or rewrites credentials. */
export function readLocalEnvironment(cwd = process.cwd(), environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const path = resolve(cwd, '.env');
  return {...(existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {}), ...environment};
}
