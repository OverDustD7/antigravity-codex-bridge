import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './config.mjs';
import { BridgeError } from './protocol.mjs';
import { dailyReceiptWakeFilter, dailyReplyTarget, receiptWakeFilter } from './store.mjs';

const conversationPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function isBridgeProject(path) {
  try {
    if (typeof path !== 'string' || !path) return false;
    const directory = path.startsWith('file:') ? fileURLToPath(path) : path;
    return realpathSync(resolve(directory)) === realpathSync(root);
  } catch { return false; }
}

export class DesktopDelivery {
  constructor(store, globalSessions = false) { this.store = store; this.globalSessions = globalSessions; this.waiters = 0; }

  listeners() {
    return this.waiters ? this.store.all(`SELECT conversation AS conversationId,thread AS threadId,'sidecar' AS path
      FROM push_targets WHERE enabled=1 ORDER BY conversation,thread`) : [];
  }

  register({ conversationId, workspacePaths }) {
    if (typeof conversationId !== 'string' || !conversationPattern.test(conversationId) ||
      (!this.globalSessions && (!Array.isArray(workspacePaths) || workspacePaths.length !== 1 || !isBridgeProject(workspacePaths[0])))) {
      throw new BridgeError('DESKTOP_PROJECT_REQUIRED', 'Desktop push is scoped to a session started in the isolated bridge project.');
    }
    const inserted = this.store.run('INSERT OR IGNORE INTO desktop_sessions (id, registered_at) VALUES (?, ?)', conversationId, new Date().toISOString());
    return { conversationId, registered: true, created: !!inserted.changes };
  }

  bind({ threadId, conversationId, after, enabled }) {
    if (!this.store.get('SELECT id FROM desktop_sessions WHERE id = ?', conversationId)) {
      throw new BridgeError('DESKTOP_SESSION_UNREGISTERED', 'Use this project’s Antigravity session ID from its SessionStart hook.');
    }
    const prior = this.store.get('SELECT * FROM push_targets WHERE thread = ?', threadId);
    const watch = this.store.get('SELECT conversation FROM agy_receipt_watches WHERE thread = ?', threadId);
    if ((prior && prior.conversation !== conversationId) || (watch && watch.conversation !== conversationId)) {
      throw new BridgeError('DESKTOP_TARGET_ALREADY_BOUND', 'This Codex chat is bound to its original Antigravity chat.');
    }
    if (!enabled) this.pause({ threadId, conversationId });
    const cursor = Math.max(prior?.cursor ?? 0, after);
    this.store.run(`INSERT INTO push_targets (thread, conversation, cursor, enabled) VALUES (?, ?, ?, ?)
      ON CONFLICT (thread) DO UPDATE SET enabled = excluded.enabled, cursor = excluded.cursor`, threadId, conversationId, cursor, enabled ? 1 : 0);
    this.store.emit('event', threadId);
    return { threadId, conversationId, enabled, cursor, mode: 'agentapi_sidecar', deliveryObserved: false };
  }

  pause({ threadId, conversationId }) {
    return this.store.transaction(() => {
      const stopped = this.store.run(`UPDATE push_targets SET enabled=0
        WHERE thread=? AND conversation=? AND enabled=1`, threadId, conversationId).changes > 0;
      if (stopped) this.store.run(`UPDATE push_deliveries SET state='skipped' WHERE conversation=?
        AND state IN ('reserved','retry') AND event IN (SELECT seq FROM events WHERE thread=?)`, conversationId, threadId);
      return stopped;
    });
  }

  status(threadId, limit) {
    const target = this.store.get('SELECT conversation, cursor, enabled FROM push_targets WHERE thread = ?', threadId);
    const deliveries = this.store.all(`SELECT d.event AS eventId, d.state FROM push_deliveries d
      JOIN events e ON e.seq = d.event WHERE e.thread = ? ORDER BY d.event DESC LIMIT ?`, threadId, limit);
    return { threadId, target: target ? { ...target, enabled: !!target.enabled } : null, deliveries };
  }

  recover() {
    const result = this.store.transaction(() => ({
      requeued: this.store.run("UPDATE push_deliveries SET state = 'retry' WHERE state = 'reserved'").changes,
      uncertain: this.store.run("UPDATE push_deliveries SET state = 'uncertain' WHERE state = 'claimed'").changes
    }));
    if (result.requeued) this.store.emit('event');
    return result;
  }

  async take(signal, resumable = false) {
    this.waiters++;
    try { return await this.store.onUpdate('event', () => this.store.transaction(() => {
      const job = this.store.get(`SELECT e.seq, e.thread, e.kind, t.conversation FROM events e
        JOIN push_targets t ON t.thread = e.thread
        LEFT JOIN push_deliveries d ON d.event = e.seq
        WHERE t.enabled = 1 AND ${this.globalSessions ? dailyReceiptWakeFilter : receiptWakeFilter}
        AND (d.state = 'retry' OR (d.event IS NULL AND e.seq > t.cursor))
        ${this.globalSessions ? `AND (
          (EXISTS (SELECT 1 FROM daily_routes r WHERE r.thread=e.thread AND r.turn=e.turn AND r.conversation=t.conversation)
            AND (${dailyReplyTarget} IS NULL OR ${dailyReplyTarget}=t.conversation)) OR
          EXISTS (SELECT 1 FROM daily_messages m WHERE m.event=e.seq AND m.conversation=t.conversation AND m.path='sidecar')
        )` : ''}
        ORDER BY e.seq LIMIT 1`);
      if (!job) return null;
      this.store.run(`INSERT INTO push_deliveries (event, conversation, state) VALUES (?, ?, ?)
        ON CONFLICT (event) DO UPDATE SET state = excluded.state`, job.seq, job.conversation, resumable ? 'reserved' : 'claimed');
      this.store.run('UPDATE push_targets SET cursor = MAX(cursor, ?) WHERE thread = ?', job.seq, job.thread);
      return { eventId: job.seq, threadId: job.thread, kind: job.kind, conversationId: job.conversation };
    }), signal); } finally { this.waiters--; }
  }

  start(eventId) {
    if (!Number.isSafeInteger(eventId)) throw new BridgeError('INVALID_DELIVERY', 'Use the reserved event ID.');
    const updated = this.store.run("UPDATE push_deliveries SET state = 'claimed' WHERE event = ? AND state = 'reserved'", eventId);
    if (!updated.changes && this.store.get("SELECT 1 FROM push_deliveries WHERE event=? AND state='skipped'", eventId)) return { eventId, skipped: true };
    if (!updated.changes) throw new BridgeError('DELIVERY_NOT_PENDING', 'The event is no longer reserved for this delivery.');
    return { eventId };
  }

  finish({ eventId, outcome }) {
    if (!Number.isSafeInteger(eventId) || !['cli_accepted', 'cli_error', 'uncertain'].includes(outcome)) {
      throw new BridgeError('INVALID_DELIVERY', 'Invalid desktop delivery outcome.');
    }
    const updated = this.store.run("UPDATE push_deliveries SET state = ? WHERE event = ? AND state = 'claimed'", outcome, eventId);
    if (!updated.changes) throw new BridgeError('DELIVERY_NOT_PENDING', 'This delivery was already recorded or is unknown.');
    return { eventId, outcome };
  }
}
