import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createServer, request } from 'node:http';
import { createInterface } from 'node:readline';
import { codexExecutable } from './codex.mjs';
import { root } from './config.mjs';

const address = '127.0.0.1';
const websocketPath = /^\/codex-bridge\/[0-9a-f]{64}$/;

export function sharedEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'ws:' || url.hostname !== address || !url.port || url.username || url.password || url.search || url.hash || !websocketPath.test(url.pathname)) {
    throw new Error('The shared Codex desktop endpoint must come from the local bridge launcher.');
  }
  return url.href;
}

function openNative(home, token) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('CODEX_') || name === 'OPENAI_API_KEY') delete env[name];
  if (home) env.CODEX_HOME = home;
  const hash = createHash('sha256').update(token).digest('hex');
  return spawn(codexExecutable(), ['app-server', '--listen', `ws://${address}:0`, '--ws-auth', 'capability-token', '--ws-token-sha256', hash, '-c', 'thread_unload_delay_secs=1'], {
    cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
  });
}

function nativePort(child) {
  const lines = createInterface({ input: child.stderr });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail('The shared Codex App Server did not announce its listener.'), 10_000);
    function cleanup() { clearTimeout(timer); lines.removeListener('line', onLine); }
    function fail(message) { cleanup(); reject(new Error(message)); }
    function onLine(line) {
      const match = /^\s*listening on: ws:\/\/127\.0\.0\.1:(\d+)$/.exec(line);
      if (match) { cleanup(); resolve(Number(match[1])); }
    }
    child.once('error', () => fail('Could not start the official Codex App Server.'));
    child.once('exit', code => fail(`The shared Codex App Server closed during startup (${code}).`));
    lines.on('line', onLine);
  });
}

export async function startSharedDesktopHost({ codexHome } = {}) {
  const token = randomBytes(32).toString('hex');
  const path = `/codex-bridge/${randomBytes(32).toString('hex')}`;
  const child = openNative(codexHome, token);
  const sockets = new Set();
  const connected = new Set();
  const events = new EventEmitter();
  const gateway = createServer((_, response) => response.writeHead(404).end());
  const close = () => {
    gateway.close();
    for (const socket of sockets) socket.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };
  child.once('exit', close);
  try {
    const port = await nativePort(child);
    gateway.on('upgrade', (incoming, peer, peerHead) => {
      if (incoming.url !== path || incoming.headers.origin || incoming.headers.upgrade?.toLowerCase() !== 'websocket') {
        peer.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }
      sockets.add(peer);
      peer.once('close', () => { sockets.delete(peer); connected.delete(peer); });
      const upstream = request({
        host: address, port, method: 'GET', path: '/', headers: {
          Connection: 'Upgrade', Upgrade: 'websocket', Authorization: `Bearer ${token}`,
          'Sec-WebSocket-Key': incoming.headers['sec-websocket-key'] ?? '',
          'Sec-WebSocket-Version': incoming.headers['sec-websocket-version'] ?? ''
        }
      });
      upstream.setTimeout(5000, () => upstream.destroy());
      upstream.once('error', () => peer.destroy());
      upstream.once('response', response => { response.resume(); peer.destroy(); });
      peer.once('error', () => upstream.destroy());
      peer.once('close', () => upstream.destroy());
      upstream.once('upgrade', (response, native, nativeHead) => {
        if (peer.destroyed || !response.headers['sec-websocket-accept']) { native.destroy(); peer.destroy(); return; }
        native.once('error', () => peer.destroy());
        native.once('close', () => peer.destroy());
        peer.once('close', () => native.destroy());
        peer.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${response.headers['sec-websocket-accept']}\r\n\r\n`);
        if (peerHead.length) native.write(peerHead);
        if (nativeHead.length) peer.write(nativeHead);
        native.pipe(peer).pipe(native);
        connected.add(peer);
        events.emit('connected');
      });
      upstream.end();
    });
    gateway.listen(0, address);
    await once(gateway, 'listening');
    return {
      endpoint: `ws://${address}:${gateway.address().port}${path}`, close, closed: once(child, 'close'),
      get connectionCount() { return connected.size; },
      async waitForDesktop(signal) {
        while (connected.size < 2) await once(events, 'connected', { signal });
      }
    };
  } catch (error) {
    close();
    throw error;
  }
}
