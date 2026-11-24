import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BridgeError, feedbackSchema, validate } from './protocol.mjs';
import { isBridgeProject } from './desktop.mjs';

const terminal = new Set(['accepted', 'completed', 'failed', 'uncertain']);
const nativeTurnMethods = new Set(['codex_create_thread', 'codex_send_message']);
const role = readFileSync(new URL('../docs/codex-role.md', import.meta.url), 'utf8').trim();
const reportPrefix = requestId => `desktop-report:${JSON.stringify(requestId)}:`;
const ordered = value => Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
const id = (value, field) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 150) throw new BridgeError('INVALID_ARGUMENT', `Invalid ${field}.`);
  return value;
};

function workerArgs(method, args) {
  if (!nativeTurnMethods.has(method)) return args;
  const context = [
    ...(method === 'codex_create_thread' ? [role] : []),
    `本轮派工编号为 ${JSON.stringify(args.requestId)}。需要主动回执时，用 desktop-feedback.mjs --text 传一段话，并沿用本轮派工编号与稳定回执编号。`,
    ...(args.decisionEventId ? [`这条续接对应原聊天的决策回执 #${args.decisionEventId}。按现有任务授权处理；需要新增用户批准的动作等批准明确后再执行。`] : [])
  ];
  return { ...args, prompt: [...context, '## 本轮任务', args.prompt].join('\n\n') };
}

function conversationHistory({ turns, page }) {
  return { page, turns: turns.map(turn => ({
    id: turn.id,
    status: turn.status,
    items: (turn.items ?? []).flatMap(item => {
      if (item.type === 'agentMessage' && typeof item.text === 'string') {
        return [{ type: item.type, phase: item.phase, text: item.text }];
      }
      if (item.type === 'userMessage') {
        const parts = Array.isArray(item.content) ? item.content : [];
        const text = item.text ?? parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
        if (typeof text === 'string') return [{ type: item.type, text }];
      }
      return [];
    })
  })) };
}

