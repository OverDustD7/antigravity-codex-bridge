import { readFileSync } from 'node:fs';
import { invoke } from './client.mjs';

const [requestId, reportId, input = '--stdin', kind] = process.argv.slice(2);
try {
  const threadId = process.env.CODEX_THREAD_ID;
  const plainText = input === '--text';
  if (!requestId || !reportId || !threadId || (plainText && !kind)) {
    throw new Error('Usage in the assigned desktop conversation: node src/desktop-feedback.mjs REQUEST_ID REPORT_ID --text KIND < text, or use FILE / --stdin for JSON.');
  }
  const data = readFileSync(plainText || input === '--stdin' ? 0 : input, 'utf8').replace(/^\uFEFF/, '');
  const feedback = plainText ? { kind, summary: data.trim() } : JSON.parse(data);
  const result = await invoke('desktop_work_report', { requestId, threadId, reportId, feedback }, AbortSignal.timeout(90_000));
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
