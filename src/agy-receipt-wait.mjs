import { invoke } from './client.mjs';
import { receiptText } from './protocol.mjs';

const [threadId, rawCursor, conversationId, extra] = process.argv.slice(2);
const after = Number(rawCursor);

try {
  if (!threadId || !/^\d+$/.test(rawCursor ?? '') || !Number.isSafeInteger(after) || extra !== undefined) {
    throw new Error('Usage: node src/agy-receipt-wait.mjs THREAD_ID AFTER [ANTIGRAVITY_CONVERSATION_ID]');
  }
  const result = await invoke('codex_wait', { threadIds: [threadId], after, ...(conversationId && { conversationId }) });
  if (!result.ok) throw new Error(result.message ?? result.code);
  console.log(receiptText(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
