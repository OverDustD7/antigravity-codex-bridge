import { spawn } from 'node:child_process';

const waitForHost = `
$ErrorActionPreference = 'Stop'
$parentId = [int]$env:BRIDGE_AGY_SIDECAR_PARENT
for ($i = 0; $i -lt 4 -and $parentId -gt 0; $i++) {
    $owner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $parentId)
    if (-not $owner) { exit 0 }
    if ($owner.Name -eq 'language_server.exe') {
        Wait-Process -Id $owner.ProcessId -ErrorAction SilentlyContinue
        exit 0
    }
    if ($owner.Name -notin @('cmd.exe', 'Antigravity.exe', 'node.exe')) { exit 2 }
    $parentId = $owner.ParentProcessId
}
exit 2
`;

export function watchAntigravityHost(stop) {
  if (process.platform !== 'win32' || !process.env.ANTIGRAVITY_LS_ADDRESS) return;
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP'].map(name => [name, process.env[name] ?? '']));
  env.BRIDGE_AGY_SIDECAR_PARENT = String(process.ppid);
  const watcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', waitForHost], {
    env, stdio: 'ignore', windowsHide: true
  });
  watcher.once('error', () => console.error('Could not watch the Antigravity host process.'));
  watcher.once('exit', code => { if (code === 0) stop.abort(); });
  stop.signal.addEventListener('abort', () => watcher.kill(), { once: true });
}
