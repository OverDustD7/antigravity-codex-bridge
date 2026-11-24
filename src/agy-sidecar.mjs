import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { invoke } from './client.mjs';
import { formatReceiptNotice } from './agy-notice.mjs';
import { watchAntigravityHost } from './agy-host.mjs';

function invokeAgentApi(command, args, eventId) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    let diagnostics = '';
    let started = false;
    child.once('spawn', () => { started = true; });
    child.stdout.setEncoding('utf8').on('data', text => { output = (output + text).slice(0, 4096); });
    child.stderr.setEncoding('utf8').on('data', text => { diagnostics = (diagnostics + text).slice(0, 4096); });
    const timer = setTimeout(() => { child.kill(); resolve('uncertain'); }, 20_000);
    child.on('error', error => {
      clearTimeout(timer);
      if (error.code !== 'ENOENT') console.error(`Receipt ${eventId}: agentapi could not start (${error.code ?? 'unknown'}).`);
      resolve(error.code === 'ENOENT' ? 'missing' : 'cli_error');
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (!started) return;
      let reportedError = false;
      try { reportedError = !!JSON.parse(output)?.error; } catch {}
      if (code === 0 && !reportedError) { resolve('cli_accepted'); return; }
      const missingHost = /ANTIGRAVITY_LS_ADDRESS.*not set/i.test(output + diagnostics);
      console.error(`Receipt ${eventId}: agentapi failed (${missingHost ? 'sidecar host context missing' : `exit ${code}`}).`);
      resolve('cli_error');
    });
  });
}

async function sendNotice(job, prompt) {
  const args = ['send-message', job.conversationId, prompt];
  const preferred = await invokeAgentApi('agentapi', args, job.eventId);
  if (preferred !== 'missing') return preferred;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const agy = join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
    const fallback = await invokeAgentApi(agy, ['agentapi', ...args], job.eventId);
    if (fallback !== 'missing') return fallback;
  }
  console.error(`Receipt ${job.eventId}: neither the native agentapi command nor the installed Antigravity CLI is available.`);
  return 'cli_error';
}

const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop.abort());
watchAntigravityHost(stop);
try {
  const recovered = await invoke('desktop_recover_deliveries', {}, stop.signal);
  if (!recovered.ok && recovered.code !== 'TOOL_UNAVAILABLE') throw new Error(recovered.code);
  const resumable = recovered.ok;
  while (!stop.signal.aborted) {
    const job = await invoke('desktop_take', { resumable }, stop.signal);
    if (!job.ok) throw new Error(job.code);
    const details = await invoke('codex_inbox', { threadId: job.threadId, eventId: job.eventId }, stop.signal);
    if (!details.ok) throw new Error(details.code);
    const prompt = formatReceiptNotice(job, details.events[0]);
    if (resumable) {
      const started = await invoke('desktop_delivery_start', { eventId: job.eventId }, stop.signal);
      if (!started.ok) throw new Error(started.code);
      if (started.skipped) continue;
    }
    stop.signal.throwIfAborted();
    const outcome = await sendNotice(job, prompt);
    const receipt = await invoke('desktop_finish', { eventId: job.eventId, outcome });
    if (!receipt.ok) throw new Error(receipt.code);
  }
} catch (error) {
  if (!stop.signal.aborted) { console.error(`Bridge sidecar: ${error.message}`); process.exitCode = 1; }
} finally {
  stop.abort();
}
