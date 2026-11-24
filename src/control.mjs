import { invoke } from './client.mjs';
import { readFileSync } from 'node:fs';
import { daily } from './config.mjs';
import { agyMessagingTools, tools } from './protocol.mjs';

const [method, raw = '{}'] = process.argv.slice(2);
try {
  if (!method || method === '--help') {
    console.log('Usage: node src/control.mjs TOOL_NAME [JSON_ARGUMENTS|@FILE|--stdin]');
    for (const tool of daily ? [...tools, ...agyMessagingTools] : tools) {
      if (tool.name !== 'codex_panel_wait') console.log(`${tool.name}  ${tool.description}`);
    }
    console.log('bridge_shutdown  Stop an idle local bridge before changing its configuration.');
    if (daily) console.log('bridge_restart  Recycle the daily bridge worker while receipt waits reconnect.');
  } else {
    const input = raw === '--stdin' ? readFileSync(0, 'utf8') : raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw;
    const result = await invoke(method, JSON.parse(input.replace(/^\uFEFF/, '')));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
