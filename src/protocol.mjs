export class BridgeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const str = { type: 'string', minLength: 1 };
const id = { ...str, maxLength: 150 };
const prompt = { ...str, maxLength: 48000 };
const summary = { ...str, maxLength: 3000 };
const cursor = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const positiveCursor = { ...cursor, minimum: 1 };
const page = { type: 'integer', minimum: 1, maximum: 50 };
const flag = { type: 'boolean' };
const effort = { enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] };
const threadId = id;
const requestId = { ...id, description: 'Unique stable ID for this action. Reuse exactly the same value and arguments on transport retry.' };
const threadIds = { type: 'array', minItems: 1, maxItems: 8, items: threadId };
const optionalModel = { model: id, effort };
const purpose = { enum: ['message', 'coordination'] };
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tool = (name, description, properties, required, options = {}) => ({ name, description, inputSchema: schema(properties, required), ...options });
const change = (name, description, properties, required) => tool(name, description, { requestId, ...properties }, ['requestId', ...required]);

export const feedbackSchema = schema({
  kind: { enum: ['milestone', 'writing_request', 'decision', 'blocker', 'final'] },
  summary,
  artifacts: { type: 'array', maxItems: 8, items: { ...str, maxLength: 1000 } },
  evidence: summary,
  options: { type: 'array', minItems: 2, maxItems: 5, items: { ...str, maxLength: 650 } },
  recommendation: summary,
  impact: summary
}, ['kind', 'summary']);

export const feedbackTool = {
  type: 'function', name: 'bridge_report', deferLoading: false,
  description: 'Send a concise paragraph to the originating Antigravity bridge about a milestone, final result, writing handoff, blocker or consequential decision. For a route question, include relevant evidence or a roadmap location in the paragraph. Continue independent work. Ordinary progress and routine choices belong inside Codex.',
  inputSchema: feedbackSchema
};

export const feedbackScriptSchema = schema({ threadId, turnId: threadId, reportId: id, feedback: feedbackSchema }, ['threadId', 'turnId', 'reportId', 'feedback']);
export const nativeFeedbackPrefix = 'AGY_CODEX_FEEDBACK_V1 ';
export const resumableWaits = new Set(['codex_wait', 'codex_wait_dispatch', 'codex_panel_wait']);

export function receiptText({ event, nextCursor }) {
  if (event.kind === 'agy_message') return `${event.summary}\n\n会话消息 #${event.eventId} · nextCursor=${nextCursor}`;
  const artifacts = event.artifacts?.length ? `产物 ${event.artifacts.join('、')}` : '';
  const prose = [event.summary, event.notice, event.finalOutput, event.evidence, artifacts, event.error].filter(Boolean).join('\n\n');
  return `${prose}\n\n回执 #${event.eventId} · ${event.kind} · threadId=${event.threadId} · nextCursor=${nextCursor}`.trim();
}

export const agyMessagingTools = [
  tool('agy_list_listeners', 'List the currently reachable Antigravity conversations and their listening paths.'),
  change('agy_send_message', 'Send a short message to one listening Antigravity conversation by ID. Use only for the specified coordination task.',
    { conversationId: id, text: summary }, ['conversationId', 'text']),
  tool('agy_message_status', 'Check delivery of a message using its original request ID.', { requestId }, ['requestId'])
];

const uiMeta = {
  _meta: {
    ui: { resourceUri: 'ui://agy-codex/inbox.html' },
    'com.google.antigravity/ui': { entrypoints: [{ type: 'aux_pane', title: 'Codex 回执' }] }
  }
};

