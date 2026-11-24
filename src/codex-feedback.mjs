import { readFileSync } from 'node:fs';
import { invoke } from './client.mjs';
import { feedbackScriptSchema, nativeFeedbackPrefix, validate } from './protocol.mjs';

const useNativeOutput = process.argv[2] === '--native-output';
const [reportId, source = '--stdin', ...args] = process.argv.slice(useNativeOutput ? 3 : 2);
const kind = source === '--text' ? args.shift() : undefined;
const [threadId = process.env.CODEX_THREAD_ID, knownTurn] = args;
try {
  if (!reportId || (!useNativeOutput && !threadId) || (source === '--text' && !kind)) throw new Error('Usage: node src/codex-feedback.mjs [--native-output] REPORT_ID [FILE|--stdin|--text KIND] [THREAD_ID] [TURN_ID]. Defaults to the current Codex thread.');
  const data = readFileSync(source === '--stdin' || source === '--text' ? 0 : source, 'utf8').replace(/^\uFEFF/, '');
  const feedback = kind ? { kind, summary: data.trim() } : JSON.parse(data);
  if (useNativeOutput) {
    validate(feedbackScriptSchema, { threadId: threadId ?? 'native-event', turnId: 'native-event', reportId, feedback });
    console.log(`${nativeFeedbackPrefix}${JSON.stringify({ reportId, feedback })}`);
    console.log(JSON.stringify({ ok: true, state: 'emitted_for_native_bridge', reportId }));
  } else {
    const context = knownTurn ? { ok: true, turnId: knownTurn } : await invoke('codex_feedback_context', { threadId });
    const receipt = context.ok ? await invoke('codex_submit_feedback', { threadId, turnId: context.turnId, reportId, feedback }) : context;
    console.log(JSON.stringify(receipt));
    if (!receipt.ok) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
