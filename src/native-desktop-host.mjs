import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { brokerRuntime, nativeDesktopSession } from './config.mjs';
import { startSharedDesktopHost } from './shared-desktop-host.mjs';

const [savedExecutable, ...args] = process.argv.slice(2);
const executable = existsSync(savedExecutable ?? '') ? savedExecutable : execFileSync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-Command',
  '$app = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; if ($app) { Join-Path $app.InstallLocation "app/resources/codex.exe" }'
], { encoding: 'utf8', windowsHide: true }).trim();
if (!isAbsolute(executable ?? '')) throw new Error('The desktop adapter needs the absolute path to the official Codex CLI.');

const listen = args.findIndex(arg => arg === '--listen' || arg.startsWith('--listen='));
const address = listen < 0 ? 'stdio://' : args[listen].split('=')[1] ?? args[listen + 1];
const desktop = args.includes('app-server') && !!process.env.CODEX_APP_TOOLS_PIPE_PATH && address === 'stdio://' &&
  !args.some(arg => ['-h', '--help', '--print-startup-config', '--startup-sign-out', 'proxy', 'daemon', 'generate-ts', 'generate-json-schema'].includes(arg));

if (!desktop) {
  const child = spawn(executable, args, { stdio: 'inherit', windowsHide: true });
  const [code] = await once(child, 'close');
  process.exitCode = code ?? 1;
} else {
  if (listen >= 0) args.splice(listen, args[listen].includes('=') ? 1 : 2);
  const host = await startSharedDesktopHost({ desktop: { executable, args: args.filter(arg => arg !== '--stdio') } });
  host.forwardDiagnostics(process.stderr);
  const peer = new WebSocket(host.endpoint);
  const registration = JSON.stringify({ pid: process.pid, endpoint: host.endpoint });
  let lines;
  let published = false;
  const removeRegistration = () => {
    try {
      if (readFileSync(nativeDesktopSession, 'utf8') === registration) rmSync(nativeDesktopSession, { force: true });
    } catch (error) { if (error.code !== 'ENOENT') console.error('Could not clear the desktop bridge registration.'); }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { lines?.close(); host.close(); });
  try {
    await once(peer, 'open', { signal: AbortSignal.timeout(5000) });
    let initializeId;
    peer.addEventListener('message', ({ data }) => {
      if (!published && initializeId !== undefined) {
        const reply = JSON.parse(data);
        if (reply.id === initializeId && reply.result) {
          try {
            mkdirSync(brokerRuntime, { recursive: true, mode: 0o700 });
            const temporary = `${nativeDesktopSession}.${process.pid}.tmp`;
            try {
              writeFileSync(temporary, registration, { flag: 'wx', mode: 0o600 });
              renameSync(temporary, nativeDesktopSession);
            } finally { rmSync(temporary, { force: true }); }
            published = true;
          } catch { console.error('The desktop started but its bridge registration could not be saved.'); }
          initializeId = undefined;
        }
      }
      process.stdout.write(`${data}\n`);
    });
    lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on('line', line => {
      if (!line.trim() || peer.readyState !== WebSocket.OPEN) return;
      if (!published) {
        const request = JSON.parse(line);
        if (request.method === 'initialize') initializeId = request.id;
      }
      peer.send(line);
    });
    await Promise.race([once(lines, 'close'), once(peer, 'close'), host.closed]);
  } finally {
    if (published) removeRegistration();
    lines?.close();
    process.stdin.pause();
    peer.close();
    host.close();
    await host.closed;
  }
}
