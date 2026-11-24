import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { codexHome, root } from './config.mjs';

export class NativeError extends Error {
  constructor(error) {
    super(error.message);
    this.code = 'CODEX_RPC_ERROR';
    this.rpcCode = error.code;
  }
}

export class NativeRequestNotSentError extends Error {
  constructor(message, options) {
    super(message, options);
    this.code = 'CODEX_REQUEST_NOT_SENT';
  }
}

export function codexExecutable() {
  if (process.env.BRIDGE_CODEX_EXE) return process.env.BRIDGE_CODEX_EXE;
  if (process.platform !== 'win32') return 'codex';
  const appCli = process.env.CODEX_APP_RUNTIME_CLI_PATH;
  if (appCli && isAbsolute(appCli) && /codex\.exe$/i.test(appCli) && existsSync(appCli)) return appCli;
  const located = spawnSync('where.exe', ['codex.exe'], { encoding: 'utf8', windowsHide: true });
  const executable = located.stdout?.split(/\r?\n/).find(path => path.trim());
  if (executable) return executable.trim();
  if (process.env.LOCALAPPDATA) {
    const bin = join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    const versions = existsSync(bin) ? readdirSync(bin, { withFileTypes: true }).filter(entry => entry.isDirectory()) : [];
    const installed = versions.map(entry => join(bin, entry.name, 'codex.exe')).filter(existsSync)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    if (installed) return installed;
  }
  throw new Error('Set BRIDGE_CODEX_EXE to the absolute path of the official codex.exe. A .cmd wrapper is not used.');
}

export class Codex {
  constructor(onEvent, onRequest, onClose, { sharedProfile = false, endpoint = null } = {}) {
    this.onEvent = onEvent;
    this.onRequest = onRequest;
    this.onClose = onClose;
    this.sharedProfile = sharedProfile;
    this.endpoint = endpoint;
    this.pending = new Map();
    this.serial = 0;
  }

  async connect() {
    if (this.ready) return this.ready;
    this.ready = this.open();
    try { await this.ready; } catch (error) {
      this.socket?.close();
      this.child?.kill();
      this.ready = null;
      throw error;
    }
  }

  async open() {
    if (this.endpoint) await this.startSocket();
    else this.startChild();
    this.info = await this.request('initialize', {
      clientInfo: { name: 'agy_codex_bridge', title: 'Antigravity–Codex Bridge', version: '0.1.0' },
      capabilities: { experimentalApi: true }
    });
    this.write({ method: 'initialized' });
  }

  disconnect() {
    this.ready = null;
    for (const entry of this.pending.values()) entry.reject(new Error('Codex App Server disconnected. Delivery may be uncertain.'));
    this.pending.clear();
    this.onClose();
  }

  startSocket() {
    // This endpoint is issued by the project-local launcher and includes its session capability.
    const socket = new WebSocket(this.endpoint);
    this.socket = socket;
    socket.addEventListener('message', event => this.readMessage(event.data));
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.disconnect();
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The shared Codex host did not accept the connection.')), 5000);
      const finish = callback => () => { clearTimeout(timer); callback(); };
      socket.addEventListener('open', finish(resolve), { once: true });
      socket.addEventListener('error', finish(() => reject(new Error('The shared Codex host is unavailable.'))), { once: true });
      socket.addEventListener('close', finish(() => reject(new Error('The shared Codex host closed the connection.'))), { once: true });
    });
  }

  startChild() {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (name.startsWith('CODEX_')) delete env[name];
    }
    delete env.OPENAI_API_KEY;
    const args = ['app-server', '--listen', 'stdio://'];
    if (!this.sharedProfile) {
      mkdirSync(codexHome, { recursive: true, mode: 0o700 });
      env.CODEX_HOME = codexHome;
      args.push('-c', 'cli_auth_credentials_store="keyring"');
    } else {
      args.push('-c', 'thread_unload_delay_secs=1');
    }
    const child = spawn(codexExecutable(), args, { cwd: root, env, windowsHide: true });
    this.child = child;
    child.stderr.resume();
    child.stdin.on('error', () => {});
    const closed = () => {
      if (this.child !== child) return;
      this.child = null;
      this.disconnect();
    };
    child.once('error', closed);
    child.once('close', closed);
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => this.readMessage(line));
  }

  readMessage(line) {
    try { this.receive(JSON.parse(line)); }
    catch (error) { console.error(`Codex event processing failed: ${error.message}`); }
  }

  write(message) {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket.send(JSON.stringify(message));
    if (!this.child?.stdin.writable) throw new NativeRequestNotSentError('Codex App Server is disconnected.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  receive(message) {
    if (message.method) {
      if (message.id === undefined) {
        this.onEvent(message.method, message.params);
      } else {
        try {
          const result = this.onRequest(message.method, message.params);
          if (result !== undefined) this.write({ id: message.id, result });
        }
        catch (error) { this.write({ id: message.id, error: { code: -32603, message: error.message } }); }
      }
      return;
    }
    const entry = this.pending.get(message.id);
    if (entry) {
      this.pending.delete(message.id);
      if (message.error) entry.reject(new NativeError(message.error));
      else entry.resolve(message.result);
    }
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out. Delivery may be uncertain.`));
      }, 40_000);
      const finish = callback => value => { clearTimeout(timeout); callback(value); };
      this.pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
      try { this.write({ id, method, params }); }
      catch (error) { this.pending.delete(id); finish(reject)(error); }
    });
  }

  close() {
    this.socket?.close();
    this.child?.stdin.end();
  }
}
