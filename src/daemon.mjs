import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { Bridge } from './bridge.mjs';
import { DailyBridge } from './daily-bridge.mjs';
import { daily, localKey, pipe, runtime, runtimeProtocol } from './config.mjs';
import { Store } from './store.mjs';
import { resumableWaits } from './protocol.mjs';

const key = Buffer.from(`Bearer ${localKey()}`);
let bridge;
let store;
let stopping = false;
const waiting = new Map();
const stoppingResult = { ok: false, code: 'BRIDGE_STOPPING' };

function send(response, status, body) {
  if (response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  const auth = Buffer.from(request.headers.authorization ?? '');
  if (auth.length !== key.length || !timingSafeEqual(auth, key)) return send(response, 403, { ok: false, code: 'LOCAL_AUTH_REQUIRED' });
  if (request.url === '/health' && request.method === 'GET') return send(response, 200, { ok: true, service: 'agy-codex-bridge', runtimeProtocol, stopping });
  if (request.url !== '/invoke' || request.method !== 'POST') return send(response, 404, { ok: false, code: 'ROUTE_NOT_FOUND' });
  const cancel = new AbortController();
  response.on('close', () => { waiting.delete(response); cancel.abort(); });
  try {
    const input = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 256_000) return send(response, 413, { ok: false, code: 'REQUEST_TOO_LARGE' });
      input.push(chunk);
    }
    const { name, args, resumeWait } = JSON.parse(Buffer.concat(input).toString('utf8'));
    if (stopping) return send(response, 503, stoppingResult);
    const restart = daily && name === 'bridge_restart';
    if (name === 'bridge_shutdown' || restart) {
      if (bridge.desktopHost || bridge.startingDesktopHost) {
        return send(response, 200, { ok: false, code: 'BRIDGE_SHARED_DESKTOP_RUNNING', message: 'Close or stop the dedicated shared desktop host before shutting down the bridge.' });
      }
      if (bridge.executingActions.size || bridge.locks.size ||
        (!restart && store.get("SELECT 1 FROM turns WHERE status = 'inProgress'")) ||
        store.get("SELECT 1 FROM desktop_dispatch WHERE state IN ('claimed','accepted')") ||
        store.get("SELECT 1 FROM push_deliveries WHERE state IN ('reserved','claimed')")) {
        return send(response, 200, { ok: false, code: 'BRIDGE_BUSY', message: 'The bridge has active work.' });
      }
      stopping = true;
      server.close(() => bridge.close());
      for (const [subscriber, controller] of waiting) {
        if (!subscriber.headersSent) send(subscriber, 503, stoppingResult);
        controller.abort();
      }
      return send(response, 200, { ok: true, state: 'stopping' });
    }
    if (resumableWaits.has(name)) waiting.set(response, cancel);
    if (daily && resumeWait === true && name === 'codex_wait' && typeof args?.conversationId === 'string' &&
      typeof args?.threadIds?.[0] === 'string' && store.get('SELECT 1 FROM daily_watches WHERE conversation=? AND thread=? AND enabled=0', args.conversationId, args.threadIds[0])) {
      return send(response, 200, { ok: false, code: 'AGY_WAIT_PAUSED', message: 'This conversation paused its receipt watch.' });
    }
    const result = await bridge.invoke(name, args, cancel.signal);
    waiting.delete(response);
    if (cancel.signal.aborted) return;
    if (daily && name === 'codex_wait' && args.conversationId && result.event?.kind === 'agy_message') {
      response.once('finish', () => bridge.messageReturned(args.conversationId, result.event));
    }
    send(response, 200, { ok: true, ...result });
  } catch (error) {
    if (!cancel.signal.aborted) send(response, 200, { ok: false, code: error.code ?? 'BRIDGE_ERROR', message: error.message });
  }
});

server.on('error', error => {
  if (error.code !== 'EADDRINUSE') console.error(`Bridge startup failed: ${error.message}`);
  process.exitCode = 1;
});
server.listen(pipe, () => {
  try {
    store = new Store(join(runtime, 'bridge.sqlite'));
    bridge = daily ? new DailyBridge(store) : new Bridge(store);
    if (daily) bridge.restorePending();
  } catch (error) {
    console.error(`Bridge startup failed: ${error.message}`);
    server.close();
    process.exitCode = 1;
  }
});
process.on('SIGTERM', () => {
  bridge?.close();
  server.closeAllConnections();
  server.close();
});
process.on('SIGINT', () => {
  bridge?.close();
  server.closeAllConnections();
  server.close();
});
