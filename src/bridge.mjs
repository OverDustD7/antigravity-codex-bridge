import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { Codex, NativeError } from './codex.mjs';
import { AgyWatch } from './agy-watch.mjs';
import { allowIsolatedDispatch, root, sharedProjectFile, workspaces } from './config.mjs';
import { DesktopDelivery, isBridgeProject } from './desktop.mjs';
import { DesktopOperator } from './desktop-operator.mjs';
import { savedDesktopProject } from './desktop-projects.mjs';
import { BridgeError, feedbackSchema, feedbackScriptSchema, feedbackTool, nativeFeedbackPrefix, tools, validate } from './protocol.mjs';
import { startSharedDesktopHost } from './shared-desktop-host.mjs';
import { isNativeFeedbackCommand } from './native-feedback.mjs';

const instructions = readFileSync(join(root, 'docs', 'codex-role.md'), 'utf8');
const specs = new Map(tools.map(tool => [tool.name, tool.inputSchema]));
const finalPhases = new Set(['completed', 'failed', 'interrupted']);
const pendingPhases = "('inProgress', 'uncertain')";
const expectedRpc = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);
const desktopDispatch = new Set([
  'codex_create_thread', 'codex_send_message', 'codex_read_thread', 'codex_rename_thread', 'codex_archive_thread', 'codex_fork_thread'
]);
const canon = value => Array.isArray(value) ? value.map(canon) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canon(value[key])])) : value;

function lastFinal(items = []) {
  const messages = items.filter(item => item.type === 'agentMessage' && typeof item.text === 'string');
  return (messages.findLast(item => item.phase === 'final_answer') ?? messages.findLast(item => !item.phase))?.text;
}

function shorten(value, limit = 24_000) {
  return typeof value === 'string' && value.length > limit ? `${value.slice(0, limit)}\n[完整内容见对话]` : value ?? null;
}

function isWithin(parent, child) {
  const sub = relative(parent, child);
  return sub && sub !== '..' && !sub.startsWith(`..${sep}`) && !isAbsolute(sub);
}

function projectName(name) {
  if (!/^[\p{L}\p{N}_-][\p{L}\p{N} _-]{0,63}$/u.test(name) || name.endsWith(' ') || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i.test(name)) {
    throw new BridgeError('INVALID_PATH', 'Choose a simple workspace folder name with no separators, trailing spaces or device names.');
  }
  return name;
}

export class Bridge {
  constructor(store, { projectFile = sharedProjectFile, desktopStateFile, workspaceRoot = workspaces } = {}) {
    this.store = store;
    this.desktop = new DesktopDelivery(store);
    this.agyWatch = new AgyWatch(store);
    this.operator = new DesktopOperator(store);
    this.shared = this.sharedProject(projectFile);
    this.desktopStateFile = desktopStateFile;
    this.workspaceRoot = workspaceRoot;
    this.loaded = new Set();
    this.releasing = new Map();
    this.locks = new Map();
    this.starting = new Set();
    this.executingActions = new Set();
    this.closed = false;
    this.codex = this.codexClient();
    this.onDisconnect();
  }

  codexClient(endpoint = null) {
    const client = new Codex((...event) => { if (!this.closed) this.onEvent(...event); }, (...request) => {
      if (this.closed) throw new BridgeError('BRIDGE_STOPPING', 'The bridge connection has closed.');
      return this.onRequest(...request);
    }, () => {
      if (!this.closed && this.codex === client) this.onDisconnect();
    }, { sharedProfile: !!this.shared, endpoint });
    return client;
  }

  assertTransportIdle() {
    if (this.executingActions.size || this.locks.size || this.codex.pending.size ||
        this.store.get(`SELECT 1 FROM turns WHERE status IN ${pendingPhases}`) ||
        this.store.get("SELECT 1 FROM desktop_dispatch WHERE state IN ('claimed','accepted','uncertain')")) {
      throw new BridgeError('BRIDGE_BUSY', 'Finish or recover existing bridge work before switching the Codex connection.');
    }
  }

  async startDesktopHost() {
    if (!this.shared) throw new BridgeError('DESKTOP_PROJECT_REQUIRED', 'Register and verify the local desktop project first.');
    if (this.desktopHost) return { endpoint: this.desktopHost.endpoint };
    if (this.startingDesktopHost) return this.startingDesktopHost;
    this.assertTransportIdle();
    this.startingDesktopHost = this.openDesktopHost().finally(() => { this.startingDesktopHost = null; });
    return this.startingDesktopHost;
  }

  async openDesktopHost() {
    const host = await startSharedDesktopHost();
    const next = this.codexClient(host.endpoint);
    try {
      await next.connect();
      const { project } = await next.request('project/read', { projectId: this.shared.nativeProjectId });
      if (project?.roots?.length !== 1 || !isBridgeProject(project.roots[0].path)) {
        throw new BridgeError('BACKGROUND_PROJECT_UNVERIFIED', 'The shared host did not verify this project directory.');
      }
      this.assertTransportIdle();
      const previous = this.codex;
      this.codex = next;
      this.loaded.clear();
      this.releasing.clear();
      previous.close();
      this.desktopHost = host;
      host.closed.then(() => { if (this.desktopHost === host) this.desktopHost = null; });
      return { endpoint: host.endpoint };
    } catch (error) {
      next.close();
      host.close();
      throw error;
    }
  }

  async stopDesktopHost() {
    if (this.startingDesktopHost) await this.startingDesktopHost;
    if (!this.desktopHost && !this.codex.endpoint) return { stopped: false };
    this.assertTransportIdle();
    const host = this.desktopHost;
    const previous = this.codex;
    if (host) {
      if (host.connectionCount > 1) throw new BridgeError('SHARED_DESKTOP_CONNECTED', 'Exit the Codex desktop client before stopping its shared host.');
      await previous.connect();
      const { data } = await previous.request('thread/loaded/list', {});
      for (const threadId of data) {
        const { thread } = await previous.request('thread/read', { threadId, includeTurns: false });
        if (thread.status.type === 'active') throw new BridgeError('BRIDGE_BUSY', 'The shared desktop still has an active model turn.');
      }
    }
    this.assertTransportIdle();
    if (host?.connectionCount > 1) throw new BridgeError('SHARED_DESKTOP_CONNECTED', 'Exit the Codex desktop client before stopping its shared host.');
    this.desktopHost = null;
    this.codex = this.codexClient();
    this.loaded.clear();
    this.releasing.clear();
    previous.close();
    host?.close();
    return { stopped: true };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.onDisconnect();
    this.codex.close();
    this.desktopHost?.close();
  }

