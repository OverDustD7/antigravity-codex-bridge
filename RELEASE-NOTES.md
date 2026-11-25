# Antigravity–Codex Bridge v0.2.1 (Windows Preview)

This preview adds an optional quota-saving switch and improves reply delivery from Codex to Antigravity. New installations use normal reporting. The switch is documented in both READMEs and stays set across bridge restarts.

## Changes

- Deliver one receipt for each confirmed end of a watched Codex turn, even when that turn already sent a progress report. Antigravity uses the original task to decide whether work should continue.
- Send explicitly requested reports to the originating Antigravity chat. Quota-saving mode keeps routine progress in the inbox while turn endings, requested reports, and marked course corrections still arrive.
- Find chats in native Codex projects by their exact working directory when the app has no recorded assignment. Explicit assignments and archive filters still apply.
- Use the registered Windows app identity when the bridge launches the official Codex desktop app.

## Install or upgrade

Download the v0.2.1 Windows ZIP and its SHA-256 file from Assets. Verify the checksum and follow the upgrade steps in the English or Chinese README. The preview requires Windows, Node.js 24 or later, and the official Codex and Antigravity clients.

The portable bundle was tested with an isolated Antigravity installation, including enabling and disabling quota saving. A local App Server with a deterministic test provider verified turn-ending receipts. A separate bridge test verified requested-reply routing. Full desktop installation on a fresh Windows account remains unverified.

The bridge's original code and documentation are MIT-licensed. Codex, Antigravity, and Node.js are installed separately under their own terms.