export const tools = [
  tool('bridge_status', 'Inspect bridge state, supported scope and exclusive backend identity.'),
  tool('codex_account_status', 'Check whether the connected Codex host has an account. Credentials and account identifiers are omitted.'),
  tool('codex_list_projects', 'Find Codex sidebar projects by name, directory or ID with searchTerm, or list all projects.', { searchTerm: id }),
  change('codex_create_project', 'Create a Codex project in the daily connector, optionally using an existing absolute folder path. The test connector prepares an isolated folder.', { name: { ...str, maxLength: 64 }, cwd: { ...str, maxLength: 4096 } }, ['name']),
  tool('codex_list_threads', 'List Codex chats. In the daily bridge, workspaceId accepts a sidebar project name, directory or ID. Set activeOnly to find running chats in that project without searching global history.', { workspaceId: id, activeOnly: flag, archived: flag, before: positiveCursor, cursor: id, searchTerm: id, limit: page }),
  change('codex_attach_thread', 'In the daily connector, monitor an existing native chat and its current turn without resuming or changing it. Sending to an existing chat does not require this step.', { threadId, conversationId: id }, ['threadId', 'conversationId']),
  tool('codex_read_items', 'In the daily connector, page the native items in one Codex turn, including permitted tool output.', { threadId, turnId: id, cursor: id, limit: page }, ['threadId', 'turnId']),
  tool('codex_read_thread', 'Read recent content from a Codex chat by ID. Use the page cursor for older history. The daily connector also reads existing desktop chats.', { threadId, cursor: id, limit: page, requestId }, ['threadId']),
  tool('codex_read_final', 'Read a previously received native final message in pages by its exact turn ID.', { threadId, turnId: id, offset: cursor }, ['threadId', 'turnId']),
  tool('codex_list_models', 'List model slugs, effort options and pagination from the official Codex host.', { cursor: id, limit: page }),
  tool('codex_usage_limits', 'Read Codex quota windows once from the account API, omitting account identity and payment information. Use only when relevant to a user or routing decision.'),
  change('codex_create_thread', 'Create a Codex chat, optionally starting its first turn. Set purpose to coordination when Antigravity will guide work or own milestone acceptance.', { workspaceId: id, title: id, prompt, conversationId: id, purpose, ...optionalModel }, ['workspaceId', 'title']),
  change('codex_fork_thread', 'Create an independent chat with the managed source chat history. Use for distinctly authorized work. Starts no model turn.', { threadId, title: id }, ['threadId', 'title']),
  change('codex_set_model', 'Set model and optional reasoning effort for later turns in this exact chat. The running turn retains its current settings.', { threadId, model: id, effort }, ['threadId', 'model']),
  change('codex_send_message', 'Send to the exact Codex chat by ID. Ordinary messages default to unchanged text. Set purpose to coordination whenever Antigravity guides work or owns milestone acceptance. Set after_turn only to wait for the current turn.', {
    threadId, prompt, purpose, delivery: { enum: ['next_turn', 'after_turn', 'steer'] }, expectedTurnId: id, decisionEventId: positiveCursor, conversationId: id
  }, ['threadId', 'prompt']),
  change('codex_rename_thread', 'Rename a managed chat.', { threadId, title: id }, ['threadId', 'title']),
  change('codex_archive_thread', 'Archive or restore a managed chat. Active or uncertain turns must be resolved first.', { threadId, archived: flag }, ['threadId', 'archived']),
  change('codex_interrupt_turn', 'Interrupt a specific active turn in a managed chat when expressly requested. A native completion event supplies the final status.', { threadId, turnId: id }, ['threadId', 'turnId']),
  tool('codex_recover_thread', 'Reconcile a disconnected or uncertain managed chat against official persisted history once. Never replays a send.', { threadId }, ['threadId']),
  tool('codex_wait', 'Open one background event wait after dispatch. Provide the Antigravity conversationId from the project hook to register a resumable single-chat watch. After completion continue from nextCursor.', { threadIds, after: cursor, conversationId: id }, ['threadIds']),
  tool('codex_pause_receipt_watch', 'Pause the original conversation’s background watch and Sidecar notices when the user ends coordination. Retains the receipt history.', { threadId, conversationId: id }, ['threadId', 'conversationId']),
  tool('codex_wait_dispatch', 'Wait for a queued request to receive its authoritative desktop dispatch receipt. Use the original request ID. Only accepted receipts identify a verified project chat.', { requestId }, ['requestId']),
  tool('codex_inbox', 'Open the Codex receipt side panel and return retained feedback. Use eventId to read one exact receipt. Manual open without a thread shows the managed chat picker.', { threadId, eventId: positiveCursor, after: cursor, limit: page }, [], uiMeta),
  change('codex_bind_desktop', 'Send native Sidecar notices to this exact Antigravity conversation for the selected Codex chat. Set enabled false to pause notices.', { threadId, conversationId: id, after: cursor, enabled: flag }, ['threadId', 'conversationId', 'after', 'enabled']),
  tool('codex_desktop_status', 'Read sidecar delivery records for a managed Codex thread; accepted means the CLI accepted the notice.', { threadId, limit: page }, ['threadId']),
  tool('codex_panel_wait', 'Wait for the next receipt in an open inbox panel.', { threadIds, after: cursor }, ['threadIds'], { _meta: { ui: { visibility: ['app'] } } })
];

export function validate(spec, value, path = 'arguments') {
  const invalid = () => { throw new BridgeError('INVALID_ARGUMENT', `Invalid ${path}.`); };
  if (spec.enum && !spec.enum.includes(value)) invalid();
  if (spec.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    for (const key of spec.required ?? []) if (!Object.hasOwn(value, key)) invalid();
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(spec.properties, key)) invalid();
      validate(spec.properties[key], child, `${path}.${key}`);
    }
  } else if (spec.type === 'string') {
    if (typeof value !== 'string' || value.trim().length < spec.minLength || value.length > spec.maxLength) invalid();
  } else if (spec.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < spec.minimum || value > spec.maximum) invalid();
  } else if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') invalid();
  } else if (spec.type === 'array') {
    if (!Array.isArray(value) || value.length < (spec.minItems ?? 0) || value.length > spec.maxItems) invalid();
    value.forEach((child, index) => validate(spec.items, child, `${path}[${index}]`));
  }
}