  sharedProject(projectFile) {
    if (allowIsolatedDispatch || !projectFile || !existsSync(projectFile)) return null;
    const { nativeProjectId, desktopProjectId } = JSON.parse(readFileSync(projectFile, 'utf8'));
    const desktop = this.operator.project();
    if (!/^[0-9a-f-]{36}$/i.test(nativeProjectId ?? '') || desktop?.projectId !== desktopProjectId || !isBridgeProject(desktop?.cwd)) {
      throw new BridgeError('BACKGROUND_PROJECT_UNVERIFIED', 'The background project must match the verified desktop project binding.');
    }
    this.store.run('INSERT OR IGNORE INTO workspaces (id,cwd) VALUES (?,?)', desktop.workspaceId, desktop.cwd);
    if (this.workspace(desktop.workspaceId).cwd !== desktop.cwd) throw new BridgeError('BACKGROUND_PROJECT_UNVERIFIED', 'The stored target workspace has a different directory.');
    return { ...desktop, nativeProjectId };
  }

  sharedThread(id) {
    if (!this.shared) return null;
    const row = this.store.get('SELECT * FROM threads WHERE id=?', id);
    return row && this.workspaceTarget(row.workspace) ? row : undefined;
  }

  workspaceTarget(id) {
    if (!this.shared) return null;
    if (id === this.shared.workspaceId) return { ...this.shared, sidebarStatus: 'registered' };
    const row = this.store.get('SELECT id AS workspaceId, cwd FROM workspaces WHERE id = ?', id);
    if (!row || !isWithin(this.shared.cwd, row.cwd)) return null;
    const desktop = savedDesktopProject(row.cwd, this.desktopStateFile);
    return {
      ...row, hostId: this.shared.hostId, projectId: desktop?.projectId ?? null,
      nativeProjectId: desktop?.nativeProjectId ?? null,
      sidebarStatus: desktop?.nativeProjectId ? 'registered' : 'needs_desktop_registration'
    };
  }

