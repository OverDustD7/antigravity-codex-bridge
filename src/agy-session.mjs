import { readFileSync } from 'node:fs';
import { invoke, upgradeDormantBridge } from './client.mjs';
import { isBridgeProject } from './desktop.mjs';
import { daily, scriptCommand } from './config.mjs';

try {
  const { conversationId, workspacePaths, fullyIdle, terminationReason } = JSON.parse(readFileSync(0, 'utf8'));
  const checkAtStop = process.argv[2] === 'stop';
  const request = (name, args) => invoke(name, args, AbortSignal.timeout(8000));
  const command = scriptCommand(daily ? 'daily.mjs' : 'agy-receipt-wait.mjs');
  const resume = ({ threadId, cursor }) => daily
    ? `在当前聊天用协作桥的后台 codex_wait，参数 ${JSON.stringify({ threadIds: [threadId], after: cursor, conversationId })}。如果 MCP 重载、报 EOF 或工具暂时不可用，用当前聊天的内置 run_command 以 WaitMsBeforeAsync=500 转到后台执行 ${command} wait ${threadId} ${cursor} ${conversationId}。两条入口只开一条。`
    : `用当前聊天的 run_command 从游标 ${cursor} 启动 ${command} ${threadId} ${cursor} ${conversationId}。如果已成功处理更新的回执，可沿用该回执游标。`;
  if (!daily && (workspacePaths?.length !== 1 || !isBridgeProject(workspacePaths[0]))) {
    console.log('{}');
  } else if (checkAtStop) {
    if (!fullyIdle || terminationReason !== 'model_stop') {
      console.log('{"decision":"stop"}');
    } else {
      const result = await request('agy_watch_guard', { conversationId });
      const missing = result.missing ?? [];
      console.log(JSON.stringify(missing.length ? {
        decision: 'continue',
        reason: `项目检查发现应续接的回执等待没有启动。${missing.map(resume).join('\n')}如用户已要求结束协作，改用 codex_pause_receipt_watch。`
      } : { decision: 'stop' }));
    }
  } else {
    if (daily) await upgradeDormantBridge().catch(error => console.error(error.message));
    const result = await request('agy_register_session', { conversationId, workspacePaths });
    const status = result.ok ? await request('agy_watch_status', { conversationId }) : {};
    const missing = (status.watches ?? []).filter(watch => !watch.waiting);
    if (daily && process.argv[2] === 'pre' && result.ok && !result.created && !missing.length) {
      console.log('{}');
      process.exit(0);
    }
    const systemMessage = result.ok ? [
      `当前 ${daily ? '日常协作' : '桥接项目'}的 Antigravity 会话编号为 ${conversationId}。派工与回执等待沿用这个编号。`,
      ...missing.map(resume)
    ].join('\n') : '协作桥未能登记桌面会话。可使用后台等待与收件箱。';
    console.log(JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage } }] }));
  }
} catch {
  console.log('{}');
}
