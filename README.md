# Antigravity–Codex Bridge

English | [简体中文](README.zh-CN.md)

Find, coordinate, and receive replies from existing Codex desktop chats in Antigravity. This Windows preview runs on your machine and uses your existing desktop sessions.

## Status and supported setup

This project is maintained as a Windows desktop preview. The Antigravity plugin appears as **Codex Conversation Bridge**. Get the Windows install package from [GitHub Releases](https://github.com/OverDustD7/antigravity-codex-bridge/releases).

## Requirements

- Windows with the official Codex desktop app installed and signed in.
- Antigravity desktop and its `agy` CLI on `PATH`.
- Node.js 24 or later on `PATH`.

## Install

Extract the ZIP into its own folder and open PowerShell there. Finish any active Codex work, then fully quit Codex from its tray menu. Use these commands.

```powershell
agy plugin install (Get-Location).Path
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-windows-native-desktop.ps1 -Install
```

Open Codex from its usual Windows icon. From the extracted folder, run `node .\src\daily.mjs control bridge_status` and look for `ready: true` and `desktopTransport: "official_desktop"`. Open Antigravity and confirm **Codex Conversation Bridge** appears under **Customizations → Installed**. If Antigravity still shows its old tools, reopen it after installation. [Antigravity plugin installation](https://antigravity.google/docs/plugins/#cli-shell-subcommands-agy-plugin)

The Antigravity plugin supplies its tools, rules, and hooks. The one-time Windows setup registers a per-user `CODEX_CLI_PATH` adapter. The official desktop app starts its own Codex core with its native tool settings. The adapter lets the bridge attach to the same core. Codex can report progress using the feedback command in the handoff.

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
- **Codex does the work.** It refines the plan, implements and tests it, and makes routine technical decisions. It combines small steps into brief milestone reports and checks in during long stages while a change is still practical. After reporting, it continues the next authorized step in the same turn. It flags real blockers and major decisions and hands off substantial audience-facing writing.
- **Antigravity explains progress and checks direction.** It checks the agreed roadmap and evidence, then explains the result, its impact, and the next step in plain language. It contacts the same Codex chat about a milestone only for major drift or an evidence-backed improvement. For a major decision, it gives a recommendation and asks you when your judgment or authorization is needed. Within an agreed unattended scope it can choose a reversible option that fits the roadmap and record it.

[Antigravity rules](rules/AGENTS.md) · [Codex implementation and reporting rules](docs/codex-role.md)

## Data and permissions

This plugin can read, send to, and manage local Codex chats available to your desktop session. A global installation exposes the bridge tools in your Antigravity chats. Use the normal client permission controls and only relay material appropriate for the receiving chat. Both apps keep their respective sign-in credentials. The bridge keeps local routing, delivery history, receipt text, and a generated local control key under `%USERPROFILE%\.codex-conversation-bridge`. It uses local named pipes and a loopback App Server connection. The model requests run through your existing apps and accounts. Keep the extracted folder in place while the desktop adapter is registered. [Codex App Server](https://learn.chatgpt.com/docs/app-server)

## Receipts and restarts

`codex_wait` keeps the original wait and cursor while Codex is offline or the bridge restarts. A real receipt wakes its target chat. Disconnect diagnostics are available in the inbox. After you quit and reopen Antigravity itself, ordinary watches are restored when the original Antigravity conversation runs again.

For automatic delivery to an idle chat after reopening Antigravity, enable the optional Sidecar in the Antigravity user configuration and bind that chat pair with `codex_bind_desktop`. Merge the following entry into `~/.gemini/config/config.json` under the existing `sidecars` object, keeping its other entries. The bind requires the originating Antigravity conversation, the Codex chat ID, and its latest confirmed receipt cursor. Use one receipt delivery path per pair. [Antigravity Sidecars](https://antigravity.google/docs/sidecars/)

```json
{
  "sidecars": {
    "codex-conversation-bridge/receipts": { "enabled": true }
  }
}
```

## Upgrade or remove

To upgrade, finish active work and fully quit Antigravity and Codex. From the old folder, run `node .\src\daily.mjs control bridge_shutdown`. If you were using the 0.1.1 launcher, also run `node .\src\desktop-shared.mjs stop`. If you previously registered an adapter from that folder, run the uninstall command below for the adapter before moving to the new folder. Follow the installation steps and rerun the optional `agy_bridge` registration if you use it. The bridge keeps its existing data in your user profile.

To uninstall, disable any optional Sidecar entry you added, finish work, and fully quit Antigravity and Codex. Use these commands from the extracted folder.

```powershell
agy plugin uninstall codex-conversation-bridge
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-windows-native-desktop.ps1 -Uninstall
node .\src\daily.mjs control bridge_shutdown
```

If you registered the optional Codex MCP server, remove it with `codex mcp remove agy_bridge`. You can then open Codex from its usual icon. Codex chat history and the bridge's local data are retained. Back up the bridge data before removing it if you need the receipt history.

## Troubleshooting

- If the bridge cannot find the official desktop host, fully quit Codex and reopen it from its usual icon after installation. If the icon still launches with the old environment, sign out of Windows and back in.
- If `codex.exe` cannot be found, make the official CLI executable available on `PATH` or set `BRIDGE_CODEX_EXE` to its absolute path before launching from PowerShell.
- If a wait reports a connection error, keep its `nextCursor` and check `codex_inbox` before resending. Follow the session hook's fallback command if the MCP tools are temporarily unavailable.
- If a send returns `CODEX_MESSAGE_NOT_SENT`, retry with the same request ID and arguments after Codex reconnects. For `REQUEST_IN_FLIGHT_OR_UNCERTAIN`, check the original chat for delivery evidence before taking further action.
- Local checks used Node.js 24.20.0, Antigravity CLI 1.5.16, and Codex App Server from CLI `0.171.0-alpha.13`. The isolated setup used the installer and local test data. Full desktop installation in a fresh Windows account remains unverified.

## Feedback

Include your client versions and a redacted reproduction when reporting a bug. [GitHub Issues](https://github.com/OverDustD7/antigravity-codex-bridge/issues)

## Licensing

The project's original code and documentation are available under the [MIT License](LICENSE). The Codex and Antigravity apps and the Node.js runtime are installed separately and remain under their own terms.
