import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Bridge } from './bridge.mjs';
import { existingSharedConnection } from './client.mjs';
import { NativeRequestNotSentError } from './codex.mjs';
import { scriptCommand } from './config.mjs';
import { DailyWatch } from './daily-watch.mjs';
import { DesktopDelivery } from './desktop.mjs';
import { watchNativeFeedback } from './native-feedback.mjs';
import { agyMessagingTools, BridgeError, milestoneCadence, milestoneContinuation, tools, validate } from './protocol.mjs';

const specs = new Map([...tools, ...agyMessagingTools].map(tool => [tool.name, tool.inputSchema]));
const terminal = new Set(['completed', 'failed', 'interrupted']);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const sourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const clip = value => typeof value === 'string' ? value.slice(0, 10000) : '';
const actionInput = text => [{ type: 'text', text, text_elements: [] }];
const messageText = item => (item.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const matchKey = value => String(value ?? '').trim().replaceAll('\\', '/').toLowerCase();
const projectKeys = project => [project.name, project.projectId, project.nativeProjectId, ...project.roots].map(matchKey);
const byRecent = (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0);
const activeFirst = (a, b) => Number(b.status === 'active') - Number(a.status === 'active');
const coordinationIntro = [
  'Antigravity now coordinates requirements and reviews direction for this original Codex chat. Keep your project rules, model, technical ownership and any existing DSH session and listeners.',
  `Report progress proactively at a cadence suited to the task. ${milestoneCadence} Combine the last milestone with the final report when they overlap.`,
  `${milestoneContinuation} Continue all previously authorized work without waiting for milestone acknowledgment. When only a real dependency remains, keep the original native wait if available. End the turn only when the full authorized task is complete, the user asks to pause or stop, or a real blocker leaves no useful authorized work or native wait.`,
  'Gemini checks the agreed roadmap and evidence, explains each milestone in plain language for the user, and contacts you about it only for major drift or an evidence-backed improvement to the next step.',
  `Report material blockers, writing handoffs and roadmap decisions as appropriate. To report explicitly from Windows, send the paragraph via stdin to ${scriptCommand('daily.mjs')} feedback --native-output REPORT_ID --text KIND.`
].join('\n');

export class DailyBridge extends Bridge {
  constructor(store, { connection = existingSharedConnection, desktopFile = join(homedir(), '.codex/.codex-global-state.json') } = {}) {
    super(store, { projectFile: null });
    this.connectDesktop = connection;
    this.desktopFile = desktopFile;
    this.desktop = new DesktopDelivery(store, true);
    this.agyWatch = new DailyWatch(store);
    this.refreshing = new Set();
    this.dirty = new Set();
    this.feedbackWatches = new Map();
    this.reconnectDelay = 1000;
    store.db.exec(`CREATE TABLE IF NOT EXISTS daily_queue (
      id TEXT PRIMARY KEY, thread TEXT NOT NULL, conversation TEXT NOT NULL,
      marker TEXT NOT NULL, queue_id TEXT, turn TEXT, created_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS daily_queue_by_thread ON daily_queue(thread,turn);`);
  }

  pendingThreads() {
    return this.store.all(`SELECT thread FROM daily_queue WHERE turn IS NULL
      UNION SELECT thread FROM turns WHERE status IN ('inProgress','uncertain')`);
  }

  restorePending() {
    for (const { thread } of this.pendingThreads()) this.schedule(thread);
  }

  retryConnection() {
    if (this.closed || this.retryTimer || !this.pendingThreads().length) return;
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      if (this.closed) return;
      try {
        await this.connectDaily();
        if (!this.closed) this.restorePending();
      } catch { this.retryConnection(); }
    }, this.reconnectDelay);
    this.retryTimer.unref();
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  onDisconnect() {
    // Creating or closing this observer does not change the shared Codex turn.
    if (this.reconnectDelay === undefined || this.closed) return;
    super.onDisconnect();
    this.retryConnection();
  }

  close() {
    clearTimeout(this.retryTimer);
    for (const watcher of this.feedbackWatches.values()) watcher.close();
    this.feedbackWatches.clear();
    super.close();
  }

  async connectDaily() {
    if (this.codex.info && this.codex.endpoint) return;
    if (!this.connecting) this.connecting = (async () => {
      const { endpoint, desktopTransport } = await this.connectDesktop();
      if (this.closed) throw new Error('The daily bridge has stopped.');
      const client = this.codexClient(endpoint);
      this.codex = client;
      this.desktopTransport = desktopTransport;
      await client.connect();
      this.reconnectDelay = 1000;
    })().finally(() => { this.connecting = null; });
    await this.connecting;
  }

  async rpc(method, params) {
    try { await this.connectDaily(); }
    catch (error) { throw new NativeRequestNotSentError(error.message, { cause: error }); }
    return this.codex.request(method, params);
  }

  desktopState() {
    try { return JSON.parse(readFileSync(this.desktopFile, 'utf8')); }
    catch { return {}; }
  }

  projects(state = this.desktopState()) {
    const hosts = Object.entries(state['app-server-project-id-by-legacy-project-id-by-host'] ?? {});
    return Object.values(state['local-projects'] ?? {}).filter(p => p?.id && Array.isArray(p.rootPaths)).map(p => {
      const native = new Set(hosts.filter(([host]) => host === 'local' || host.startsWith('local:')).map(([, map]) => map[p.id]).filter(Boolean));
      const nativeProjectId = native.size === 1 ? [...native][0] : null;
      return { workspaceId: p.id, projectId: p.id, name: p.name ?? p.label ?? p.rootPaths[0], cwd: p.rootPaths[0] ?? null,
        roots: p.rootPaths, nativeProjectId, hostId: 'local', sidebarStatus: 'registered' };
    });
  }

  nativeProject(project) {
    const roots = project.roots?.map(root => root.path) ?? [];
    return { workspaceId: project.id, projectId: project.id, nativeProjectId: project.id, name: project.name,
      cwd: roots[0] ?? null, roots, hostId: 'local', sidebarStatus: 'native_catalog' };
  }

  async projectCatalog(saved = this.projects()) {
    const projects = [...saved];
    let cursor;
    do {
      const result = await this.rpc('project/list', { limit: 100, cursor });
      projects.push(...result.data.filter(project => !saved.some(entry => entry.nativeProjectId === project.id)).map(project => this.nativeProject(project)));
      cursor = result.nextCursor;
    } while (cursor);
    return projects;
  }

  async resolveProject(selector, saved) {
    const key = matchKey(selector);
    const find = projects => projects.filter(project => projectKeys(project).includes(key));
    const known = find(saved);
    const matches = known.length ? known : find(await this.projectCatalog(saved));
    if (matches.length !== 1) {
      throw new BridgeError(matches.length ? 'PROJECT_NAME_AMBIGUOUS' : 'PROJECT_NOT_FOUND',
        matches.length ? 'More than one project matches. Use the exact project ID or directory from codex_list_projects.'
          : 'No sidebar project matches. Use codex_list_projects with searchTerm to find its name, directory or ID.');
    }
    return matches[0];
  }

  summarize(thread, state = this.desktopState(), projects = this.projects(state)) {
    const membership = state['thread-project-assignments']?.[thread.id];
    const project = thread.projectId ? projects.find(p => p.nativeProjectId === thread.projectId)
      : membership?.projectKind === 'local' ? projects.find(p => p.projectId === membership.projectId) : null;
    return { threadId: thread.id, title: thread.name ?? null, cwd: thread.cwd, status: thread.status?.type,
      workspaceId: project?.workspaceId ?? thread.projectId ?? null, projectId: project?.projectId ?? null,
      nativeProjectId: thread.projectId ?? project?.nativeProjectId ?? null, archived: /[/\\]archived_sessions[/\\]/.test(thread.path ?? '') };
  }

  async nativeThread(threadId) {
    if (!uuid.test(threadId)) throw new BridgeError('INVALID_THREAD_ID', 'Use the exact local Codex chat ID returned by codex_list_threads.');
    const { thread } = await this.rpc('thread/read', { threadId, includeTurns: false });
    if (thread?.id !== threadId) throw new BridgeError('DESKTOP_TARGET_UNVERIFIED', 'The shared desktop did not confirm this exact chat.');
    return thread;
  }

  track(thread) {
    const workspace = this.store.get('SELECT id FROM workspaces WHERE cwd=?', thread.cwd)?.id ?? `cwd:${thread.cwd}`;
    this.store.run('INSERT OR IGNORE INTO workspaces VALUES (?,?)', workspace, thread.cwd);
    this.store.run(`INSERT INTO threads (id,workspace,title,model,created_at) VALUES (?,?,?,'',?)
      ON CONFLICT(id) DO UPDATE SET workspace=excluded.workspace,title=excluded.title`, thread.id, workspace, thread.name ?? null, new Date().toISOString());
    return this.summarize(thread);
  }

  async activeTurnId(threadId) {
    const { data } = await this.rpc('thread/turns/list', { threadId, limit: 1, itemsView: 'notLoaded', sortDirection: 'desc' });
    return data[0]?.status === 'inProgress' ? data[0].id : null;
  }

  async attach({ threadId, conversationId }) {
    this.agyWatch.check(conversationId, threadId);
    const after = this.cursor();
    const metadata = await this.nativeThread(threadId);
    const thread = this.track(metadata);
    const activeTurnId = thread.status === 'active' ? await this.activeTurnId(threadId) : null;
    if (activeTurnId) {
      this.agyWatch.route(threadId, activeTurnId, conversationId);
      this.recordTurn(threadId, activeTurnId, 'inProgress');
      this.agyWatch.expect(conversationId, threadId, after);
      this.schedule(threadId);
    }
    return { thread, activeTurnId, after, observation: activeTurnId ? 'current_turn' : 'no_current_turn' };
  }

  schedule(threadId) {
    if (this.closed) return;
    this.dirty.add(threadId);
    if (this.refreshing.has(threadId)) return;
    this.refreshing.add(threadId);
    queueMicrotask(async () => {
      try { while (!this.closed && this.dirty.delete(threadId)) await this.reconcileDaily(threadId); }
      catch (error) {
        if (!this.closed) console.error(`Daily Codex receipt check: ${error.code ?? error.message}`);
        if (!this.codex.info) this.retryConnection();
      }
      finally { this.refreshing.delete(threadId); }
    });
  }

  onEvent(method, args) {
    const threadId = args?.threadId;
    if (threadId && ['thread/status/changed', 'thread/queue/changed', 'turn/started', 'turn/completed'].includes(method) &&
      this.hasPendingWork(threadId)) {
      this.schedule(threadId);
    }
    if (method !== 'turn/completed' && threadId && this.hasRoute(threadId, args.turn?.id ?? args.turnId ?? '')) {
      super.onEvent(method, args);
    }
  }

  hasRoute(threadId, turnId) {
    return this.store.get('SELECT 1 FROM daily_routes WHERE thread=? AND turn=?', threadId, turnId);
  }

  hasPendingWork(threadId) {
    return this.store.get(`SELECT 1 FROM daily_queue WHERE thread=? AND turn IS NULL UNION ALL
      SELECT 1 FROM turns WHERE thread=? AND status IN ('inProgress','uncertain') LIMIT 1`, threadId, threadId);
  }

  async followNativeFeedback(threadId) {
    if (this.feedbackWatches.has(threadId)) return this.feedbackWatches.get(threadId);
    const { path } = await this.nativeThread(threadId);
    if (!path || this.closed) return;
    if (this.feedbackWatches.has(threadId)) return this.feedbackWatches.get(threadId);
    const reportError = error => {
      console.error(`Daily Codex feedback observer: ${error.code ?? error.name}`);
      this.feedbackWatches.get(threadId)?.close();
      this.feedbackWatches.delete(threadId);
    };
    try {
      const watcher = watchNativeFeedback(path, (turnId, output) => {
        if (!this.closed && this.hasRoute(threadId, turnId)) this.captureNativeFeedbackText(threadId, turnId, output, true);
      }, reportError);
      this.feedbackWatches.set(threadId, watcher);
      return watcher;
    } catch (error) { reportError(error); }
  }

  onRequest(method, params) {
    if (method === 'item/tool/call' && params.tool === 'bridge_report' && !params.namespace) return super.onRequest(method, params);
    const { threadId, turnId, itemId } = params ?? {};
    if (threadId && turnId && itemId && method.endsWith('/requestApproval') &&
      this.store.get('SELECT 1 FROM daily_routes WHERE thread=? AND turn=?', threadId, turnId)) {
      this.store.event(threadId, turnId, `approval:${itemId}`, 'blocker', {
        summary: 'Codex 原会话收到了审批请求。请在 Codex 桌面原会话处理。', activeReport: false, method
      });
    }
    return undefined;
  }

  async reconcileDaily(threadId) {
    const queued = this.store.all('SELECT * FROM daily_queue WHERE thread=? AND turn IS NULL', threadId);
    const tracked = new Set(this.store.all("SELECT id FROM turns WHERE thread=? AND status IN ('inProgress','uncertain')", threadId)
      .map(row => row.id));
    if (!queued.length && !tracked.size) {
      this.feedbackWatches.get(threadId)?.close();
      this.feedbackWatches.delete(threadId);
      return;
    }
    const { data } = await this.history(threadId, { limit: 20 });
    if (this.closed) return;
    for (const turn of data) {
      const inputs = (turn.items ?? []).filter(item => item.type === 'userMessage');
      for (const request of queued.filter(row => inputs.some(item => item.clientId === row.id ||
        (row.marker && messageText(item).startsWith(`${row.marker}\n`))))) {
        this.store.transaction(() => {
          this.store.run('UPDATE daily_queue SET turn=? WHERE id=? AND turn IS NULL', turn.id, request.id);
          this.agyWatch.route(threadId, turn.id, request.conversation);
          this.recordTurn(threadId, turn.id, 'inProgress');
        });
        tracked.add(turn.id);
        this.store.emit('daily-dispatch', request.id);
      }
    }
    const watcher = await this.followNativeFeedback(threadId);
    await watcher?.refresh();
    if (this.closed) return;
    let confirmedInterruptions;
    // Persisted history can show an unfinished live turn as interrupted during startup.
    // Wait for native events while the chat is active, then read history again after it settles.
    if (data.some(turn => tracked.has(turn.id) && turn.status === 'interrupted')) {
      const { status } = await this.nativeThread(threadId);
      if (status.type !== 'active') {
        const latest = await this.history(threadId, { limit: 20 });
        confirmedInterruptions = new Map(latest.data.map(turn => [turn.id, turn]));
      }
    }
    if (this.closed) return;
    for (const recorded of data) {
      if (!tracked.has(recorded.id) || !this.hasRoute(threadId, recorded.id)) continue;
      const turn = recorded.status === 'interrupted' ? confirmedInterruptions?.get(recorded.id) : recorded;
      if (!turn) continue;
      if (terminal.has(turn.status)) {
        this.store.run("UPDATE turns SET status='uncertain' WHERE thread=? AND id=? AND status='inProgress'", threadId, turn.id);
        this.complete(threadId, turn, true);
      } else if (turn.status === 'inProgress') {
        for (const item of turn.items ?? []) this.captureNativeFeedback(threadId, turn.id, item, true);
      }
    }
    if (watcher && !this.hasPendingWork(threadId)) {
      watcher.close();
      this.feedbackWatches.delete(threadId);
    }
  }

  async sendDailyMessage(args) {
    const { threadId, conversationId, requestId, decisionEventId } = args;
    this.agyWatch.check(conversationId, threadId);
    const native = await this.nativeThread(threadId);
    const thread = this.track(native);
    if (thread.archived) throw new BridgeError('THREAD_ARCHIVED', 'Restore the selected Codex chat before sending.');
    const delivery = args.delivery ?? (thread.status === 'active' ? 'steer' : 'next_turn');
    let expectedTurnId = args.expectedTurnId;
    if (delivery === 'steer') {
      if (!args.delivery && !expectedTurnId) expectedTurnId = await this.activeTurnId(threadId);
      if (thread.status !== 'active' || !expectedTurnId) {
        throw new BridgeError('TURN_MISMATCH', 'The exact active turn could not be confirmed. Read the original chat before sending again.');
      }
    }
    if (delivery === 'next_turn' && thread.status === 'active') throw new BridgeError('TURN_ACTIVE', 'Omit delivery to send directly or use after_turn to wait for the next turn.');
    if (decisionEventId && !this.store.get("SELECT 1 FROM events WHERE seq=? AND thread=? AND kind='decision'", decisionEventId, threadId)) {
      throw new BridgeError('DECISION_NOT_FOUND', 'Use an unresolved decision from the exact selected chat.');
    }
    if (decisionEventId && this.store.get('SELECT 1 FROM resolutions WHERE event=?', decisionEventId)) throw new BridgeError('DECISION_ALREADY_BOUND', 'This decision already has a reply.');
    if (thread.status === 'notLoaded') await this.rpc('thread/resume', { threadId, excludeTurns: true });
    const after = this.cursor();
    const marker = args.purpose === 'coordination'
      ? `[Antigravity request ${createHash('sha256').update(requestId).digest('hex').slice(0, 20)}]`
      : '';
    const decision = decisionEventId ? `\nCoordinator reply to decision #${decisionEventId}. Apply the existing task authorization.` : '';
    const input = actionInput(marker
      ? `${marker}\n${coordinationIntro}${decision}\n\n${args.prompt}`
      : args.prompt);
    this.store.transaction(() => {
      this.store.run('INSERT INTO daily_queue (id,thread,conversation,marker,created_at) VALUES (?,?,?,?,?)', requestId, threadId, conversationId, marker, new Date().toISOString());
      if (decisionEventId) this.store.run('INSERT INTO resolutions (event,action) VALUES (?,?)', decisionEventId, requestId);
      this.agyWatch.expect(conversationId, threadId, after);
    });
    try {
      if (delivery !== 'after_turn') {
        const message = { threadId, input, clientUserMessageId: requestId };
        const result = delivery === 'steer'
          ? await this.rpc('turn/steer', { ...message, expectedTurnId })
          : await this.rpc('turn/start', message);
        const turnId = result.turnId ?? result.turn?.id;
        if (!turnId || (delivery === 'steer' && turnId !== expectedTurnId)) throw new Error('Codex did not confirm a matching turn. Check the original request before retrying.');
        this.store.transaction(() => {
          this.store.run('UPDATE daily_queue SET turn=? WHERE id=?', turnId, requestId);
          this.agyWatch.route(threadId, turnId, conversationId);
          this.recordTurn(threadId, turnId, 'inProgress');
        });
        this.store.emit('daily-dispatch', requestId);
        this.schedule(threadId);
        return { threadId, turnId, after, accepted: true, state: 'accepted', delivery };
      }
      const { queuedSubmission } = await this.rpc('thread/queue/add', { threadId, input, clientUserMessageId: requestId });
      if (!queuedSubmission?.id) throw new Error('Native queue acceptance is uncertain. Check the existing request before retrying.');
      this.store.run('UPDATE daily_queue SET queue_id=? WHERE id=?', queuedSubmission.id, requestId);
      this.schedule(threadId);
      return { threadId, after, accepted: false, state: 'queued', queueId: queuedSubmission.id, delivery };
    } catch (error) {
      if (error.code === 'CODEX_RPC_ERROR' || error instanceof NativeRequestNotSentError) this.store.transaction(() => {
        this.store.run('DELETE FROM daily_queue WHERE id=?', requestId);
        if (decisionEventId) this.store.run('DELETE FROM resolutions WHERE event=? AND action=?', decisionEventId, requestId);
      });
      throw error;
    }
  }

  async listChats(args) {
    const state = this.desktopState();
    const projects = this.projects(state);
    const project = args.workspaceId ? await this.resolveProject(args.workspaceId, projects) : null;
    if (args.activeOnly) return this.listActiveChats(args, state, projects, project);
    if (project) return this.listProjectChats(args, state, projects, project);
    const limit = args.limit ?? 25;
    const result = await this.rpc('thread/list', { archived: args.archived ?? false, limit, cursor: args.cursor,
      searchTerm: args.searchTerm, sourceKinds });
    return { threads: result.data.map(thread => this.summarize(thread, state, projects)), nextCursor: result.nextCursor ?? null };
  }

  async threadMetadata(ids) {
    const threads = [];
    for (let offset = 0; offset < ids.length; offset += 16) {
      const batch = await Promise.all(ids.slice(offset, offset + 16).map(async id => {
        try { return await this.nativeThread(id); }
        catch (error) {
          if (error.code === 'CODEX_RPC_ERROR' && /not found|no rollout|not persisted/i.test(error.message)) return null;
          throw error;
        }
      }));
      threads.push(...batch.filter(Boolean));
    }
    return threads;
  }

  async listActiveChats(args, state, projects, project) {
    const { data } = await this.rpc('thread/loaded/list', {});
    const matches = (await this.threadMetadata(data)).sort(byRecent)
      .map(thread => this.summarize(thread, state, projects)).filter(thread => thread.status === 'active' &&
        thread.archived === (args.archived ?? false) && (!project || thread.workspaceId === project.workspaceId) &&
        matchKey(thread.title).includes(matchKey(args.searchTerm)));
    const offset = Number(args.cursor?.match(/^active:(\d+)$/)?.[1] ?? 0);
    if (args.cursor && !/^active:\d+$/.test(args.cursor)) throw new BridgeError('INVALID_CURSOR', 'Use the cursor returned by the active chat listing.');
    const end = offset + (args.limit ?? 25);
    return { project, threads: matches.slice(offset, end), nextCursor: end < matches.length ? `active:${end}` : null };
  }

  async listProjectChats(args, state, projects, project) {
    const limit = args.limit ?? 25;
    const archived = args.archived ?? false;
    let cursor = args.cursor;
    const threads = [];
    let legacyEnd;
    if (!cursor || cursor.startsWith('legacy:')) {
      const offset = Number(cursor?.slice('legacy:'.length) ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new BridgeError('INVALID_CURSOR', 'Use the cursor returned by the project chat listing.');
      const assigned = Object.entries(state['thread-project-assignments'] ?? {})
        .filter(([, value]) => value.projectKind === 'local' && value.projectId === project.projectId).map(([id]) => id);
      const legacy = (await this.threadMetadata(assigned)).filter(thread => !thread.projectId).sort(byRecent)
        .map(thread => this.summarize(thread, state, projects)).filter(thread => thread.archived === archived && matchKey(thread.title).includes(matchKey(args.searchTerm)))
        .sort(activeFirst);
      legacyEnd = offset + limit;
      threads.push(...legacy.slice(offset, legacyEnd));
      if (legacyEnd < legacy.length) return { project, threads, nextCursor: `legacy:${legacyEnd}` };
      cursor = undefined;
    }
    if (!project.nativeProjectId) return { project, threads, nextCursor: null };
    const result = await this.rpc('thread/list', { projectId: project.nativeProjectId, archived,
      limit: Math.max(1, limit - threads.length), cursor, searchTerm: args.searchTerm, sourceKinds, useStateDbOnly: true });
    if (threads.length === limit) return { project, threads, nextCursor: result.data.length ? `legacy:${legacyEnd}` : null };
    threads.push(...result.data.map(thread => this.summarize(thread, state, projects)));
    return { project, threads: threads.sort(activeFirst), nextCursor: result.nextCursor ?? null };
  }

  listAgyListeners() {
    return [...this.agyWatch.listeners(), ...this.desktop.listeners()];
  }

  sendAgyMessage({ conversationId, requestId, text }) {
    const listener = this.listAgyListeners().find(entry => entry.conversationId === conversationId);
    if (!listener) throw new BridgeError('AGY_LISTENER_INACTIVE', 'The selected conversation has no active background wait or Sidecar delivery path.');
    const event = this.store.transaction(() => {
      const event = this.store.event(listener.threadId, null, `agy-message:${requestId}`, 'agy_message', {
        summary: text, source: 'codex_bridge_message', activeReport: false
      });
      this.store.run('INSERT INTO daily_messages (event,request,conversation,path) VALUES (?,?,?,?)', event.eventId, requestId, conversationId, listener.path);
      return event;
    });
    return { conversationId, eventId: event.eventId, path: listener.path, state: 'accepted' };
  }

  messageStatus(requestId) {
    const row = this.store.get(`SELECT m.event AS eventId,m.conversation AS conversationId,m.path,m.returned,d.state
      FROM daily_messages m LEFT JOIN push_deliveries d ON d.event=m.event WHERE m.request=?`, requestId);
    if (!row) throw new BridgeError('AGY_MESSAGE_NOT_FOUND', 'Use the original Antigravity message request ID.');
    const { returned, state, ...message } = row;
    return { requestId, ...message, state: returned ? 'returned_to_waiter' : state ?? 'accepted' };
  }

  messageReturned(conversationId, event) {
    if (event?.kind === 'agy_message') this.store.run('UPDATE daily_messages SET returned=1 WHERE event=? AND conversation=?', event.eventId, conversationId);
  }

  async invoke(name, args, signal) {
    if (specs.has(name)) validate(specs.get(name), args);
    const { threadId, conversationId } = args;
    switch (name) {
      case 'agy_list_listeners': return { listeners: this.listAgyListeners() };
      case 'agy_send_message': return this.action(name, args, () => this.sendAgyMessage(args));
      case 'agy_message_status': return this.messageStatus(args.requestId);
      case 'bridge_status':
        await this.connectDaily();
        return { backend: 'existing_shared_codex_desktop', desktopTransport: this.desktopTransport,
          scope: 'all_local_codex_for_antigravity', ready: true, defaultDelivery: 'direct' };
      case 'codex_list_projects': {
        const term = matchKey(args.searchTerm);
        const projects = (await this.projectCatalog()).filter(project => projectKeys(project).some(value => value.includes(term)));
        return { projects, nextCursor: null };
      }
      case 'codex_list_threads': return this.listChats(args);
      case 'codex_read_thread': {
        const thread = this.summarize(await this.nativeThread(threadId));
        const result = await this.history(threadId, args);
        return { thread, nextCursor: result.nextCursor ?? null, turns: result.data.map(turn => ({ turnId: turn.id, status: turn.status,
          messages: (turn.items ?? []).flatMap(item => item.type === 'userMessage' ? [{ role: 'user', text: clip(messageText(item)) }]
            : item.type === 'agentMessage' ? [{ role: 'assistant', phase: item.phase, text: clip(item.text) }] : []) })) };
      }
      case 'codex_read_items':
        await this.nativeThread(threadId);
        return this.rpc('thread/items/list', { threadId, turnId: args.turnId, cursor: args.cursor, limit: args.limit ?? 10 });
      case 'codex_attach_thread': return this.action(name, args, () => this.attach(args));
      case 'codex_send_message':
        // The queue row is committed before any native send. No row means an old started action is safe to retry.
        return this.action(name, args, () => this.serial(threadId, () => this.sendDailyMessage(args)),
          () => !this.store.get('SELECT 1 FROM daily_queue WHERE id = ?', args.requestId));
      case 'codex_wait_dispatch': {
        const status = () => {
          const row = this.store.get('SELECT * FROM daily_queue WHERE id=?', args.requestId);
          if (!row) throw new BridgeError('DISPATCH_NOT_FOUND', 'Use the original daily request ID.');
          return row.turn && { requestId: row.id, threadId: row.thread, turnId: row.turn, accepted: true, state: 'accepted' };
        };
        const row = this.store.get('SELECT thread FROM daily_queue WHERE id=?', args.requestId);
        if (row) this.schedule(row.thread);
        return this.store.onUpdate('daily-dispatch', status, signal ?? new AbortController().signal, id => !id || id === args.requestId);
      }
      case 'codex_wait':
        if (conversationId) for (const id of args.threadIds) this.schedule(id);
        return super.invoke(name, args, signal);
      case 'codex_recover_thread':
        this.thread(threadId);
        await this.reconcileDaily(threadId);
        return { thread: this.receiptThread(threadId), pendingRequests: this.store.all('SELECT id AS requestId,queue_id AS queueId FROM daily_queue WHERE thread=? AND turn IS NULL', threadId), replayed: false };
      case 'codex_bind_desktop':
        this.agyWatch.check(conversationId, threadId);
        if (args.enabled && this.agyWatch.active.has(`${conversationId}/${threadId}`)) throw new BridgeError('AGY_WAIT_ALREADY_ACTIVE', 'Close this conversation’s background wait before enabling Sidecar notices.');
        this.thread(threadId);
        return this.action(name, args, () => this.desktop.bind(args));
      case 'codex_inbox':
        if (!threadId && !args.eventId) return { threads: this.store.all('SELECT * FROM threads ORDER BY rowid DESC LIMIT 50').map(row => this.describe(row)) };
        return super.invoke(name, args, signal);
      case 'codex_create_thread': return this.action(name, args, () => this.createDaily(args));
      case 'codex_rename_thread': return this.action(name, args, async () => {
        await this.nativeThread(threadId);
        await this.rpc('thread/name/set', { threadId, name: args.title });
        return { thread: this.summarize(await this.nativeThread(threadId)) };
      });
      case 'codex_archive_thread': return this.action(name, args, async () => {
        const thread = await this.nativeThread(threadId);
        if (thread.status.type === 'active') throw new BridgeError('TURN_ACTIVE', 'The selected chat is still active.');
        await this.rpc(args.archived ? 'thread/archive' : 'thread/unarchive', { threadId });
        return { threadId, archived: args.archived };
      });
      case 'codex_set_model': return this.action(name, args, async () => {
        const model = await this.selectModel(args.model, args.effort);
        const thread = await this.nativeThread(threadId);
        if (thread.status.type === 'notLoaded') await this.rpc('thread/resume', { threadId, excludeTurns: true });
        await this.rpc('thread/settings/update', { threadId, model, effort: args.effort ?? null });
        return { threadId, model, effort: args.effort ?? null, effective: 'next_turn' };
      });
      case 'codex_fork_thread': return this.action(name, args, async () => {
        await this.nativeThread(threadId);
        const { thread } = await this.rpc('thread/fork', { threadId, excludeTurns: true, deferGoalContinuation: true });
        await this.rpc('thread/name/set', { threadId: thread.id, name: args.title });
        return { sourceThreadId: threadId, thread: this.summarize(await this.nativeThread(thread.id)) };
      });
      case 'codex_interrupt_turn': return this.action(name, args, async () => {
        await this.nativeThread(threadId);
        await this.rpc('turn/interrupt', { threadId, turnId: args.turnId });
        return { threadId, turnId: args.turnId, accepted: true };
      });
      case 'codex_create_project': return this.action(name, args, async () => {
        if (args.cwd && !isAbsolute(args.cwd)) throw new BridgeError('PROJECT_PATH_INVALID', 'Specify an existing absolute folder path.');
        const cwd = args.cwd ? realpathSync(args.cwd) : this.workspaceCreate(args.name).workspace.cwd;
        if (!statSync(cwd).isDirectory()) throw new BridgeError('PROJECT_PATH_INVALID', 'The Codex project path must be a folder.');
        const existing = this.projects().find(p => p.roots.length === 1 && p.cwd?.toLowerCase() === cwd.toLowerCase());
        if (existing) return { workspace: existing, created: false, readyToDispatch: !!existing.nativeProjectId };
        const { project } = await this.rpc('project/create', { name: args.name, roots: [{ path: cwd }], idempotencyKey: args.requestId });
        const workspace = this.projects().find(p => p.nativeProjectId === project.id) ?? this.nativeProject(project);
        if (realpathSync(workspace.cwd) !== cwd) throw new BridgeError('DESKTOP_PROJECT_ROOT_MISMATCH', 'The native project resolved to a different folder.');
        return { workspace, created: true, readyToDispatch: true };
      });
      default: return super.invoke(name, args, signal);
    }
  }

  async createDaily(args) {
    if (args.prompt || args.conversationId) this.agyWatch.check(args.conversationId);
    const saved = this.projects().find(p => p.workspaceId === args.workspaceId || p.nativeProjectId === args.workspaceId);
    if (saved && !saved.nativeProjectId) throw new BridgeError('DESKTOP_PROJECT_REQUIRED', 'The desktop project does not have a known native ID.');
    const { project: native } = await this.rpc('project/read', { projectId: saved?.nativeProjectId ?? args.workspaceId });
    const project = saved ?? this.nativeProject(native);
    if (native.roots.length !== 1 || project.roots.length !== 1 || realpathSync(native.roots[0].path) !== realpathSync(project.cwd)) {
      throw new BridgeError('DESKTOP_PROJECT_ROOT_MISMATCH', 'The saved sidebar and native roots differ. Existing chats remain addressable by their original IDs.');
    }
    const model = await this.selectModel(args.model ?? 'gpt-6.2-sol', args.effort);
    const { thread } = await this.rpc('thread/start', { cwd: project.cwd, projectId: project.nativeProjectId, model });
    if (thread.projectId !== project.nativeProjectId || realpathSync(thread.cwd) !== realpathSync(project.cwd)) {
      throw new BridgeError('DESKTOP_TARGET_UNVERIFIED', 'The created Codex chat did not confirm the requested project and directory.');
    }
    await this.rpc('thread/name/set', { threadId: thread.id, name: args.title });
    if (args.effort) await this.rpc('thread/settings/update', { threadId: thread.id, model, effort: args.effort });
    const created = this.track({ ...thread, name: args.title });
    if (!args.prompt) return { thread: created, threadId: thread.id, state: 'created' };
    return { thread: created, ...await this.sendDailyMessage({ ...args, threadId: thread.id }) };
  }
}
