import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.error('Local certificate setup requires Windows CurrentUser certificate stores.');
  process.exitCode = 1;
} else {
  const script = fileURLToPath(new URL('./local-https.ps1', import.meta.url));
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {stdio: 'inherit', windowsHide: true});
  process.exitCode = result.status ?? 1;
}
