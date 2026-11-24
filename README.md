# Codex Conversation Bridge

English | [简体中文](README.zh-CN.md)

Find, coordinate, and receive replies from existing Codex desktop chats in Antigravity. This Windows preview runs on your machine and uses your existing desktop sessions.

## Requirements

- Windows with the official Codex desktop app installed and signed in.
- Antigravity desktop and its `agy` CLI on `PATH`.
- Node.js 24 or later on `PATH`.

## Install

Extract the ZIP into its own folder and open PowerShell there. Finish any active Codex work, then fully quit Codex from its tray menu. Use these commands.

```powershell
agy plugin install (Get-Location).Path
node .\src\desktop-shared.mjs open
node .\src\daily.mjs control bridge_status
```

The last command should show `ready: true`. Open Antigravity and confirm **Codex Conversation Bridge** appears under **Customizations → Installed**. If Antigravity was already running and its tool list still shows the old setup, reopen it after installation. Use the bridge launch command when you want Codex connected. [Antigravity plugin installation](https://antigravity.google/docs/plugins/#cli-shell-subcommands-agy-plugin)

The Antigravity plugin supplies its tools, rules, and hooks. On the Codex side, `desktop-shared.mjs` connects the official desktop app to the bridge's local App Server. Codex can report progress for a delegated task using the feedback command in the handoff.

### Optional Codex tools for initiating a conversation

To let Codex discover active Antigravity listeners and initiate messages, register the separate MCP server from the extracted folder. This step requires the `codex` CLI on `PATH`.

```powershell
codex mcp add agy_bridge -- node (Join-Path (Get-Location).Path 'src/daily.mjs') codex-mcp
codex mcp list
```

`agy_bridge` should appear in the list. After reloading Codex, it provides `agy_list_listeners`, `agy_send_message`, and `agy_message_status`. [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli#configure-with-the-cli)

## Try it

1. In Antigravity, ask it to list the Codex chats in a project you name. The result should include their titles and working directories.
2. Pick a disposable chat and ask Antigravity to send “Reply with BRIDGE_OK” to that exact chat, then wait for a reply. You should see the message in the original Codex chat and the receipt in the original Antigravity chat.
3. For real work, ask Antigravity to pass the goal and acceptance criteria to Codex and wait for the next milestone. The coordination handoff includes the feedback command for Codex. Ordinary messages preserve your wording.

## How the two agents work together

- **Antigravity shapes the work with you.** It clarifies the goal, trade-offs, approximate plan, and acceptance criteria. It sends the handoff to the relevant Codex chat. `purpose: coordination` attaches the roles and reporting instructions whenever Antigravity directs the work or owns acceptance.
- **Codex does the work.** It refines the plan, implements and tests it, makes routine technical decisions, and continues every authorized task it can. It reports deliverable milestones, meaningful blockers, and material decisions in plain language with evidence. It hands off substantial audience-facing writing when that work benefits from Antigravity's review.
- **Antigravity reviews meaningful results.** It checks progress against the roadmap, explains the evidence in language you can use, and flags drift. For a major decision it reads the roadmap first, makes a recommendation, and asks you when the decision requires your judgment or authorization. Within an agreed unattended scope it can choose a reversible option that fits the roadmap and record it. Your decision goes back to the same Codex chat.

[Antigravity rules](rules/AGENTS.md) · [Codex implementation and reporting rules](docs/codex-role.md)

## Data and permissions

This plugin can read, send to, and manage local Codex chats available to your desktop session. A global installation exposes the bridge tools in your Antigravity chats. Use the normal client permission controls and only relay material appropriate for the receiving chat. Both apps keep their respective sign-in credentials. The bridge keeps local routing, delivery history, receipt text, and a generated local control key under `%USERPROFILE%\.codex-conversation-bridge`. It uses local named pipes and a loopback App Server connection. The model requests run through your existing apps and accounts. [Codex App Server](https://learn.chatgpt.com/docs/app-server)

## Receipts and restarts

`codex_wait` waits in the background and resumes from the saved cursor if the bridge worker restarts. After you quit and reopen Antigravity itself, ordinary watches are restored when the original Antigravity conversation runs again. The inbox retains available receipts so they can be read in order.

For automatic delivery to an idle chat after reopening Antigravity, enable the optional Sidecar in the Antigravity user configuration and bind that chat pair with `codex_bind_desktop`. Merge the following entry into `~/.gemini/config/config.json` under the existing `sidecars` object, keeping its other entries. The bind requires the originating Antigravity conversation, the Codex chat ID, and its latest confirmed receipt cursor. Use one receipt delivery path per pair. [Antigravity Sidecars](https://antigravity.google/docs/sidecars/)

```json
{
  "sidecars": {
    "codex-conversation-bridge/receipts": { "enabled": true }
  }
}
```

## Upgrade or remove

To upgrade, finish active work and fully quit Antigravity and Codex. Run `node .\src\desktop-shared.mjs stop` and `node .\src\daily.mjs control bridge_shutdown` from the extracted folder. Then follow the installation steps from the new folder. If you registered `agy_bridge`, rerun its registration from the new folder. The bridge keeps its existing data in your user profile.

To uninstall, disable any optional Sidecar entry you added, finish work, and fully quit Antigravity and Codex. Use these commands from the extracted folder.

```powershell
agy plugin uninstall codex-conversation-bridge
node .\src\desktop-shared.mjs stop
node .\src\daily.mjs control bridge_shutdown
```

If you registered the optional Codex MCP server, remove it with `codex mcp remove agy_bridge`. You can then open Codex from its usual icon. Codex chat history and the bridge's local data are retained. Back up the bridge data before removing it if you need the receipt history.

## Troubleshooting

- If Codex is running in another instance, finish its work and fully quit it from the tray before launching through the bridge.
- If `codex.exe` cannot be found, make the official CLI executable available on `PATH` or set `BRIDGE_CODEX_EXE` to its absolute path before launching from PowerShell.
- If a wait reports a connection error, keep its `nextCursor` and check `codex_inbox` before resending. Follow the session hook's fallback command if the MCP tools are temporarily unavailable.
- Local checks used Node.js 24.20.0, Antigravity CLI 1.5.16, and Codex App Server from CLI `0.171.0-alpha.13`. The isolated setup used the installer and local test data. Full desktop installation in a fresh Windows account remains unverified.

## Licensing

The project's original code and documentation are available under the [MIT License](LICENSE). The Codex and Antigravity apps and the Node.js runtime are installed separately and remain under their own terms.
