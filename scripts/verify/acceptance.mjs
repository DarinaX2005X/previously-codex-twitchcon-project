// Sequential runner: the official Twitch CLI owns a fixed local RPC port (44747).
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const mode = process.argv[2] ?? '--all';
if (!['--all', '--fixtures', '--cli'].includes(mode)) throw new Error('Use --all, --fixtures or --cli');
const files = [
  'tests/integration/acceptance-speech.test.ts', 'tests/integration/acceptance-restart.test.ts',
  'tests/integration/acceptance-eventsub-privacy.test.ts', 'tests/integration/acceptance-runtime-privacy.test.ts',
  'tests/integration/acceptance-chat-batch.test.ts',
  'tests/integration/live-pipeline.test.ts', 'tests/integration/owner-service.test.ts',
  'tests/integration/owner-routes.test.ts', 'tests/integration/overlay-routes.test.ts',
  'tests/integration/twitch-runtime.test.ts', 'tests/twitch/effects.test.ts', 'tests/twitch/eventsub.test.ts',
  'tests/reliability/eventsub-overflow.test.ts',
];
const cli = process.env.TWITCH_CLI_PATH ?? resolve(root, '../tools/twitch/twitch-cli_1.1.24_Windows_x86_64/twitch.exe');
if (mode !== '--fixtures' && !existsSync(cli)) throw new Error('Set TWITCH_CLI_PATH to the installed official CLI executable. The CLI acceptance must not silently skip.');
async function run(paths, env = process.env) {
  const child = spawn(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', ...paths], {cwd: root, env, windowsHide: true, stdio: 'inherit'});
  const code = await new Promise((done, reject) => {child.once('error', reject); child.once('exit', done);});
  if (code !== 0) process.exit(code ?? 1);
}
if (mode !== '--cli') await run(files);
if (mode !== '--fixtures') await run(['tests/integration/acceptance-cli.test.ts'], {...process.env, TWITCH_CLI_PATH: cli});
