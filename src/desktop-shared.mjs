import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { invoke, upgradeDormantBridge } from './client.mjs';
import { nativeDesktopSelection } from './config.mjs';
import { sharedEndpoint } from './shared-desktop-host.mjs';

async function desktopExecutable() {
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$app = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; if ($app) { Join-Path $app.InstallLocation "app/ChatGPT.exe" }'], { windowsHide: true });
  const executable = stdout.trim();
  if (!executable || !(await stat(executable)).isFile()) throw new Error('Could not find the installed Windows ChatGPT desktop app.');
  return executable;
}

async function existingDesktopIsRunning(executable) {
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$app = Get-CimInstance Win32_Process -Filter "Name=\'ChatGPT.exe\'" | Where-Object { $_.ExecutablePath -ieq $env:AGY_BRIDGE_DESKTOP_EXE -and $_.CommandLine -notmatch "(?:^|\\s)--type=" } | Select-Object -First 1; if ($app) { "running" }'],
  { env: { ...process.env, AGY_BRIDGE_DESKTOP_EXE: executable }, windowsHide: true });
  return stdout.trim() === 'running';
}

const [action, threadId] = process.argv.slice(2);
const validThread = !threadId || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId);
async function launchDesktop(executable, env, args) {
  const desktop = spawn(executable, args, { env, detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => { desktop.once('spawn', resolve); desktop.once('error', reject); });
  desktop.unref();
}

async function launchRegisteredDesktop(threadId) {
  const command = threadId
    ? 'Start-Process -FilePath $env:AGY_BRIDGE_CODEX_URI -ErrorAction Stop'
    : [
        '$package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1',
        "if (-not $package) { throw 'The official ChatGPT desktop package is not installed.' }",
        '$appId = $package.PackageFamilyName + "!App"',
        String.raw`Start-Process -FilePath explorer.exe -ArgumentList ("shell:AppsFolder\" + $appId) -ErrorAction Stop`
      ].join('; ');
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: threadId ? { ...process.env, AGY_BRIDGE_CODEX_URI: `codex://threads/${threadId}` } : process.env,
    windowsHide: true
  });
}

try {
  if (action === 'stop' && !threadId) {
    const result = await invoke('desktop_shared_stop', {});
    if (!result.ok) throw new Error(result.message ?? result.code);
    console.log(JSON.stringify({ ok: true, stopped: result.stopped }));
  } else if (action === 'status' && validThread) {
    const result = await invoke('desktop_shared_status', threadId ? { threadId } : {});
    if (!result.ok) throw new Error(result.message ?? result.code);
    console.log(JSON.stringify(result));
  } else if ((action === 'open' && validThread) || (action === 'startup' && !threadId)) {
    if (existsSync(nativeDesktopSelection)) {
      const { adapter } = JSON.parse(readFileSync(nativeDesktopSelection, 'utf8'));
      if (!isAbsolute(adapter ?? '') || !existsSync(adapter)) throw new Error('The registered Codex desktop adapter is missing. Reinstall or remove it.');
      await launchRegisteredDesktop(threadId);
      console.log(JSON.stringify({ ok: true, state: 'normal_desktop_launch', ...(threadId && { threadId }) }));
      process.exit(0);
    }
    const executable = await desktopExecutable();
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('CODEX_') || name === 'OPENAI_API_KEY') delete env[name];
    const args = threadId ? [`codex://threads/${threadId}`] : [];
    const running = await existingDesktopIsRunning(executable);
    if (running) {
      const status = await invoke('desktop_shared_status', {});
      if (!status.ok) throw new Error(status.message ?? status.code);
      if (!status.running || status.connectedClients < 2) {
        throw new Error('Codex 当前未连接到这个协作桥。等当前工作完成后，从托盘彻底退出 Codex，再通过协作桥的启动命令打开。');
      }
      if (threadId) {
        const target = await invoke('desktop_shared_status', { threadId });
        if (!target.ok) throw new Error(target.message ?? target.code);
      }
      if (action === 'open') await launchDesktop(executable, env, args);
      console.log(JSON.stringify({ ok: true, state: 'desktop_already_connected', ...(threadId && { threadId }) }));
    } else {
      await upgradeDormantBridge();
      const result = await invoke('desktop_shared_start', threadId ? { threadId } : {});
      if (!result.ok) throw new Error(result.message ?? result.code);
      env.CODEX_APP_SERVER_WS_URL = sharedEndpoint(result.endpoint);
      await launchDesktop(executable, env, args);
      const ready = await invoke('desktop_shared_wait', {});
      if (!ready.ok) throw new Error(ready.message ?? ready.code);
      const catalogue = await invoke('codex_list_projects', {});
      if (!catalogue.ok) throw new Error(catalogue.message ?? catalogue.code);
      console.log(JSON.stringify({ ok: true, state: 'desktop_connected', registeredWorkspaces: catalogue.projects.filter(project => project.sidebarStatus === 'registered').length, ...(threadId && { threadId }) }));
    }
  } else {
    throw new Error('Usage: node src/desktop-shared.mjs open [registered-chat-id] | startup | status [registered-chat-id] | stop');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
