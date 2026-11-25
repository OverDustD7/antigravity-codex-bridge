import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const daily = process.env.BRIDGE_DAILY === '1';
const portable = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).codexBridge?.portable === true;
const state = resolve(process.env.BRIDGE_STATE_ROOT ?? (portable ? join(homedir(), '.codex-conversation-bridge') : join(root, '.runtime')));
export const brokerRuntime = join(state, 'bridge');
export const nativeDesktopSelection = join(brokerRuntime, 'native-desktop-install.json');
export const nativeDesktopSession = join(brokerRuntime, 'native-desktop-session.json');
export const runtime = resolve(process.env.BRIDGE_RUNTIME ?? (daily ? join(state, 'bridge-daily') : brokerRuntime));
export const workspaces = resolve(process.env.BRIDGE_WORKSPACES ?? join(portable ? state : root, 'workspaces'));
export const codexHome = join(runtime, 'codex-home');
export const sharedProjectFile = join(runtime, 'shared-codex-project.json');
export const allowIsolatedDispatch = process.env.BRIDGE_ALLOW_ISOLATED_DISPATCH === '1';
export const runtimeProtocol = daily ? 17 : 3;
export const pipeFor = directory => process.platform === 'win32'
  ? `\\\\.\\pipe\\agy-codex-${createHash('sha256').update(directory.toLowerCase()).digest('hex').slice(0, 24)}`
  : join(directory, 'bridge.sock');
export const pipe = pipeFor(runtime);

export function scriptCommand(entry) {
  const path = join(root, 'src', entry).replaceAll('\\', '/');
  const quoted = `'${path.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`;
  return `node ${/^[a-z0-9:/._-]+$/i.test(path) ? path : quoted}`;
}

export function localKey() {
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const file = join(runtime, 'control.key');
  try {
    writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return readFileSync(file, 'utf8');
}
