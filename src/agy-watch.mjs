import { BridgeError } from './protocol.mjs';

export class AgyWatch {
  constructor(store) {
    this.store = store;
    this.active = new Map();
  }

  status(conversationId) {
    return this.store.all(`
      SELECT w.thread AS threadId, w.cursor, w.reminded
      FROM agy_receipt_watches w LEFT JOIN push_targets p ON p.thread = w.thread
      WHERE w.conversation = ? AND w.enabled = 1 AND coalesce(p.enabled, 0) = 0
      ORDER BY w.thread
    `, conversationId).map(row => ({ ...row, waiting: this.active.has(row.threadId) }));
  }

  guard(conversationId) {
    return this.store.transaction(() => {
      const missing = this.status(conversationId).filter(row => !row.waiting && !row.reminded);
      for (const row of missing) this.store.run('UPDATE agy_receipt_watches SET reminded=1 WHERE thread=?', row.threadId);
      return missing;
    });
  }

  pause(conversationId, threadId) {
    const stopped = this.store.run(
      'UPDATE agy_receipt_watches SET enabled=0 WHERE conversation=? AND thread=?', conversationId, threadId).changes > 0;
    if (stopped) this.active.get(threadId)?.abort(new BridgeError('AGY_WAIT_PAUSED', 'This conversation paused the receipt watch.'));
    return { threadId, stopped };
  }

  check(conversationId, threadId) {
    if (!this.store.get('SELECT 1 FROM desktop_sessions WHERE id=?', conversationId)) {
      throw new BridgeError('DESKTOP_SESSION_UNREGISTERED', 'Use the Antigravity conversation ID supplied by this project hook.');
    }
    if (!threadId) return null;
    const saved = this.store.get('SELECT conversation,cursor FROM agy_receipt_watches WHERE thread=?', threadId);
    const push = this.store.get('SELECT conversation FROM push_targets WHERE thread=?', threadId);
    if ((saved && saved.conversation !== conversationId) || (push && push.conversation !== conversationId)) {
      throw new BridgeError('AGY_WATCH_ALREADY_BOUND', 'Use the original Antigravity conversation for this Codex chat.');
    }
    return saved;
  }

  expect(conversationId, threadId, after) {
    this.store.run(`
      INSERT INTO agy_receipt_watches (thread,conversation,cursor) VALUES (?,?,?)
      ON CONFLICT (thread) DO UPDATE SET
        cursor=CASE WHEN agy_receipt_watches.enabled=0 THEN max(agy_receipt_watches.cursor,excluded.cursor) ELSE agy_receipt_watches.cursor END,
        enabled=1,reminded=0
      WHERE agy_receipt_watches.conversation=excluded.conversation
    `, threadId, conversationId, after);
  }

  async wait(conversationId, threadId, after, signal) {
    const saved = this.check(conversationId, threadId);
    if (this.store.get('SELECT 1 FROM push_targets WHERE thread=? AND enabled=1', threadId)) {
      throw new BridgeError('AGY_SIDECAR_ACTIVE', 'This Codex chat already uses the Sidecar to deliver notifications.');
    }
    if (this.active.has(threadId)) throw new BridgeError('AGY_WAIT_ALREADY_ACTIVE', 'A native wait is already active for this chat.');
    const cursor = Math.max(saved?.cursor ?? 0, after);
    this.store.run(`
      INSERT INTO agy_receipt_watches (thread,conversation,cursor) VALUES (?,?,?)
      ON CONFLICT (thread) DO UPDATE SET cursor=excluded.cursor,enabled=1,reminded=0
    `, threadId, conversationId, cursor);
    const active = new AbortController();
    this.active.set(threadId, active);
    try {
      return await this.store.wait([threadId], cursor, AbortSignal.any([signal, active.signal]));
    } finally {
      this.active.delete(threadId);
    }
  }
}
