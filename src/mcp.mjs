import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { invoke } from './client.mjs';
import { daily, root } from './config.mjs';
import { agyMessageUse, agyMessagingTools, receiptText, tools } from './protocol.mjs';

const uri = 'ui://agy-codex/inbox.html';
const mimeType = 'text/html;profile=mcp-app';
const resource = { uri, name: 'Codex 回执', mimeType };
const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const requests = new Map();
const codexMessaging = process.env.BRIDGE_CODEX_MESSAGING === '1';
const exposedTools = codexMessaging ? agyMessagingTools : daily ? tools : tools.filter(tool => !['codex_attach_thread', 'codex_read_items'].includes(tool.name));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = data => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...data })}\n`);
let supportsUi = false;

lines.on('line', async line => {
  let message;
  try { message = JSON.parse(line); }
  catch { write({ id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    write({ id: null, error: { code: -32600, message: 'Invalid request' } }); return;
  }
  const { id, method, params } = message;
  if (method === 'notifications/cancelled') {
    requests.get(params?.requestId)?.abort();
    return;
  }
  if (id === undefined) return;
  const send = result => write({ id, result });
  const fail = (code, message) => write({ id, error: { code, message } });
  switch (method) {
    case 'initialize':
      supportsUi = !codexMessaging && !!params?.capabilities?.extensions?.['io.modelcontextprotocol/ui'];
      send({ protocolVersion: versions.includes(params?.protocolVersion) ? params.protocolVersion : versions[0],
        serverInfo: { name: 'antigravity-codex-bridge', version: '0.1.0' }, capabilities: { tools: {}, resources: {} },
        instructions: codexMessaging ? `Use agy_list_listeners to find the intended active Antigravity conversation. Send a short message only to that conversation and keep the original request ID for retries. ${agyMessageUse}`
          : daily ? 'Use the daily Codex bridge rules. Send directly to the exact chat by default. For each message directing the work or owning milestone acceptance, set purpose to coordination. For ordinary conversation, omit purpose or use message. Use after_turn only when the user asks to wait for the current turn to finish. Keep the same originating Antigravity conversation ID for dispatch and receipt waits.' : 'Use the Codex 协作桥 plugin rules. After dispatch open one codex_wait using the returned cursor. When a receipt is available, inspect its source and preserve the same thread ID.' });
      break;
    case 'ping': send({}); break;
    case 'tools/list': send({ tools: supportsUi ? exposedTools : exposedTools.filter(tool => tool.name !== 'codex_panel_wait').map(({ _meta, ...tool }) => tool) }); break;
    case 'resources/list': send({ resources: supportsUi ? [resource] : [] }); break;
    case 'resources/templates/list': send({ resourceTemplates: [] }); break;
    case 'resources/read':
      if (!supportsUi || params?.uri !== uri) { fail(-32002, 'Resource not found'); break; }
      send({ contents: [{ ...resource, text: readFileSync(join(root, 'src', 'inbox.html'), 'utf8') }] });
      break;
    case 'tools/call': {
      if (!exposedTools.some(tool => tool.name === params?.name)) { fail(-32602, 'Unknown tool'); break; }
      const cancel = new AbortController();
      requests.set(id, cancel);
      let body;
      try { body = await invoke(params?.name, params?.arguments ?? {}, cancel.signal); }
      catch (error) { body = { ok: false, code: 'BRIDGE_CONNECTION', message: error.message }; }
      finally { requests.delete(id); }
      if (!cancel.signal.aborted) {
        const output = params.name === 'codex_wait' && body.event ? receiptText(body) : JSON.stringify(body);
        send({ structuredContent: body, content: [{ type: 'text', text: output }], isError: !body.ok });
      }
      break;
    }
    default: fail(-32601, `Unknown method ${method}`);
  }
});
lines.on('close', () => { for (const controller of requests.values()) controller.abort(); });
