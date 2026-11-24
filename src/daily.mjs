const [entry] = process.argv.splice(2, 1);
const scripts = {
  mcp: './mcp.mjs', 'codex-mcp': './mcp.mjs', control: './control.mjs', session: './agy-session.mjs',
  wait: './agy-receipt-wait.mjs', feedback: './codex-feedback.mjs', sidecar: './agy-sidecar.mjs'
};
if (!Object.hasOwn(scripts, entry)) throw new Error('Expected daily entry: mcp, codex-mcp, control, session, wait, feedback or sidecar.');
process.env.BRIDGE_DAILY = '1';
if (entry === 'codex-mcp') process.env.BRIDGE_CODEX_MESSAGING = '1';
await import(scripts[entry]);
