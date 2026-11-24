import { watch } from 'node:fs';
import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

const readSize = 64 * 1024;
const historyTail = 1024 * 1024;
const feedbackScript = /(?:\bcodex-feedback\.mjs\b|\bdaily\.mjs["']?\s+feedback\b)/;

export function isNativeFeedbackCommand(command) {
  return typeof command === 'string' && feedbackScript.test(command);
}

export function rawFeedbackReader(receive) {
  const calls = new Map();
  return (turnId, item) => {
    if (!turnId || !item?.call_id) return;
    if (item.type === 'custom_tool_call' && item.name === 'exec' && isNativeFeedbackCommand(item.input)) {
      calls.set(item.call_id, turnId);
      return;
    }
    if (item.type !== 'custom_tool_call_output' || calls.get(item.call_id) !== turnId) return;
    calls.delete(item.call_id);
    const output = Array.isArray(item.output)
      ? item.output.filter(part => part.type === 'input_text' && typeof part.text === 'string').map(part => part.text).join('\n')
      : item.output;
    if (typeof output === 'string') receive(turnId, output);
  };
}

export function watchNativeFeedback(path, receive, onError) {
  const readItem = rawFeedbackReader(receive);
  const consume = text => {
    if (!text.includes('"custom_tool_call') || !text.includes('"response_item"')) return;
    let row;
    try { row = JSON.parse(text); } catch { return; }
    if (row.type === 'response_item') {
      readItem(row.payload?.internal_chat_message_metadata_passthrough?.turn_id, row.payload);
    }
  };
  let offset;
  let discard = false;
  let remaining = '';
  let decoder = new StringDecoder('utf8');
  let reading;
  let dirty = false;
  let closed = false;
  const refresh = () => {
    dirty = true;
    if (reading || closed) return reading;
    reading = (async () => {
      while (dirty && !closed) {
        dirty = false;
        const file = await open(path, 'r');
        try {
          const { size } = await file.stat();
          if (offset === undefined || offset > size) {
            offset = Math.max(0, size - historyTail);
            discard = offset > 0;
            remaining = '';
            decoder = new StringDecoder('utf8');
          }
          const buffer = Buffer.allocUnsafe(readSize);
          while (offset < size && !closed) {
            const { bytesRead } = await file.read(buffer, 0, Math.min(readSize, size - offset), offset);
            if (!bytesRead) break;
            offset += bytesRead;
            const lines = (remaining + decoder.write(buffer.subarray(0, bytesRead))).split('\n');
            remaining = lines.pop();
            for (const line of lines) {
              if (!discard) consume(line);
              discard = false;
            }
            if (remaining.length > historyTail) {
              remaining = '';
              discard = true;
            }
          }
        } finally { await file.close(); }
      }
    })().catch(error => { if (!closed) onError(error); }).finally(() => { reading = undefined; });
    return reading;
  };
  const watcher = watch(path, { persistent: false }, refresh);
  watcher.on('error', error => { if (!closed) onError(error); });
  void refresh();
  return { refresh, close() { closed = true; watcher.close(); } };
}
