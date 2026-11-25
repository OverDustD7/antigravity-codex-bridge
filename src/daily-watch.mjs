import { BridgeError } from './protocol.mjs';
import { dailyReceiptWakeFilter, dailyReplyTarget } from './store.mjs';

export class DailyWatch {
  constructor(store) {
    this.store = store;
    this.active = new Map();
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_watches (
        conversation TEXT NOT NULL, thread TEXT NOT NULL, cursor INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, reminded INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (conversation,thread)
      );
      CREATE TABLE IF NOT EXISTS daily_routes (
        thread TEXT NOT NULL, turn TEXT NOT NULL, conversation TEXT NOT NULL, PRIMARY KEY (thread,turn,conversation)
      );
      CREATE TABLE IF NOT EXISTS daily_messages (
        event INTEGER PRIMARY KEY, request TEXT NOT NULL UNIQUE, conversation TEXT NOT NULL,
        path TEXT NOT NULL, returned INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  listeners() {
    return [...this.active.keys()].map(key => {
      const [conversationId, threadId] = key.split('/');
      return { conversationId, threadId, path: 'background_wait' };
    });
  }

  check(conversationId, threadId) {
    if (!this.store.get('SELECT 1 FROM desktop_sessions WHERE id=?', conversationId)) {
      throw new BridgeError('DESKTOP_SESSION_UNREGISTERED', 'Use the current Antigravity conversation ID supplied by the daily plugin.');
    }
    return this.store.get('SELECT cursor FROM daily_watches WHERE conversation=? AND thread=?', conversationId, threadId);
  }

  route(threadId, turnId, conversationId) {
    this.store.run('INSERT OR IGNORE INTO daily_routes VALUES (?,?,?)', threadId, turnId, conversationId);
  }

  expect(conversationId, threadId, cursor) {
    this.store.run(`INSERT INTO daily_watches (conversation,thread,cursor) VALUES (?,?,?)
      ON CONFLICT(conversation,thread) DO UPDATE SET enabled=1,reminded=0,
        cursor=CASE WHEN enabled=0 THEN max(cursor,excluded.cursor) ELSE cursor END`, conversationId, threadId, cursor);
  }

  status(conversationId) {
    return this.store.all(`SELECT w.thread AS threadId,w.cursor,w.reminded FROM daily_watches w
      WHERE w.conversation=? AND w.enabled=1 AND NOT EXISTS
        (SELECT 1 FROM push_targets p WHERE p.thread=w.thread AND p.conversation=w.conversation AND p.enabled=1)
      ORDER BY w.thread`, conversationId).map(row => ({ ...row, waiting: this.active.has(`${conversationId}/${row.threadId}`) }));
  }

  guard(conversationId) {
    return this.store.transaction(() => {
      const missing = this.status(conversationId).filter(row => !row.waiting && !row.reminded);
      for (const { threadId } of missing) this.store.run('UPDATE daily_watches SET reminded=1 WHERE conversation=? AND thread=?', conversationId, threadId);
      return missing;
    });
  }

  pause(conversationId, threadId) {
    const stopped = !!this.store.run('UPDATE daily_watches SET enabled=0 WHERE conversation=? AND thread=? AND enabled=1', conversationId, threadId).changes;
    this.active.get(`${conversationId}/${threadId}`)?.abort(new BridgeError('AGY_WAIT_PAUSED', 'This conversation paused its receipt watch.'));
    return { threadId, stopped };
  }

  async wait(conversationId, threadId, after, signal) {
    const cursor = Math.max(this.check(conversationId, threadId)?.cursor ?? 0, after);
    const key = `${conversationId}/${threadId}`;
    if (this.active.has(key) || this.store.get('SELECT 1 FROM push_targets WHERE conversation=? AND thread=? AND enabled=1', conversationId, threadId)) {
      throw new BridgeError('AGY_WAIT_ALREADY_ACTIVE', 'This conversation already has a receipt delivery path for the selected chat.');
    }
    this.expect(conversationId, threadId, cursor);
    this.store.run('UPDATE daily_watches SET cursor=? WHERE conversation=? AND thread=?', cursor, conversationId, threadId);
    const controller = new AbortController();
    this.active.set(key, controller);
    try {
      return await this.store.onUpdate('event', () => {
        const row = this.store.get(`SELECT e.* FROM events e WHERE e.thread=? AND e.seq>? AND ${dailyReceiptWakeFilter} AND (
          (EXISTS (SELECT 1 FROM daily_routes r WHERE r.thread=e.thread AND r.turn=e.turn AND r.conversation=?)
            AND (${dailyReplyTarget} IS NULL OR ${dailyReplyTarget}=?)) OR
          EXISTS (SELECT 1 FROM daily_messages m WHERE m.event=e.seq AND m.conversation=? AND m.path='background_wait')
        ) ORDER BY e.seq LIMIT 1`, threadId, cursor, conversationId, conversationId, conversationId);
        return row && { event: this.store.eventRecord(row), nextCursor: row.seq };
      }, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, id => !id || id === threadId);
    } finally { this.active.delete(key); }
  }
}