export class DesktopOperator {
  constructor(store) {
    this.store = store;
    this.waiting = false;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS desktop_project_binding (singleton INTEGER PRIMARY KEY CHECK(singleton=1), project TEXT NOT NULL, label TEXT NOT NULL, cwd TEXT NOT NULL, host TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_threads (id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, model TEXT, effort TEXT, created_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS desktop_dispatch (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, hash TEXT NOT NULL, method TEXT NOT NULL, payload TEXT NOT NULL, thread TEXT, state TEXT NOT NULL, cursor INTEGER NOT NULL, result TEXT);
      CREATE INDEX IF NOT EXISTS desktop_dispatch_by_thread ON desktop_dispatch (thread, seq);
    `);
    if (!store.get("SELECT 1 FROM pragma_table_info('desktop_threads') WHERE name='archived'")) {
      store.db.exec('ALTER TABLE desktop_threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    }
  }

  project() {
    return this.store.get('SELECT project AS projectId, label AS workspaceId, cwd, host AS hostId FROM desktop_project_binding WHERE singleton=1');
  }

  configure({ projectId, label, cwd, hostId }) {
    if (!isBridgeProject(cwd) || hostId !== 'local') throw new BridgeError('DESKTOP_PROJECT_REQUIRED', 'Only the verified local bridge project can be registered for this pilot.');
    const current = this.project();
    if (current && current.projectId !== projectId) throw new BridgeError('DESKTOP_PROJECT_CHANGED', 'Review the existing project bindings before replacing this project.');
    this.store.run('INSERT OR IGNORE INTO desktop_project_binding VALUES (1, ?, ?, ?, ?)', id(projectId, 'projectId'), id(label, 'label'), cwd, hostId);
    return this.project();
  }

  find(threadId) {
    const row = this.store.get('SELECT * FROM desktop_threads WHERE id=?', threadId);
    if (!row) return null;
    const { workspaceId, cwd, hostId, projectId } = this.project();
    const action = this.store.get("SELECT state FROM desktop_dispatch WHERE thread=? AND method IN ('codex_create_thread','codex_send_message') ORDER BY seq DESC LIMIT 1", row.id);
    const status = action?.state === 'accepted' ? 'dispatched' : (action?.state ?? 'idle');
    return { threadId: row.id, title: row.title, model: row.model, effort: row.effort, createdAt: row.created_at,
      workspaceId, cwd, hostId, projectId, status: row.archived ? 'archived' : status, archived: !!row.archived };
  }

  list(limit = 20, before = Number.MAX_SAFE_INTEGER, archived = null, workspace = null) {
    const filter = archived === null ? null : Number(archived);
    const rows = this.store.all(`SELECT d.rowid AS seq,d.id FROM desktop_threads d LEFT JOIN threads t ON d.id=t.id
      WHERE d.rowid < ? AND (? IS NULL OR d.archived=?) AND (? IS NULL OR COALESCE(t.workspace,?)=?) ORDER BY d.rowid DESC LIMIT ?`,
      before, filter, filter, workspace, this.project()?.workspaceId ?? null, workspace, limit + 1);
    return { threads: rows.slice(0, limit).map(row => this.find(row.id)), nextCursor: rows.length > limit ? rows[limit - 1].seq : null };
  }

  dispatch(requestId) {
    const row = this.store.get('SELECT * FROM desktop_dispatch WHERE id=?', requestId);
    if (!row) throw new BridgeError('DISPATCH_NOT_FOUND', 'The desktop request ID was not found.');
    return row;
  }

  receipt(row) {
    return { requestId: row.id, state: row.state, after: row.cursor, ...(row.result ? JSON.parse(row.result) : {}) };
  }

  pending() {
    const rows = this.store.all("SELECT id,method,thread,state FROM desktop_dispatch WHERE state IN ('queued','claimed','accepted','uncertain') ORDER BY seq");
    return { waiting: this.waiting, requests: rows.map(row => ({ requestId: row.id, method: row.method, threadId: row.thread, state: row.state })) };
  }

  submit(method, args, cursor) {
    const project = this.project();
    if (!project) throw new BridgeError('DESKTOP_HOST_REQUIRED', 'A Codex desktop executor must verify and register the project before dispatch.');
    const fingerprint = JSON.stringify([method, ordered(args)]);
    const hash = createHash('sha256').update(fingerprint).digest('hex');
    const existing = this.store.get('SELECT * FROM desktop_dispatch WHERE id=?', args.requestId);
    if (existing) {
      if (existing.hash !== hash) throw new BridgeError('REQUEST_ID_REUSED', 'This ID already identifies different desktop dispatch arguments.');
      return { ...this.receipt(existing), replayed: true };
    }
    if (method === 'codex_create_thread' && (args.workspaceId !== project.workspaceId || !args.prompt)) throw new BridgeError('DESKTOP_PROJECT_REQUIRED', 'Use the registered desktop workspace and provide an initial task.');
    if (args.threadId) {
      const thread = this.find(args.threadId);
      if (!thread) throw new BridgeError('THREAD_OUTSIDE_BRIDGE', 'Only a verified desktop chat created through this bridge can receive this operation.');
      if (args.delivery === 'steer') throw new BridgeError('DESKTOP_STEER_UNAVAILABLE', 'The desktop executor supports a follow-up after completion.');
      if (['codex_send_message', 'codex_fork_thread'].includes(method)) {
        if (thread.archived) throw new BridgeError('THREAD_ARCHIVED', 'Restore this chat before dispatching this operation.');
        const archive = this.store.get(
          "SELECT 1 FROM desktop_dispatch WHERE thread=? AND method='codex_archive_thread' AND state IN ('queued','claimed','uncertain')", args.threadId);
        if (archive) throw new BridgeError('ARCHIVE_PENDING', 'Wait for the chat archive operation before dispatching this operation.');
      }
    }
    this.store.transaction(() => {
      if (args.decisionEventId) {
        const event = this.store.get("SELECT 1 FROM events WHERE seq=? AND thread=? AND kind='decision'", args.decisionEventId, args.threadId);
        if (!event) throw new BridgeError('DECISION_NOT_FOUND', 'This decision does not belong to the target.');
        if (this.store.get('SELECT 1 FROM resolutions WHERE event=?', args.decisionEventId)) throw new BridgeError('DECISION_ALREADY_BOUND', 'A reply is already queued for this decision.');
        this.store.run('INSERT INTO resolutions (event,action) VALUES (?,?)', args.decisionEventId, args.requestId);
      }
      this.store.run("INSERT INTO desktop_dispatch (id,hash,method,payload,thread,state,cursor) VALUES (?,?,?,?,?,'queued',?)",
        args.requestId, hash, method, JSON.stringify(args), args.threadId ?? null, cursor);
    });
    const queued = this.receipt(this.dispatch(args.requestId));
    this.store.emit('desktop-dispatch');
    return queued;
  }

  async take(signal) {
    if (this.waiting) throw new BridgeError('DESKTOP_OPERATOR_ALREADY_WAITING', 'Use the original desktop executor wait.');
    this.waiting = true;
    try {
      return await this.store.onUpdate('desktop-dispatch', () => this.store.transaction(() => {
        if (this.store.get("SELECT 1 FROM desktop_dispatch WHERE state='claimed'")) return null;
        const row = this.store.get(`SELECT d.* FROM desktop_dispatch d WHERE d.state='queued' AND (d.method='codex_read_thread' OR NOT EXISTS (
          SELECT 1 FROM desktop_dispatch p WHERE p.thread=d.thread AND p.seq<d.seq AND p.state IN ('queued','accepted','claimed','uncertain'))) ORDER BY d.seq LIMIT 1`);
        if (!row) return null;
        this.store.run("UPDATE desktop_dispatch SET state='claimed' WHERE id=?", row.id);
        return { requestId: row.id, method: row.method, args: workerArgs(row.method, JSON.parse(row.payload)),
          project: this.project(), thread: row.thread ? this.find(row.thread) : null };
      }), signal);
    } finally { this.waiting = false; }
  }

  wait(requestId, signal) {
    return this.store.onUpdate('desktop-dispatch', () => {
      const row = this.dispatch(requestId);
      return terminal.has(row.state) ? this.receipt(row) : null;
    }, signal);
  }

  finish({ requestId, outcome, threadId, projectId, cwd, hostId, title, message, history, archived, sourceThreadId }) {
    const row = this.dispatch(requestId);
    const claimed = row.state === 'claimed' && ['accepted', 'failed', 'uncertain'].includes(outcome);
    const reconciled = row.state === 'uncertain' && ['accepted', 'failed'].includes(outcome) && typeof message === 'string' && message.trim();
    if (!claimed && !reconciled) throw new BridgeError('DISPATCH_STATE_MISMATCH', 'Record the claimed action or include native reconciliation evidence for an uncertain action.');
    const args = JSON.parse(row.payload);
    const result = { accepted: outcome === 'accepted' };
    const fork = row.method === 'codex_fork_thread';
    this.store.transaction(() => {
      if (outcome === 'accepted') {
        const correctChat = fork ? row.thread === sourceThreadId && row.thread !== threadId : (!row.thread || row.thread === threadId);
        if (!isBridgeProject(cwd) || projectId !== this.project()?.projectId || hostId !== this.project()?.hostId || !correctChat) {
          throw new BridgeError('DESKTOP_TARGET_UNVERIFIED', 'Native sidebar evidence must match the registered project, path and chat.');
        }
        if (fork && title !== args.title) throw new BridgeError('DESKTOP_TITLE_UNVERIFIED', 'Use the title confirmed for the new desktop fork.');
        if (row.method === 'codex_create_thread' || fork) {
          const source = fork ? this.find(sourceThreadId) : null;
          this.store.run('INSERT INTO desktop_threads (id,project,title,model,effort,created_at) VALUES (?,?,?,?,?,?)', id(threadId, 'threadId'), projectId,
            id(title, 'title'), source?.model ?? args.model ?? 'gpt-6.2-sol', source?.effort ?? args.effort ?? null, new Date().toISOString());
          if (fork) result.sourceThreadId = sourceThreadId;
        }
        if (row.method === 'codex_rename_thread') {
          if (title !== args.title) throw new BridgeError('DESKTOP_TITLE_UNVERIFIED', 'Use the title confirmed by the native desktop rename.');
          this.store.run('UPDATE desktop_threads SET title=? WHERE id=?', title, threadId);
        }
        if (row.method === 'codex_archive_thread') {
          if (archived !== args.archived) throw new BridgeError('DESKTOP_ARCHIVE_UNVERIFIED', 'Use the archive state confirmed by the native desktop operation.');
          this.store.run('UPDATE desktop_threads SET archived=? WHERE id=?', Number(archived), threadId);
          result.archived = archived;
        }
        result.threadId = threadId;
        result.hostId = hostId;
        result.projectId = projectId;
        result.cwd = cwd;
        result.title = title;
        if (row.method === 'codex_read_thread') {
          if (!Array.isArray(history?.turns)) throw new BridgeError('DESKTOP_HISTORY_REQUIRED', 'Use the native desktop thread reader and return its turns and page.');
          result.history = conversationHistory(history);
        }
      }
      if (typeof message === 'string') result.message = message.slice(0, 1000);
      if (outcome === 'failed' && args.decisionEventId) this.store.run('DELETE FROM resolutions WHERE event=? AND action=?', args.decisionEventId, requestId);
      const state = outcome === 'accepted' && !nativeTurnMethods.has(row.method) ? 'completed' : outcome;
      this.store.run('UPDATE desktop_dispatch SET state=?, thread=?, result=? WHERE id=?', state, row.thread ?? result.threadId ?? null, JSON.stringify(result), requestId);
    });
    this.store.emit('desktop-dispatch');
    return this.receipt(this.dispatch(requestId));
  }

  setModel(threadId, model, effort) {
    if (!this.find(threadId)) throw new BridgeError('THREAD_OUTSIDE_BRIDGE', 'This desktop chat is outside the bridge.');
    this.store.run('UPDATE desktop_threads SET model=?, effort=? WHERE id=?', model, effort ?? null, threadId);
    return { thread: this.find(threadId), effective: 'next_turn' };
  }

  async report({ requestId, threadId, reportId, feedback }, signal) {
    validate(feedbackSchema, feedback);
    const result = await this.wait(id(requestId, 'requestId'), signal);
    if (!result.accepted || result.threadId !== threadId || !this.find(threadId)) throw new BridgeError('DESKTOP_TARGET_UNVERIFIED', 'This request is not bound to the calling desktop chat.');
    const key = `${reportPrefix(requestId)}${id(reportId, 'reportId')}`;
    const payload = { ...feedback, activeReport: true, source: 'codex_desktop_feedback_script', requestId };
    const previous = this.store.get('SELECT seq,body FROM events WHERE thread=? AND key=?', threadId, key);
    if (previous) {
      if (JSON.stringify(ordered(JSON.parse(previous.body))) !== JSON.stringify(ordered(payload))) throw new BridgeError('REPORT_ID_REUSED', 'This report ID identifies different feedback.');
      return { eventId: previous.seq, duplicate: true };
    }
    if (this.dispatch(requestId).state !== 'accepted') throw new BridgeError('TURN_INACTIVE', 'The desktop executor already completed this request.');
    return this.store.event(threadId, null, key, feedback.kind, payload);
  }

  complete({ requestId, threadId, turnId, status, finalOutput }) {
    const row = this.dispatch(requestId);
    if (row.thread !== threadId || !['completed', 'failed', 'interrupted'].includes(status) || !['accepted', 'completed'].includes(row.state)) throw new BridgeError('DISPATCH_STATE_MISMATCH', 'The terminal result must match the accepted native desktop chat.');
    if (row.state === 'completed') {
      const receipt = this.receipt(row);
      if (receipt.turnId !== turnId || receipt.status !== status) throw new BridgeError('DISPATCH_STATE_MISMATCH', 'A different native turn result is already recorded.');
      return receipt;
    }
    const outcome = { ...JSON.parse(row.result), turnId: id(turnId, 'turnId'), status };
    this.store.transaction(() => {
      const text = typeof finalOutput === 'string' ? finalOutput : null;
      this.store.run('INSERT INTO turns (thread,id,status,final_text) VALUES (?,?,?,?)', threadId, turnId, status, text);
      const prefix = reportPrefix(requestId);
      const report = this.store.run('UPDATE events SET turn=? WHERE thread=? AND substr(key,1,?)=?', turnId, threadId, prefix.length, prefix).changes > 0;
      if (!report || status !== 'completed') this.store.event(threadId, turnId, `desktop-final:${requestId}`, report ? 'turn_error' : 'turn_fallback', {
        requestId, activeReport: !!report, status, source: 'codex_desktop_native_turn', finalOutput: text?.slice(0, 24_000) ?? null,
        finalOutputTruncated: (text?.length ?? 0) > 24_000,
        notice: report ? 'Codex 主动反馈后回合异常结束。' : 'Codex 本轮未调用反馈脚本。以下为原生桌面回合的最终输出。'
      });
      this.store.run("UPDATE desktop_dispatch SET state='completed', result=? WHERE id=?", JSON.stringify(outcome), requestId);
    });
    this.store.emit('desktop-dispatch');
    return this.receipt(this.dispatch(requestId));
  }
}
