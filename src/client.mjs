import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, readFileSync } from 'node:fs';
import { brokerRuntime, daily, localKey, nativeDesktopSelection, nativeDesktopSession, pipe, pipeFor, root, runtime, runtimeProtocol } from './config.mjs';
import { resumableWaits } from './protocol.mjs';
import { sharedEndpoint } from './shared-desktop-host.mjs';

function call(path, data, signal, socketPath = pipe, key = localKey()) {
  return new Promise((resolve, reject) => {
    const connection = request({ socketPath, path, method: data === undefined ? 'GET' : 'POST', signal, agent: false,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(error); }
      });
    });
    connection.once('error', reject);
    connection.end(data === undefined ? undefined : JSON.stringify(data));
  });
}

export async function existingSharedConnection() {
  try {
    const { pid, endpoint } = JSON.parse(readFileSync(nativeDesktopSession, 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0) {
      process.kill(pid, 0);
      return { endpoint: sharedEndpoint(endpoint), desktopTransport: 'official_desktop' };
    }
  } catch (error) {
    if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
  }
  if (existsSync(nativeDesktopSelection)) throw new Error('Open Codex normally and wait for its desktop App Server to connect.');
  const callBroker = (name, key) => call('/invoke', { name, args: {} }, AbortSignal.timeout(8000), pipeFor(brokerRuntime), key);
  const key = readFileSync(join(brokerRuntime, 'control.key'), 'utf8');
  const status = await callBroker('desktop_shared_status', key);
  if (!status.ok || !status.running) throw new Error('The existing shared Codex desktop host is offline.');
  const host = await callBroker('desktop_shared_start', key);
  if (!host.ok || !host.endpoint) throw new Error('Could not obtain the existing shared Codex desktop endpoint.');
  return { endpoint: host.endpoint, desktopTransport: 'bridge_launcher' };
}

function listenerUnavailable(error) {
  return ['ENOENT', 'ECONNREFUSED', 'ENOTDIR', 'EPIPE', 'ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code);
}

async function runningBridge() {
  let state;
  try { state = await call('/health', undefined, AbortSignal.timeout(1500)); }
  catch (error) { if (listenerUnavailable(error)) return null; throw error; }
  if (state.service !== 'agy-codex-bridge') throw new Error('A different or unauthenticated service already owns the bridge endpoint.');
  return state;
}

export async function upgradeDormantBridge() {
  const state = await runningBridge();
  if (!state || state.runtimeProtocol >= runtimeProtocol) return;
  const methods = daily ? ['bridge_shutdown'] : ['desktop_shared_stop', 'bridge_shutdown'];
  for (const name of methods) {
    const result = await call('/invoke', { name, args: {} }, AbortSignal.timeout(20_000));
    if (daily && result.code === 'BRIDGE_BUSY') return;
    if (!result.ok) throw new Error(result.message ?? result.code);
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    const current = await runningBridge();
    if (!current || current.runtimeProtocol >= runtimeProtocol) return;
    await delay(100);
  }
  throw new Error('The previous bridge process did not release its local endpoint.');
}

let boot;
async function ensureRunning() {
  let daemon;
  let startupError;
  // Bounded readiness checks apply only to local process startup, never chat history.
  for (let attempt = 0; attempt < 40; attempt++) {
    if (startupError) throw startupError;
    const state = await runningBridge();
    if (state && !state.stopping) return;
    if (!state && (!daemon || daemon.exitCode !== null || daemon.signalCode !== null)) {
      daemon = spawn(process.execPath, [join(root, 'src', 'daemon.mjs')], {
        detached: true, stdio: 'ignore', windowsHide: true, cwd: runtime
      });
      daemon.on('error', error => { startupError = error; });
      daemon.unref();
    }
    await delay(100);
  }
  throw new Error('The local bridge daemon did not start. Run node src/daemon.mjs in this project to see the startup error.');
}

function ready() {
  if (!boot) boot = ensureRunning().finally(() => { boot = null; });
  return boot;
}

export async function invoke(name, args, signal) {
  const input = { name, args };
  const resume = daily && resumableWaits.has(name);
  const backoff = [100, 250, 500, 1000, 1500, 3000, 6000, 15000, 30000];
  let collisions = 0;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      await ready();
      const result = await call('/invoke', { ...input, ...(attempt && { resumeWait: true }) }, signal);
      if (resume && attempt > 0 && result.code === 'AGY_WAIT_ALREADY_ACTIVE' && collisions < 5) {
        collisions++;
      } else if (!resume || result.code !== 'BRIDGE_STOPPING') {
        return result;
      }
    } catch (error) {
      if (!resume || !listenerUnavailable(error)) throw error;
    }
    await delay(backoff[Math.min(attempt, backoff.length - 1)], undefined, { signal });
  }
}
