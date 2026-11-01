import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp, type RuntimeStatus } from './app.js';
import { createStorage, StorageError } from './storage/index.js';
import { ConfigurationError, loadConfig, readLocalEnvironment, type RuntimeConfig } from './runtime/config.js';
import { acquireInstanceLock, InstanceLockError } from './runtime/instance-lock.js';
import { RevisionStream } from './runtime/updates.js';
import { BoundedScheduler } from './runtime/scheduler.js';

export async function startRuntime(options: {config?: RuntimeConfig; cwd?: string; replay?: boolean; recoverStaleLock?: boolean} = {}) {
  const cwd = options.cwd ?? process.cwd();
  const config = options.config ?? loadConfig(readLocalEnvironment(cwd), cwd);
  if (!config.tlsPassphrase || config.missing.includes('LOCAL_TLS_PFX')) throw new ConfigurationError(['LOCAL_TLS_PFX', 'LOCAL_TLS_PASSPHRASE']);
  const lock = acquireInstanceLock(config.dataDir, options.recoverStaleLock);
  const status: RuntimeStatus = {phase: 'migration', storage: 'unavailable', mode: options.replay ? 'replay' : 'local'};
  let storage: ReturnType<typeof createStorage> | undefined;
  try {
    storage = createStorage({path: resolve(config.dataDir, 'previously.sqlite'), ...(config.tokenEncryptionKey ? {encryptionKey: Buffer.from(config.tokenEncryptionKey, 'base64')} : {})});
    status.storage = 'ready';
  } catch (error) {lock.release(); throw error;}
  const updates = new RevisionStream();
  // No live lanes are installed before authenticated adapters and explicit paid-call approval.
  const scheduler = new BoundedScheduler(storage.repository, []);
  const app = createApp({config, status, updates, staticDirectory: resolve(cwd, 'dist')});
  let server: ReturnType<typeof createServer>;
  try {server = createServer({pfx: readFileSync(config.tlsPfx), passphrase: config.tlsPassphrase, minVersion: 'TLSv1.2'}, app);}
  catch {storage.close(); lock.release(); throw new ConfigurationError(['LOCAL_TLS_PFX', 'LOCAL_TLS_PASSPHRASE']);}
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  try {
    await new Promise<void>((done, reject) => {server.once('error', reject); server.listen(config.port, config.host, () => {server.off('error', reject); done();});});
    status.phase = 'ready'; scheduler.start();
  } catch {updates.close(); storage.close(); lock.release(); throw new Error('The local HTTPS port is unavailable.');}
  let shutdown: Promise<void> | undefined;
  const close = () => {
    if (shutdown) return shutdown;
    status.phase = 'stopping'; updates.close();
    const listenerClosed = new Promise<void>(done => server.close(() => done()));
    shutdown = (async () => {
      await scheduler.stop();
      server.closeAllConnections(); await listenerClosed;
      storage.close(); lock.release();
    })();
    return shutdown;
  };
  return {app, server, status, close};
}

async function main() {
  try {
    const runtime = await startRuntime({replay: process.argv.includes('--replay'), recoverStaleLock: process.argv.includes('--recover-stale-lock')});
    console.log('Previously is available at https://localhost:4317. Provider connections remain inactive.');
    const stop = () => {void runtime.close().catch(() => {console.error('Shutdown could not complete cleanly.'); process.exitCode = 1;});};
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) {
    if (error instanceof ConfigurationError) console.error(`${error.message}. Run npm run setup:local or correct those settings.`);
    else if (error instanceof InstanceLockError || error instanceof StorageError) console.error(error.message);
    else console.error('Previously could not start. Check the local port and writable data directory.');
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