  discoverDesktopWorkspaces(workspaceId) {
    if (!this.shared || !existsSync(this.workspaceRoot)) return;
    const base = realpathSync(this.workspaceRoot);
    if (!isWithin(this.shared.cwd, base)) return;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const id = entry.name.toLowerCase();
      if (!entry.isDirectory() || (workspaceId && id !== workspaceId)) continue;
      const cwd = join(base, entry.name);
      if (!savedDesktopProject(cwd, this.desktopStateFile)?.nativeProjectId) continue;
      this.store.run('INSERT OR IGNORE INTO workspaces (id,cwd) VALUES (?,?)', id, cwd);
    }
  }

  thread(id) {
    const row = this.store.get('SELECT rowid AS seq, * FROM threads WHERE id = ?', id);
    if (!row) throw new BridgeError('THREAD_OUTSIDE_BRIDGE', 'This thread is not registered with this bridge. Existing desktop and DSH threads are untouched.');
    return row;
  }

  receiptThread(id) {
    const native = this.sharedThread(id);
    if (native) {
      const target = this.workspaceTarget(native.workspace);
      return { ...this.describe(native), projectId: target.projectId, hostId: target.hostId, sidebarStatus: target.sidebarStatus, backend: 'background_app_server' };
    }
    return this.operator.find(id) ?? this.describe(this.thread(id));
  }

  workspace(id) {
    const row = this.store.get('SELECT * FROM workspaces WHERE id = ?', id);
    if (!row) throw new BridgeError('WORKSPACE_NOT_FOUND', 'Use a workspace ID returned by this bridge.');
    return row;
  }

  describe(row) {
    const active = this.pendingTurn(row.id);
    const last = this.store.get('SELECT id, status FROM turns WHERE thread = ? ORDER BY rowid DESC LIMIT 1', row.id);
    return {
      threadId: row.id, workspaceId: row.workspace, cwd: this.workspace(row.workspace).cwd,
      title: row.title, model: row.model, effort: row.effort, archived: !!row.archived,
      status: row.archived ? 'archived' : active?.status ?? 'idle', activeTurnId: active?.id ?? null,
      lastTurn: last ?? null, createdAt: row.created_at
    };
  }

  pendingTurn(thread) {
    return this.store.get(`SELECT id, status FROM turns WHERE thread = ? AND status IN ${pendingPhases} ORDER BY rowid DESC LIMIT 1`, thread);
  }

  assertIdle(thread) {
    const turn = this.pendingTurn(thread);
    if (turn) throw new BridgeError(turn.status === 'uncertain' ? 'TURN_UNCERTAIN' : 'TURN_ACTIVE',
      `Turn ${turn.id} is ${turn.status}. ${turn.status === 'uncertain' ? 'Use codex_recover_thread once before sending.' : 'Use a precise steer or await completion.'}`);
  }

  waitUntilIdle(threadId) {
    return new Promise((resolve, reject) => {
      const check = updated => {
        if (updated !== threadId) return;
        const active = this.pendingTurn(threadId);
        if (active?.status === 'inProgress') return;
        this.store.off('turn-state', check);
        try { this.assertIdle(threadId); resolve(); }
        catch (error) { reject(error); }
      };
      this.store.on('turn-state', check);
      check(threadId);
    });
  }

  async serial(id, task) {
    const last = this.locks.get(id) ?? Promise.resolve();
    const next = last.catch(() => {}).then(task);
    this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }

  async action(name, args, task) {
    const hash = createHash('sha256').update(JSON.stringify([name, canon(args)])).digest('hex');
    const prior = this.store.get('SELECT * FROM actions WHERE id = ?', args.requestId);
    if (prior) {
      if (prior.hash !== hash) throw new BridgeError('REQUEST_ID_REUSED', 'This request ID already belongs to another action or arguments.');
      if (prior.state === 'finished') return { ...JSON.parse(prior.result), replayed: true };
      throw new BridgeError('REQUEST_IN_FLIGHT_OR_UNCERTAIN', 'The original action is pending or its delivery is uncertain. The bridge will not dispatch it twice.');
    }
    this.store.run("INSERT INTO actions (id, hash, state) VALUES (?, ?, 'started')", args.requestId, hash);
    this.executingActions.add(args.requestId);
    try {
      const result = { ok: true, requestId: args.requestId, ...await task() };
      this.store.run("UPDATE actions SET state = 'finished', result = ? WHERE id = ?", JSON.stringify(result), args.requestId);
      return result;
    } catch (error) {
      if (error instanceof BridgeError || error instanceof NativeError) {
        const result = { ok: false, requestId: args.requestId, code: error.code, message: error.message };
        this.store.run("UPDATE actions SET state = 'finished', result = ? WHERE id = ?", JSON.stringify(result), args.requestId);
      }
      throw error;
    } finally { this.executingActions.delete(args.requestId); }
  }

  async rpc(method, params) {
    await this.codex.connect();
    return this.codex.request(method, params);
  }

  async load(row) {
    if (row.archived) throw new BridgeError('THREAD_ARCHIVED', 'Restore this thread before running a turn.');
    await this.codex.connect();
    await this.releasing.get(row.id);
    if (this.loaded.has(row.id)) return;
    if (realpathSync(this.workspace(row.workspace).cwd) !== this.workspace(row.workspace).cwd) {
      throw new BridgeError('WORKSPACE_MOVED', 'The registered directory now resolves to a different location.');
    }
    const target = this.workspaceTarget(row.workspace);
    if (this.shared) await this.readDesktopChat(row.id, target);
    const { thread } = await this.resumeNative(row.id);
    if (this.shared) {
      try { this.verifyDesktopChat(row.id, thread, target); }
      catch (error) {
        await this.codex.request('thread/unsubscribe', { threadId: row.id }).catch(() => {});
        throw error;
      }
    }
    this.loaded.add(row.id);
  }

  async resumeNative(threadId) {
    try {
      return await this.rpc('thread/resume', { threadId, excludeTurns: true, developerInstructions: instructions, sandbox: 'workspace-write' });
    } catch (error) {
      if (this.shared && error instanceof NativeError && /already has an active writer/i.test(error.message)) {
        throw new BridgeError('CODEX_CHAT_OWNED_BY_ANOTHER_CLIENT', 'Codex refused to resume the original chat while another client owns it. No message was sent.');
      }
      throw error;
    }
  }

  verifyDesktopChat(threadId, thread, target = this.shared) {
    const primary = target?.workspaceId === this.shared?.workspaceId;
    const projectMatches = target?.nativeProjectId && (thread?.projectId === target.nativeProjectId || (primary && !thread?.projectId));
    if (thread?.id !== threadId || !projectMatches || typeof thread.cwd !== 'string' || relative(target.cwd, thread.cwd) !== '') {
      throw new BridgeError('DESKTOP_TARGET_UNVERIFIED', 'Codex did not confirm the exact original chat in the registered directory.');
    }
  }

  async readDesktopChat(threadId, target) {
    const { thread } = await this.rpc('thread/read', { threadId, includeTurns: false });
    this.verifyDesktopChat(threadId, thread, target);
    return thread;
  }

  async connectRegisteredDesktopChat(threadId) {
    const desktop = this.operator.find(threadId);
    if (!desktop || desktop.projectId !== this.shared.projectId) {
      throw new BridgeError('THREAD_OUTSIDE_BRIDGE', 'Use a Codex chat verified in the registered desktop project.');
    }
    if (desktop.archived) throw new BridgeError('THREAD_ARCHIVED', 'Restore this chat before sending a message.');
    if (this.store.get("SELECT 1 FROM desktop_dispatch WHERE thread=? AND state IN ('queued','claimed','accepted','uncertain')", threadId)) {
      throw new BridgeError('DESKTOP_REQUEST_PENDING', 'The original desktop request must be settled before sending a new message.');
    }
    await this.readDesktopChat(threadId, this.shared);
    const { thread, model } = await this.resumeNative(threadId);
    try {
      this.verifyDesktopChat(threadId, thread);
      if (thread.status.type !== 'idle') throw new BridgeError('TURN_ACTIVE', 'The original Codex chat is not idle. No new turn was started.');
      this.store.run('INSERT INTO threads (id, workspace, title, model, created_at, effort) VALUES (?, ?, ?, ?, ?, ?)',
        threadId, desktop.workspaceId, desktop.title, desktop.model ?? model, desktop.createdAt, desktop.effort ?? null);
      this.loaded.add(threadId);
    } catch (error) {
      await this.codex.request('thread/unsubscribe', { threadId }).catch(() => {});
      throw error;
    }
  }

  releaseThread(threadId) {
    if (!this.sharedThread(threadId) || !this.loaded.delete(threadId)) return;
    const release = this.codex.request('thread/unsubscribe', { threadId }).catch(() => {}).finally(() => this.releasing.delete(threadId));
    this.releasing.set(threadId, release);
  }

  workspaceCreate(name) {
    name = projectName(name);
    const id = name.toLowerCase();
    const prior = this.store.get('SELECT * FROM workspaces WHERE id = ?', id);
    if (prior) return { workspace: { workspaceId: prior.id, cwd: prior.cwd }, created: false };
    if (this.shared && !isWithin(this.shared.cwd, this.workspaceRoot)) throw new BridgeError('WORKSPACE_OUTSIDE_ROOT', 'The workspace container must stay under the verified project root.');
    mkdirSync(this.workspaceRoot, { recursive: true });
    const base = realpathSync(this.workspaceRoot);
    if (this.shared && !isWithin(this.shared.cwd, base)) throw new BridgeError('WORKSPACE_OUTSIDE_ROOT', 'The workspace container must stay under the verified project root.');
    const cwd = join(base, name);
    let created = true;
    try { mkdirSync(cwd); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      created = false;
    }
    const actual = realpathSync(cwd);
    if (!isWithin(base, actual)) throw new BridgeError('WORKSPACE_OUTSIDE_ROOT', 'The workspace resolved outside the configured root.');
    if (!created && (!this.shared || relative(cwd, actual) !== '' || !statSync(actual).isDirectory() || !savedDesktopProject(actual, this.desktopStateFile)?.nativeProjectId)) {
      throw new BridgeError('WORKSPACE_PATH_EXISTS', 'That path is already in use. Add the exact folder as a workspace in Codex Desktop before registering it with the bridge.');
    }
    this.store.run('INSERT INTO workspaces (id, cwd) VALUES (?, ?)', id, actual);
    return { workspace: { workspaceId: id, cwd: actual }, created };
  }

  async modelList(params = {}) {
    const page = await this.rpc('model/list', { ...params, includeHidden: false });
    if (!Array.isArray(page.data)) throw new Error('Invalid Codex model catalogue response.');
    return { models: page.data.map(model => ({
      model: model.model, id: model.id, name: model.displayName, default: model.isDefault,
      defaultEffort: model.defaultReasoningEffort, efforts: model.supportedReasoningEfforts.map(effort => effort.reasoningEffort)
    })), nextCursor: page.nextCursor ?? null };
  }

  async selectModel(name, effort) {
    let cursor;
    do {
      const list = await this.modelList({ limit: 50, cursor });
      const entry = list.models.find(model => model.model === name || model.id === name || model.name.toLowerCase() === name.toLowerCase());
      if (entry) {
        if (effort && !entry.efforts.includes(effort)) throw new BridgeError('EFFORT_UNAVAILABLE', `Model ${entry.model} supports ${entry.efforts.join(', ')}.`);
        return entry.model;
      }
      cursor = list.nextCursor;
    } while (cursor);
    throw new BridgeError('MODEL_UNAVAILABLE', `Model ${name} was not in the official catalogue. Use codex_list_models and explicitly choose an available model.`);
  }

  async threadCreate(args) {
    const workspace = this.workspace(args.workspaceId);
    if (realpathSync(workspace.cwd) !== workspace.cwd) throw new BridgeError('WORKSPACE_MOVED', 'The registered directory now resolves to a different location.');
    const target = this.workspaceTarget(args.workspaceId);
    if (this.shared) {
      if (!target?.nativeProjectId) throw new BridgeError('DESKTOP_WORKSPACE_NOT_REGISTERED', 'The folder is ready. Add it as a project in the Codex desktop sidebar before dispatching.');
      const { project } = await this.rpc('project/read', { projectId: target.nativeProjectId });
      if (!project || project.roots?.length !== 1 || realpathSync(project.roots[0].path) !== workspace.cwd) {
        throw new BridgeError('BACKGROUND_PROJECT_UNVERIFIED', 'The native Codex project no longer matches the verified desktop directory.');
      }
    }
    const model = await this.selectModel(args.model ?? process.env.BRIDGE_CODEX_MODEL ?? 'gpt-6.2-sol', args.effort);
    const { thread, model: actual } = await this.rpc('thread/start', {
      cwd: workspace.cwd, model, developerInstructions: instructions, dynamicTools: [feedbackTool],
      sandbox: 'workspace-write', allowProviderModelFallback: false,
      ...(target && { projectId: target.nativeProjectId })
    });
    if (target) this.verifyDesktopChat(thread.id, thread, target);
    const result = await this.registerThread(thread.id, workspace.id, args.title, actual ?? model, args.effort);
    if (args.prompt) {
      try { result.dispatch = await this.send(this.thread(thread.id), args, result.initialCursor); }
      catch (error) {
        this.releaseThread(thread.id);
        result.dispatch = { accepted: false, code: error.code ?? 'DELIVERY_UNCERTAIN', message: error.message };
      }
    }
    return result;
  }

  async registerThread(threadId, workspaceId, title, model, effort) {
    const createdAt = new Date().toISOString();
    const target = this.workspaceTarget(workspaceId);
    this.store.transaction(() => {
      this.store.run('INSERT INTO threads (id, workspace, title, model, created_at, effort) VALUES (?, ?, ?, ?, ?, ?)',
        threadId, workspaceId, title, model, createdAt, effort ?? null);
      if (target?.projectId) this.store.run('INSERT INTO desktop_threads (id,project,title,model,effort,created_at) VALUES (?,?,?,?,?,?)',
        threadId, target.projectId, title, model, effort ?? null, createdAt);
    });
    this.loaded.add(threadId);
    const result = { thread: this.receiptThread(threadId), initialCursor: this.cursor() };
    try { await this.rpc('thread/name/set', { threadId, name: title }); }
    catch (error) { result.nativeTitle = { applied: false, message: error.message }; }
    return result;
  }

  async usageLimits() {
    const result = await this.rpc('account/rateLimits/read', {});
    const windows = Object.values(result.rateLimitsByLimitId ?? { primary: result.rateLimits });
    return { usageAllowed: result.ordinaryUsageAllowed ?? null, windows: windows.filter(Boolean).map(window => ({
      id: window.limitId, name: window.limitName, model: window.normalModelSlug, primary: window.primary, secondary: window.secondary,
      spendControlReached: window.spendControlReached, rateLimitReachedType: window.rateLimitReachedType
    })) };
  }

  cursor() { return this.store.get('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').seq; }

  async send(row, args, before = this.cursor()) {
    const threadId = row.id;
    const delivery = args.delivery ?? 'next_turn';
    const startsTurn = delivery !== 'steer';
    let decision;
    if (args.decisionEventId) {
      const event = this.store.get("SELECT * FROM events WHERE seq = ? AND thread = ? AND kind = 'decision'", args.decisionEventId, threadId);
      if (!event) throw new BridgeError('DECISION_NOT_FOUND', 'Use an unresolved decision event ID from this exact thread.');
      const existing = this.store.get('SELECT * FROM resolutions WHERE event = ?', event.seq);
      if (existing) throw new BridgeError('DECISION_ALREADY_BOUND', `A reply is already bound under request ${existing.action}.`);
      decision = this.store.eventRecord(event);
    }
    if (delivery === 'after_turn') await this.waitUntilIdle(threadId);
    else if (delivery === 'next_turn') this.assertIdle(threadId);
    else {
      const active = this.pendingTurn(threadId);
      if (active?.status !== 'inProgress' || args.expectedTurnId !== active.id) {
        throw new BridgeError('TURN_MISMATCH', 'Steer requires the exact currently running turn ID.');
      }
    }
    const text = decision
      ? `Follow-up to bridge decision ${decision.eventId} from this same chat.\nDecision requested: ${decision.summary}\nReply relayed by the coordinator: ${args.prompt}\nApply the existing task authorization. An action requiring additional user approval remains pending until that approval is confirmed.`
      : args.prompt;
    const input = [{ type: 'text', text, text_elements: [] }];
    await this.load(row);
    if (decision) this.store.run('INSERT INTO resolutions (event, action) VALUES (?, ?)', decision.eventId, args.requestId);
    if (startsTurn) this.starting.add(threadId);
    try {
      const result = delivery === 'steer'
        ? await this.rpc('turn/steer', { threadId, expectedTurnId: args.expectedTurnId, input, clientUserMessageId: args.requestId })
        : await this.rpc('turn/start', { threadId, input, model: row.model, effort: row.effort, clientUserMessageId: args.requestId });
      const turnId = result.turn?.id ?? result.turnId;
      if (!turnId) throw new Error('Codex did not return a turn ID. Delivery may be uncertain.');
      if (startsTurn) this.recordTurn(threadId, turnId, 'inProgress');
      const receipt = { accepted: true, threadId, turnId, delivery, after: before, ...(decision ? { decisionEventId: decision.eventId } : {}) };
      if (decision) this.store.run('UPDATE resolutions SET receipt = ? WHERE event = ?', JSON.stringify(receipt), decision.eventId);
      return receipt;
    } catch (error) {
      if (error instanceof NativeError) {
        if (decision) this.store.run('DELETE FROM resolutions WHERE event = ?', decision.eventId);
        if (startsTurn) this.releaseThread(threadId);
      } else if (startsTurn && !this.pendingTurn(threadId)) {
        this.recordTurn(threadId, `unknown:${args.requestId}`, 'uncertain');
      }
      throw error;
    } finally { this.starting.delete(threadId); }
  }

  recordTurn(threadId, turnId, status) {
    this.store.run('INSERT OR IGNORE INTO turns (thread, id, status) VALUES (?, ?, ?)', threadId, turnId, status);
  }

  onEvent(method, params) {
    const { threadId, turn, turnId, item } = params ?? {};
    if (!threadId || !this.store.get('SELECT 1 AS found FROM threads WHERE id = ?', threadId)) return;
    if (!this.starting.has(threadId) && !this.store.get('SELECT 1 FROM turns WHERE thread = ? AND id = ?', threadId, turn?.id ?? turnId ?? '')) return;
    if (method === 'turn/started') this.recordTurn(threadId, turn.id, 'inProgress');
    if (method === 'item/completed') {
      this.captureNativeFeedback(threadId, turnId, item);
      const text = lastFinal([item]);
      if (text) {
        this.recordTurn(threadId, turnId, 'inProgress');
        this.store.run('UPDATE turns SET final_text = ? WHERE thread = ? AND id = ?', text, threadId, turnId);
      }
    }
    if (method === 'turn/completed') {
      this.complete(threadId, turn);
      this.releaseThread(threadId);
    }
  }

  captureNativeFeedback(threadId, turnId, item, recovered = false) {
    if (item?.type !== 'commandExecution' || item.status !== 'completed' || item.exitCode !== 0 || !isNativeFeedbackCommand(item.command) ||
        typeof item.aggregatedOutput !== 'string') return;
    this.captureNativeFeedbackText(threadId, turnId, item.aggregatedOutput, recovered);
  }

  captureNativeFeedbackText(threadId, turnId, output, recovered = false) {
    for (const line of output.split(/\r?\n/).map(line => line.trimStart())) {
      if (!line.startsWith(nativeFeedbackPrefix)) continue;
      try {
        const { reportId, feedback } = JSON.parse(line.slice(nativeFeedbackPrefix.length));
        validate(feedbackScriptSchema, { threadId, turnId, reportId, feedback });
        this.report(threadId, turnId, `script:${reportId}`, feedback, 'codex_feedback_script', recovered);
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof BridgeError || error instanceof TypeError)) throw error;
      }
    }
  }

  complete(threadId, turn, recovered = false) {
    if (!finalPhases.has(turn.status)) return;
    this.store.transaction(() => {
      const row = this.store.get('SELECT * FROM turns WHERE thread = ? AND id = ?', threadId, turn.id);
      if (row && finalPhases.has(row.status)) return;
      if (recovered && row?.status === 'uncertain') {
        for (const item of turn.items ?? []) this.captureNativeFeedback(threadId, turn.id, item, true);
      }
      this.recordTurn(threadId, turn.id, turn.status);
      const text = lastFinal(turn.items) ?? row?.final_text ?? null;
      this.store.run('UPDATE turns SET status = ?, final_text = ? WHERE thread = ? AND id = ?', turn.status, text, threadId, turn.id);
      const activeReport = !!this.store.get("SELECT 1 AS found FROM events WHERE thread = ? AND turn = ? AND key LIKE 'report:%'", threadId, turn.id);
      if (!activeReport || turn.status !== 'completed') {
        this.store.event(threadId, turn.id, `closed:${turn.id}`, activeReport ? 'turn_error' : 'turn_fallback', {
          source: 'codex_native_turn', activeReport, status: turn.status, finalOutput: shorten(text),
          notice: activeReport ? 'Codex 主动报告后，本轮异常结束。' : 'Codex 本轮未调用反馈工具。以下为原生回合最终输出。',
          ...(turn.error ? { error: shorten(turn.error.message, 1000) } : {}), ...(recovered ? { recovered } : {})
        });
      }
    });
    this.store.emit('turn-state', threadId);
  }

  onDisconnect() {
    this.loaded.clear();
    this.codex.info = null;
    const running = this.store.all("SELECT thread, id FROM turns WHERE status = 'inProgress'");
    this.store.transaction(() => {
      for (const row of running) {
        this.store.run("UPDATE turns SET status = 'uncertain' WHERE thread = ? AND id = ?", row.thread, row.id);
        this.store.event(row.thread, row.id, `lost:${row.id}`, 'transport_error', {
          notice: 'Codex 事件连接中断，本轮结果待核对。桥接器没有重发。'
        });
      }
    });
    for (const row of running) this.store.emit('turn-state', row.thread);
  }

  onRequest(method, params) {
    if (method === 'item/tool/call' && params.tool === feedbackTool.name && !params.namespace) {
      try {
        return this.toolReply(true, this.report(params.threadId, params.turnId, `native:${params.callId}`, params.arguments, 'codex_feedback_tool'));
      } catch (error) { return this.toolReply(false, { code: error.code, message: error.message }); }
    }
    if (expectedRpc.has(method)) {
      this.thread(params.threadId);
      this.store.event(params.threadId, params.turnId, `approval:${params.itemId}`, 'blocker', {
        summary: 'App Server 收到原生审批请求，当前回合需要授权才能继续这个操作。', activeReport: false, method
      });
      return { decision: 'decline' };
    }
    if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
    if (method === 'mcpServer/elicitation/request') return { action: 'decline', content: null };
    if (method === 'tool/requestUserInput') return { answers: {} };
    throw new Error(`Unsupported Codex server request: ${method}`);
  }

  toolReply(success, data) { return { success, contentItems: [{ type: 'inputText', text: JSON.stringify(data) }] }; }

  report(threadId, turnId, reportId, body, source, recovered = false) {
    this.thread(threadId);
    validate(feedbackSchema, body);
    const key = `report:${turnId}:${reportId}`;
    const prior = this.store.get('SELECT seq, body FROM events WHERE thread = ? AND key = ?', threadId, key);
    const data = { ...body, activeReport: true, source };
    if (prior) {
      if (JSON.stringify(canon(data)) !== JSON.stringify(canon(JSON.parse(prior.body)))) {
        throw new BridgeError('REPORT_ID_REUSED', 'The report ID is already bound to different content.');
      }
      return { eventId: prior.seq, duplicate: true, threadId, turnId, state: 'persisted_in_antigravity_inbox' };
    }
    const pending = this.pendingTurn(threadId);
    const exactTurn = pending?.id === turnId && (pending.status === 'inProgress' || (recovered && pending.status === 'uncertain'));
    if (!exactTurn && !(source === 'codex_feedback_tool' && this.starting.has(threadId))) {
      throw new BridgeError('TURN_MISMATCH', 'Feedback must belong to the active turn of this registered chat.');
    }
    const receipt = this.store.event(threadId, turnId, key, body.kind, data);
    return { ...receipt, threadId, turnId, state: 'persisted_in_antigravity_inbox' };
  }

  async history(threadId, { cursor, limit = 10 } = {}) {
    const result = await this.rpc('thread/turns/list', { threadId, limit, cursor, itemsView: 'full', sortDirection: 'desc' });
    if (!Array.isArray(result.data)) throw new Error('Invalid turn history response.');
    return result;
  }

  async recover(row) {
    const pending = this.pendingTurn(row.id);
    if (!pending || pending.status !== 'uncertain') return { thread: this.describe(row), reconciled: false };
    if (pending.id.startsWith('unknown:')) throw new BridgeError('DELIVERY_ID_UNKNOWN', 'No native turn ID was received. Inspect native history before any manual retry; the bridge cannot attribute the delivery safely.');
    const result = await this.history(row.id, { limit: 20 });
    const turn = result.data.find(entry => entry.id === pending.id);
    if (!turn || !finalPhases.has(turn.status)) throw new BridgeError('TURN_UNCERTAIN', 'No authoritative persisted completion exists for the exact turn ID. The bridge has not replayed it.');
    this.complete(row.id, turn, true);
    return { thread: this.describe(row), reconciled: true };
  }

  async invoke(name, args, signal) {
    if (name === 'desktop_shared_start') {
      if (args.threadId) {
        const thread = this.receiptThread(args.threadId);
        if (!this.workspaceTarget(thread.workspaceId)?.nativeProjectId) {
          throw new BridgeError('DESKTOP_TARGET_UNVERIFIED', 'The shared desktop can open a chat only in a verified project.');
        }
      }
      return this.startDesktopHost();
    }
    if (name === 'desktop_shared_stop') return this.stopDesktopHost();
    if (name === 'desktop_shared_wait') {
      const host = this.desktopHost;
      if (!host) throw new BridgeError('SHARED_DESKTOP_NOT_RUNNING', '共享后台尚未启动。');
      const deadline = AbortSignal.timeout(25_000);
      try { await host.waitForDesktop(signal ? AbortSignal.any([signal, deadline]) : deadline); }
      catch (error) {
        if (deadline.aborted) throw new BridgeError('SHARED_DESKTOP_CONNECT_TIMEOUT', 'Codex 已启动，但 25 秒内未接入共享后台。');
        throw error;
      }
      return { connected: true, connectedClients: host.connectionCount };
    }
    if (name === 'desktop_shared_status') {
      if (!this.desktopHost) return { running: false };
      if (!args.threadId) return { running: true, connectedClients: this.desktopHost.connectionCount };
      this.receiptThread(args.threadId);
      const { data } = await this.rpc('thread/loaded/list', {});
      return { running: true, connectedClients: this.desktopHost.connectionCount, threadId: args.threadId, loaded: data.includes(args.threadId) };
    }
    if (name === 'agy_register_session') return this.desktop.register(args);
    if (name === 'agy_watch_status') return { watches: this.agyWatch.status(args.conversationId) };
    if (name === 'agy_watch_guard') return { missing: this.agyWatch.guard(args.conversationId) };
    if (name === 'desktop_recover_deliveries') return this.desktop.recover();
    if (name === 'desktop_take') return this.desktop.take(signal, args.resumable === true);
    if (name === 'desktop_delivery_start') return this.desktop.start(args.eventId);
    if (name === 'desktop_finish') return this.desktop.finish(args);
    if (name === 'desktop_operator_configure') return this.operator.configure(args);
    if (name === 'desktop_operator_take') return this.operator.take(signal);
    if (name === 'desktop_operator_status') return this.operator.pending();
    if (name === 'desktop_operator_finish') {
      const result = this.operator.finish(args);
      const request = this.operator.dispatch(args.requestId);
      const { conversationId } = JSON.parse(request.payload);
      if (result.accepted && conversationId && ['codex_create_thread', 'codex_send_message'].includes(request.method)) {
        this.agyWatch.expect(conversationId, result.threadId, result.after);
      }
      return result;
    }
    if (name === 'desktop_operator_complete') return this.operator.complete(args);
    if (name === 'desktop_work_report') return this.operator.report(args, signal);
    if (name === 'codex_feedback_context') {
      validate({ type: 'object', properties: { threadId: { type: 'string', minLength: 1, maxLength: 150 } }, required: ['threadId'] }, args);
      this.thread(args.threadId);
      const turn = this.pendingTurn(args.threadId);
      if (turn?.status !== 'inProgress') throw new BridgeError('TURN_INACTIVE', 'The registered thread has no active turn.');
      return { threadId: args.threadId, turnId: turn.id };
    }
    if (name === 'codex_submit_feedback') {
      validate(feedbackScriptSchema, args);
      return this.report(args.threadId, args.turnId, `script:${args.reportId}`, args.feedback, 'codex_feedback_script');
    }
    const spec = specs.get(name);
    if (!spec) throw new BridgeError('TOOL_UNAVAILABLE', `Unknown bridge tool ${name}.`);
    validate(spec, args);
    if (name === 'codex_create_thread' && this.shared && !this.workspaceTarget(args.workspaceId)) this.discoverDesktopWorkspaces(args.workspaceId);
    const nativeThread = args.threadId && this.sharedThread(args.threadId);
    const isNativeCreation = name === 'codex_create_thread' && this.workspaceTarget(args.workspaceId);
    const nativeDesktopRead = name === 'codex_read_thread' && this.shared && !nativeThread && this.operator.find(args.threadId);
    const previousDesktopRequest = args.requestId && this.store.get('SELECT 1 FROM desktop_dispatch WHERE id=?', args.requestId);
    if (this.shared && name === 'codex_send_message' && !previousDesktopRequest) {
      return this.action(name, args, () => this.serial(args.threadId, async () => {
        if (args.conversationId) this.agyWatch.check(args.conversationId, args.threadId);
        if (!this.sharedThread(args.threadId)) await this.connectRegisteredDesktopChat(args.threadId);
        if (!this.workspaceTarget(this.thread(args.threadId).workspace)?.nativeProjectId) {
          throw new BridgeError('DESKTOP_WORKSPACE_NOT_REGISTERED', 'The original workspace is no longer registered in the desktop sidebar.');
        }
        try {
          return await this.changeThread(name, args, this.thread(args.threadId));
        } catch (error) {
          if (!this.pendingTurn(args.threadId)) this.releaseThread(args.threadId);
          throw error;
        }
      }));
    }
    if (!allowIsolatedDispatch && desktopDispatch.has(name) && (previousDesktopRequest || (!nativeThread && !isNativeCreation && !nativeDesktopRead))) {
      if (!args.requestId) throw new BridgeError('REQUEST_ID_REQUIRED', 'Provide a stable requestId for the desktop queue.');
      if (args.conversationId) this.agyWatch.check(args.conversationId, args.threadId);
      const executorWaiting = this.operator.waiting;
      const receipt = this.operator.submit(name, args, this.cursor());
      return executorWaiting && ['queued', 'claimed'].includes(receipt.state) ? this.operator.wait(args.requestId, signal) : receipt;
    }
    if (!allowIsolatedDispatch && !this.shared && name === 'codex_create_project') {
      throw new BridgeError('DESKTOP_PROJECT_REQUIRED', 'Register the local bridge project before preparing another workspace.');
    }
    if (!allowIsolatedDispatch && name === 'codex_interrupt_turn' && !nativeThread) {
      throw new BridgeError('DESKTOP_OPERATION_UNAVAILABLE', 'The current desktop executor exposes no verified native turn interruption.');
    }
    const { threadId, workspaceId } = args;
    switch (name) {
      case 'bridge_status': return { backend: this.desktopHost ? 'shared_codex_desktop_transport' : this.shared ? 'shared_official_app_server_and_desktop_executor' : allowIsolatedDispatch ? 'isolated_official_codex_app_server' : 'codex_desktop_executor_queue', scope: 'bridge_managed_only', ready: allowIsolatedDispatch ? !!this.codex.info : !!this.operator.project(), executorWaiting: this.operator.waiting, dispatch: allowIsolatedDispatch ? 'isolated_test_enabled' : (this.operator.project() ? 'desktop_project_bound' : 'desktop_host_required'), receiptDelivery: ['background_command_completion', 'background_mcp_result', 'retained_inbox', 'optional_agentapi_sidecar'], idleChatPush: 'when_an_antigravity_native_wake_path_is_enabled' };
      case 'codex_account_status': {
        const result = await this.rpc('account/read', { refreshToken: false });
        return { authenticated: !!result.account, accountType: result.account?.type ?? null, requiresOpenaiAuth: result.requiresOpenaiAuth };
      }
      case 'codex_list_projects': {
        this.discoverDesktopWorkspaces();
        const rows = this.store.all('SELECT id AS workspaceId, cwd FROM workspaces ORDER BY id');
        return { projects: this.shared ? rows.map(row => this.workspaceTarget(row.workspaceId)).filter(Boolean) : allowIsolatedDispatch ? rows : [this.operator.project()].filter(Boolean) };
      }
      case 'codex_create_project': return this.action(name, args, () => {
        const created = this.workspaceCreate(args.name);
        if (!this.shared) return created;
        const workspace = this.workspaceTarget(created.workspace.workspaceId);
        return { ...created, workspace, readyToDispatch: !!workspace.nativeProjectId };
      });
      case 'codex_list_threads': {
        if (!allowIsolatedDispatch) {
          if (workspaceId && !this.workspaceTarget(workspaceId) && workspaceId !== this.operator.project()?.workspaceId) {
            throw new BridgeError('DESKTOP_PROJECT_REQUIRED', 'Use a registered Codex desktop workspace.');
          }
          const list = this.operator.list(args.limit, args.before, args.archived ?? false, workspaceId ?? null);
          return { ...list, threads: list.threads.map(thread => this.receiptThread(thread.threadId)) };
        }
        if (workspaceId) this.workspace(workspaceId);
        const limit = args.limit ?? 20;
        const rows = this.store.all('SELECT rowid AS seq, * FROM threads WHERE archived = ? AND rowid < ? AND (? IS NULL OR workspace = ?) ORDER BY rowid DESC LIMIT ?',
          args.archived ? 1 : 0, args.before ?? Number.MAX_SAFE_INTEGER, workspaceId ?? null, workspaceId ?? null, limit + 1);
        return { threads: rows.slice(0, limit).map(row => this.describe(row)), nextCursor: rows.length > limit ? rows[limit - 1].seq : null };
      }
      case 'codex_list_models': return this.modelList(args);
      case 'codex_usage_limits': return this.usageLimits();
      case 'codex_set_model': {
        if (allowIsolatedDispatch || nativeThread) return this.action(name, args, () => this.serial(threadId, () => this.changeThread(name, args, this.thread(threadId))));
        const desktop = this.shared && this.operator.find(threadId);
        if (desktop && !desktop.archived) {
          return this.action(name, args, () => this.serial(threadId, async () => {
            if (!this.sharedThread(threadId)) await this.connectRegisteredDesktopChat(threadId);
            return this.changeThread(name, args, this.thread(threadId));
          }));
        }
        return this.action(name, args, async () => this.operator.setModel(threadId, await this.selectModel(args.model, args.effort), args.effort));
      }
      case 'codex_read_thread': {
        const thread = this.receiptThread(threadId);
        if (this.shared) await this.readDesktopChat(threadId, this.workspaceTarget(thread.workspaceId));
        const result = await this.history(threadId, args);
        return { thread, nextCursor: result.nextCursor ?? null, turns: result.data.map(turn => ({
          turnId: turn.id, status: turn.status, messages: turn.items.flatMap(item => {
            if (item.type === 'userMessage') return [{ role: 'user', text: shorten(item.content.filter(part => part.type === 'text').map(part => part.text).join('\n'), 10_000) }];
            if (item.type === 'agentMessage') return [{ role: 'assistant', phase: item.phase, text: shorten(item.text, 10_000) }];
            return [];
          }).slice(-10)
        })) };
      }
      case 'codex_read_final': {
        this.receiptThread(threadId);
        const turn = this.store.get('SELECT status, final_text FROM turns WHERE thread = ? AND id = ?', threadId, args.turnId);
        if (!turn || !finalPhases.has(turn.status)) throw new BridgeError('FINAL_NOT_AVAILABLE', 'The bridge has not recorded this turn as complete.');
        const offset = args.offset ?? 0;
        const text = turn.final_text;
        const next = offset + 12_000;
        return { threadId, turnId: args.turnId, status: turn.status, text: text?.slice(offset, next) ?? null, nextOffset: next < (text?.length ?? 0) ? next : null };
      }
      case 'codex_create_thread':
        if (!isNativeCreation) return this.action(name, args, () => this.threadCreate(args));
        if (!args.prompt) throw new BridgeError('DESKTOP_PROMPT_REQUIRED', 'Start a first task so Codex Desktop can index the new chat.');
        if (!isNativeCreation.nativeProjectId) throw new BridgeError('DESKTOP_WORKSPACE_NOT_REGISTERED', 'The folder is ready. Add it as a project in the Codex desktop sidebar before dispatching.');
        if (args.conversationId) this.agyWatch.check(args.conversationId);
        return this.action(name, args, async () => {
          const result = await this.threadCreate(args);
          const { thread, dispatch } = result;
          if (dispatch.accepted && args.conversationId) this.agyWatch.expect(args.conversationId, thread.threadId, dispatch.after);
          return {
            ...result, ...dispatch, threadId: thread.threadId, cwd: thread.cwd, hostId: thread.hostId,
            projectId: thread.projectId, state: dispatch.accepted ? 'accepted' : 'failed',
            sidebarStatus: 'desktop_catalog_sync'
          };
        });
      case 'codex_wait_dispatch': return this.operator.wait(args.requestId, signal);
      case 'codex_wait':
      case 'codex_panel_wait': {
        args.threadIds.forEach(id => this.receiptThread(id));
        if (args.conversationId) {
          if (args.threadIds.length !== 1) throw new BridgeError('AGY_WATCH_SINGLE_THREAD', 'Register each Codex chat separately.');
          return this.agyWatch.wait(args.conversationId, args.threadIds[0], args.after ?? 0, signal);
        }
        return this.store.wait(args.threadIds, args.after ?? 0, signal);
      }
      case 'codex_pause_receipt_watch': {
        const watch = this.agyWatch.pause(args.conversationId, threadId);
        const sidecar = this.desktop.pause(args);
        return { ...watch, stopped: watch.stopped || sidecar };
      }
      case 'codex_inbox': {
        if (args.eventId && !threadId) throw new BridgeError('THREAD_REQUIRED', 'Provide the thread ID with an exact event ID.');
        if (!threadId) return { threads: allowIsolatedDispatch ? this.store.all('SELECT rowid AS seq, * FROM threads ORDER BY rowid DESC LIMIT 50').map(row => this.describe(row)) : this.operator.list(50).threads, idleChatPush: 'unverified' };
        const thread = this.receiptThread(threadId);
        if (args.eventId) {
          const event = this.store.get('SELECT * FROM events WHERE seq = ? AND thread = ?', args.eventId, threadId);
          if (!event) throw new BridgeError('EVENT_NOT_FOUND', 'No such receipt belongs to that thread.');
          return { thread, events: [this.store.eventRecord(event)], nextCursor: event.seq };
        }
        const after = args.after ?? 0;
        const events = this.store.events([threadId], after, args.limit ?? 30);
        return { thread, events, nextCursor: events.at(-1)?.eventId ?? after, idleChatPush: 'unverified' };
      }
      case 'codex_recover_thread': return this.serial(threadId, () => this.recover(this.thread(threadId)));
      case 'codex_desktop_status': this.receiptThread(threadId); return this.desktop.status(threadId, args.limit ?? 20);
      case 'codex_bind_desktop':
        this.receiptThread(threadId);
        return this.action(name, args, () => {
          if (args.enabled && this.agyWatch.active.has(threadId)) {
            throw new BridgeError('AGY_WAIT_ALREADY_ACTIVE', 'Pause the current Antigravity watch before enabling Sidecar delivery.');
          }
          return this.desktop.bind(args);
        });
      default: return this.action(name, args, () => this.serial(threadId, () => this.changeThread(name, args, this.thread(threadId))));
    }
  }

  async changeThread(name, args, row) {
    const threadId = row.id;
    switch (name) {
      case 'codex_bind_desktop': return this.desktop.bind(args);
      case 'codex_fork_thread': {
        this.assertIdle(threadId);
        if (this.shared && !this.workspaceTarget(row.workspace)?.nativeProjectId) {
          throw new BridgeError('DESKTOP_WORKSPACE_NOT_REGISTERED', 'Register the original workspace in the desktop sidebar before forking this chat.');
        }
        await this.load(row);
        try {
          const { thread, model } = await this.rpc('thread/fork', {
            threadId, model: row.model, excludeTurns: true, deferGoalContinuation: true,
            developerInstructions: instructions, sandbox: 'workspace-write'
          });
          if (this.shared) this.verifyDesktopChat(thread.id, thread, this.workspaceTarget(row.workspace));
          const result = await this.registerThread(thread.id, row.workspace, args.title, model ?? row.model, row.effort);
          this.releaseThread(thread.id);
          return { sourceThreadId: threadId, ...result };
        } finally {
          this.releaseThread(threadId);
        }
      }
      case 'codex_send_message': {
        const receipt = await this.send(row, args);
        if (this.shared && args.conversationId) this.agyWatch.expect(args.conversationId, threadId, receipt.after);
        return receipt;
      }
      case 'codex_set_model': {
        const model = await this.selectModel(args.model, args.effort);
        const nativeApplied = !!this.shared && !row.archived;
        if (nativeApplied) {
          if (!this.workspaceTarget(row.workspace)?.nativeProjectId) throw new BridgeError('DESKTOP_WORKSPACE_NOT_REGISTERED', 'The original workspace must still be registered in the desktop sidebar.');
          try {
            await this.load(row);
            await this.rpc('thread/settings/update', { threadId, model, effort: args.effort ?? null });
          } finally {
            if (!this.pendingTurn(threadId)) this.releaseThread(threadId);
          }
        }
        this.store.run('UPDATE threads SET model = ?, effort = ? WHERE id = ?', model, args.effort ?? null, threadId);
        if (this.shared) this.store.run('UPDATE desktop_threads SET model=?,effort=? WHERE id=?', model, args.effort ?? null, threadId);
        return { thread: this.describe(this.thread(threadId)), effective: 'next_turn', nativeApplied };
      }
      case 'codex_rename_thread':
        await this.rpc('thread/name/set', { threadId, name: args.title });
        this.store.run('UPDATE threads SET title = ? WHERE id = ?', args.title, threadId);
        if (this.shared) this.store.run('UPDATE desktop_threads SET title=? WHERE id=?', args.title, threadId);
        return { thread: this.describe(this.thread(threadId)) };
      case 'codex_archive_thread':
        this.assertIdle(threadId);
        const { thread } = await this.rpc('thread/read', { threadId, includeTurns: false });
        if (thread.status.type === 'active') throw new BridgeError('TURN_ACTIVE', 'Wait for the native turn to end before archiving or restoring this chat.');
        const archived = thread.path ? /[/\\]archived_sessions[/\\][^/\\]+$/.test(thread.path) : !!row.archived;
        if (archived !== args.archived) {
          await this.rpc(args.archived ? 'thread/archive' : 'thread/unarchive', { threadId });
          this.loaded.delete(threadId);
        }
        this.store.run('UPDATE threads SET archived = ? WHERE id = ?', args.archived ? 1 : 0, threadId);
        if (this.shared) this.store.run('UPDATE desktop_threads SET archived=? WHERE id=?', args.archived ? 1 : 0, threadId);
        return { thread: this.describe(this.thread(threadId)) };
      case 'codex_interrupt_turn': {
        const active = this.pendingTurn(threadId);
        if (active?.status !== 'inProgress' || active.id !== args.turnId) throw new BridgeError('TURN_MISMATCH', 'Interrupt requires the exact running turn ID.');
        await this.rpc('turn/interrupt', { threadId, turnId: args.turnId });
        return { threadId, turnId: args.turnId, accepted: true };
      }
      default: throw new BridgeError('TOOL_UNAVAILABLE', `Unknown bridge tool ${name}.`);
    }
  }
}
