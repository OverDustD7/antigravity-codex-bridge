import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { root } from '../src/config.mjs';
import { Store } from '../src/store.mjs';

const archive = process.argv[2];
assert.ok(archive, 'Run node test/portable-preview.mjs PATH_TO_PREVIEW_ZIP');
const scratch = join(root, '.runtime');
await mkdir(scratch, { recursive: true });
const fixture = await mkdtemp(join(scratch, 'preview-test-'));
const unpacked = join(fixture, '解压 Source');
const profile = join(fixture, '测试 Profile');
const appData = join(profile, 'AppData');
const state = join(profile, '.codex-conversation-bridge');
await Promise.all([unpacked, join(appData, 'Roaming'), join(appData, 'Local')].map(path => mkdir(path, { recursive: true })));

const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(BRIDGE_|ANTIGRAVITY_)/i.test(name)));
Object.assign(env, { USERPROFILE: profile, APPDATA: join(appData, 'Roaming'), LOCALAPPDATA: join(appData, 'Local') });
const execute = promisify(execFile);
const run = async (exe, args, cwd = fixture) => (await execute(exe, args, { cwd, env, windowsHide: true, timeout: 12_000 })).stdout;
const list = async () => JSON.parse(await run('agy.exe', ['plugin', 'list', '--json']));
const jsonInput = async (entry, args, input, cwd = unpacked) => {
  const child = spawn(process.execPath, [entry, ...args], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
  child.stdin.end(JSON.stringify(input));
  const timer = setTimeout(() => child.kill(), 12_000);
  try {
    const [code] = await once(child, 'close');
    assert.equal(code, 0, output || errors);
    return JSON.parse(output);
  } finally { clearTimeout(timer); }
};
const control = (tool, args = {}) => jsonInput('src/daily.mjs', ['control', tool, '--stdin'], args);
const mcpClient = (command, args, cwd) => {
  const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const messages = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const deadline = setTimeout(() => child.kill(), 10_000);
  let id = 0;
  return {
    async call(method, params = {}) {
      const requestId = ++id;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
      const next = await messages.next();
      assert.equal(next.done, false, `MCP closed while waiting for ${method}`);
      const response = JSON.parse(next.value);
      assert.equal(response.id, requestId);
      assert.equal(response.error, undefined);
      return response.result;
    },
    async close() {
      clearTimeout(deadline);
      if (child.exitCode !== null || child.signalCode !== null) return;
      const ended = once(child, 'close');
      child.stdin.end();
      await ended;
    }
  };
};

await run('tar.exe', ['-xf', resolve(archive), '-C', unpacked]);
await run('agy.exe', ['plugin', 'validate', '--strict', resolve(archive)]);
const unpackDirectory = await readdir(unpacked);
assert.deepEqual(unpackDirectory.sort(), ['README.md', 'README.zh-CN.md', 'docs', 'hooks.json', 'mcp_config.json', 'package.json', 'plugin.json', 'rules', 'sidecars', 'src'].sort());
assert.deepEqual(await list(), [], 'The Antigravity CLI must use only the clean fixture configuration.');
const manifest = JSON.parse(await readFile(join(unpacked, 'plugin.json'), 'utf8'));
assert.equal(manifest.name, 'codex-conversation-bridge');
await run('agy.exe', ['plugin', 'install', unpacked]);
let started = false;
try {
  const installed = await list();
  assert.deepEqual(installed.map(plugin => plugin.name), [manifest.name]);
  const [plugin] = installed;
  assert.equal(plugin.enabled, true);
  const installedDir = await realpath(plugin.path);
  const installedBelowProfile = relative(profile, installedDir);
  assert.ok(installedBelowProfile && !installedBelowProfile.startsWith('..') && !isAbsolute(installedBelowProfile));
  assert.notEqual(installedDir, unpacked);

  const loadState = "import { runtime, brokerRuntime } from './src/config.mjs'; console.log(JSON.stringify({ runtime, brokerRuntime }));";
  const appState = JSON.parse(await run(process.execPath, ['--input-type=module', '-e', loadState], unpacked));
  const pluginState = JSON.parse(await run(process.execPath, ['--input-type=module', '-e', loadState], installedDir));
  assert.deepEqual(appState, { runtime: join(state, 'bridge'), brokerRuntime: join(state, 'bridge') });
  assert.deepEqual(pluginState, appState);
  const sidecarDirectory = join(installedDir, 'sidecars', 'receipts');
  const sidecar = JSON.parse(await readFile(join(sidecarDirectory, 'sidecar.json'), 'utf8'));
  assert.equal(await realpath(resolve(sidecarDirectory, sidecar.args[0])), await realpath(join(installedDir, 'src', 'daily.mjs')));

  const conversationId = '07b63126-ba6c-4c8f-98b8-28c7505eb79e';
  const threadId = '2045cdb5-f596-4af2-a3d9-eee8a2b6c797';
  const hooks = JSON.parse(await readFile(join(installedDir, 'hooks.json'), 'utf8'));
  const [hook] = hooks['codex-bridge-session'].SessionStart;
  assert.equal(hook.command, 'node ./src/daily.mjs session');
  started = true;
  const registration = await jsonInput('./src/daily.mjs', ['session'], { conversationId, workspacePaths: [] }, installedDir);
  assert.match(registration.injectSteps[0].systemMessage.systemMessage, new RegExp(conversationId));
  const store = new Store(join(state, 'bridge-daily', 'bridge.sqlite'));
  try {
    store.run('INSERT INTO workspaces (id,cwd) VALUES (?,?)', 'preview-fixture', unpacked);
    store.run('INSERT INTO threads (id,workspace,title,model,created_at) VALUES (?,?,?,?,?)', threadId, 'preview-fixture', 'Example chat', 'fixture-model', new Date().toISOString());
  } finally { store.db.close(); }

  const previewMcp = JSON.parse(await readFile(join(installedDir, 'mcp_config.json'), 'utf8')).mcpServers.coordinator;
  const mcpArgs = previewMcp.args.map(arg => arg.replace('${PLUGIN_ROOT}', installedDir.replaceAll('\\', '/')));
  const mcp = mcpClient(previewMcp.command, mcpArgs, installedDir);
  const codexMcp = mcpClient(process.execPath, [join(unpacked, 'src', 'daily.mjs'), 'codex-mcp'], unpacked);
  try {
    const initialize = { protocolVersion: '2025-11-25' };
    assert.match((await mcp.call('initialize', initialize)).serverInfo.name, /bridge/);
    assert.ok((await mcp.call('tools/list')).tools.some(tool => tool.name === 'codex_wait'));
    await codexMcp.call('initialize', initialize);
    const { tools: codexTools } = await codexMcp.call('tools/list');
    assert.deepEqual(codexTools.map(tool => tool.name).sort(), ['agy_list_listeners', 'agy_message_status', 'agy_send_message']);
    const waiting = mcp.call('tools/call', { name: 'codex_wait', arguments: { threadIds: [threadId], conversationId, after: 0 } });
    waiting.catch(() => {});
    const waitForListener = async () => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const { listeners } = await control('agy_list_listeners');
        if (listeners.some(listener => listener.conversationId === conversationId && listener.threadId === threadId)) return;
        await delay(50);
      }
      assert.fail('The listener and extracted CLI did not reach the same daily worker.');
    };
    await waitForListener();
    const sent = (await codexMcp.call('tools/call', { name: 'agy_send_message',
      arguments: { conversationId, requestId: 'preview-fixture-receipt', text: 'BRIDGE_OK' } })).structuredContent;
    assert.equal(sent.ok, true);
    const receipt = await waiting;
    assert.equal(receipt.structuredContent.event.summary, 'BRIDGE_OK');
    assert.equal(receipt.structuredContent.nextCursor, sent.eventId);
    const recovery = await jsonInput('./src/daily.mjs', ['session', 'pre'], { conversationId, workspacePaths: [] }, installedDir);
    const hint = recovery.injectSteps[0].systemMessage.systemMessage;
    const command = hint.match(/执行 (node .+?)。两条入口/)?.[1];
    assert.ok(command?.includes(`'${installedDir.replaceAll('\\', '/')}/src/daily.mjs' wait `));
    const fallback = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command.replace(`wait ${threadId} 0 `, `wait ${threadId} ${sent.eventId} `)]);
    await waitForListener();
    const next = await control('agy_send_message', { conversationId, requestId: 'preview-fixture-second-receipt', text: 'FALLBACK_OK' });
    assert.match(await fallback, new RegExp(`FALLBACK_OK[\\s\\S]*nextCursor=${next.eventId}`));

    await mcp.close();
    // Antigravity is closed in this scenario while the daily worker still runs.
    const [major, minor, patch] = manifest.version.split('.').map(Number);
    const upgrade = { ...manifest, version: `${major}.${minor}.${patch + 1}` };
    await writeFile(join(unpacked, 'plugin.json'), JSON.stringify(upgrade));
    await run('agy.exe', ['plugin', 'install', unpacked]);
    assert.equal((await list())[0].version, upgrade.version);
  } finally { await Promise.all([mcp.close(), codexMcp.close()]); }
} finally {
  try {
    if (started) await control('bridge_shutdown');
  } finally {
    await run('agy.exe', ['plugin', 'uninstall', manifest.name]);
  }
}
assert.deepEqual(await list(), []);
console.log('Portable ZIP, isolated CLI install/upgrade/uninstall, and Codex MCP to Antigravity MCP and script receipts passed.');
