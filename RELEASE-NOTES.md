# Antigravity–Codex Bridge v0.2.0 (Windows Preview)

Use Antigravity to find existing Codex desktop chats, send work to them, and receive progress or final output in the originating Antigravity conversation. After one-time setup, open Codex from its usual Windows icon. The bridge shares the App Server started by the official desktop app and keeps the desktop's native tool connection. The ZIP includes the Antigravity plugin, the Windows setup, the feedback script, and the optional Codex MCP server.

## Changes

- Install the Windows adapter once, then start Codex from its official icon. The desktop's native tools and the bridge share its App Server. The setup script supports Windows PowerShell.
- Keep Antigravity waiting quietly while Codex is offline. The bridge resumes from the saved cursor and wakes the relevant chat for a real receipt. Connection diagnostics remain available in the inbox.
- Retry confirmed unsent messages with the same request ID and arguments. A submitted message without a native acknowledgment remains protected against duplicate dispatch.
- Keep Codex working after a milestone report. Gemini reviews the roadmap, explains progress in plain language, and contacts the original Codex chat for major drift or a better next step supported by evidence.

## Install and verify

Download the Windows ZIP and its SHA-256 file from Assets. Extract the ZIP and follow the English or Chinese README. The preview requires Windows, Node.js 24 or later, and the two official desktop clients. Users of the v0.1.1 launcher should follow the upgrade steps before installing the adapter.

The ordinary Codex launch path was verified on an existing Windows setup. The package was checked with strict Antigravity validation and isolated plugin installation, upgrade, removal, and receipt tests. Full desktop installation on a fresh Windows account remains unverified. Background watches resume when the original Antigravity conversation runs again after reopening Antigravity. Use the optional Sidecar for delivery to an idle chat.

The bridge's original code and documentation are MIT-licensed. Codex, Antigravity, and Node.js are installed separately under their own terms.
