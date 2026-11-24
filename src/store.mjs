import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

export class Store extends EventEmitter {
  constructor(path) {
    super();
    this.setMaxListeners(0);
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, cwd TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, title TEXT, model TEXT NOT NULL,
        archived INTEGER DEFAULT 0, created_at TEXT NOT NULL, effort TEXT
      );
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY, hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT
      );
      CREATE TABLE IF NOT EXISTS turns (
        thread TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL, final_text TEXT,
        PRIMARY KEY (thread, id)
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY, thread TEXT NOT NULL, turn TEXT, key TEXT NOT NULL,
        kind TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL,
        UNIQUE (thread, key)
      );
      CREATE INDEX IF NOT EXISTS events_by_thread ON events (thread, seq);
      CREATE TABLE IF NOT EXISTS resolutions (
        event INTEGER PRIMARY KEY, action TEXT NOT NULL, receipt TEXT
      );
      CREATE TABLE IF NOT EXISTS desktop_sessions (id TEXT PRIMARY KEY, registered_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agy_receipt_watches (
        thread TEXT PRIMARY KEY, conversation TEXT NOT NULL, cursor INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, reminded INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS agy_watch_by_conversation ON agy_receipt_watches (conversation, enabled);
      CREATE TABLE IF NOT EXISTS push_targets (thread TEXT PRIMARY KEY, conversation TEXT NOT NULL, cursor INTEGER NOT NULL, enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS push_deliveries (event INTEGER PRIMARY KEY, conversation TEXT NOT NULL, state TEXT NOT NULL);
    `);
  }

  get(sql, ...values) { return this.db.prepare(sql).get(...values); }
  all(sql, ...values) { return this.db.prepare(sql).all(...values); }
  run(sql, ...values) { return this.db.prepare(sql).run(...values); }

  event(thread, turn, key, kind, body) {
    const at = new Date().toISOString();
    const { lastInsertRowid, changes } = this.run(
      'INSERT OR IGNORE INTO events (thread, turn, key, kind, body, at) VALUES (?, ?, ?, ?, ?, ?)',
      thread, turn, key, kind, JSON.stringify(body), at
    );
    if (!changes) return { eventId: this.get('SELECT seq FROM events WHERE thread = ? AND key = ?', thread, key).seq, duplicate: true };
    queueMicrotask(() => this.emit('event', thread));
    return { eventId: Number(lastInsertRowid), duplicate: false };
  }

  eventRecord(row) {
    return { eventId: row.seq, threadId: row.thread, turnId: row.turn, kind: row.kind, at: row.at, ...JSON.parse(row.body) };
  }

  events(threads, after, limit) {
    return this.all(`SELECT * FROM events WHERE seq > ? AND thread IN (${threads.map(() => '?').join(',')}) ORDER BY seq LIMIT ?`,
      after, ...threads, limit).map(row => this.eventRecord(row));
  }

  wait(threads, after, signal) {
    return this.onUpdate('event', () => {
      const event = this.events(threads, after, 1)[0];
      return event && { event, nextCursor: event.eventId };
    }, signal, thread => !thread || threads.includes(thread));
  }

  onUpdate(channel, read, signal, matches = () => true) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener('abort', abort);
        this.off(channel, check);
      };
      const abort = () => { cleanup(); reject(signal.reason); };
      const check = value => {
        if (!matches(value)) return;
        try {
          const result = read();
          if (result) { cleanup(); resolve(result); }
        } catch (error) { cleanup(); reject(error); }
      };
      this.on(channel, check);
      signal.addEventListener('abort', abort, { once: true });
      check();
    });
  }

  transaction(task) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = task();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
