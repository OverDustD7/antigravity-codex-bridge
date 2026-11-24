# Building and testing releases

The repository root doubles as an Antigravity plugin. The plugin manifest, hooks, rules, and MCP configuration live at the root. `src/` contains the shared bridge, the Codex desktop transport, the feedback script, and both MCP entry points.

The Antigravity component can be installed from the repository root. The Windows Release ZIP includes both sides and the adapter setup. [Antigravity plugin installation](https://antigravity.google/docs/plugins/#cli-shell-subcommands-agy-plugin)

Run these commands from the repository root on Windows with Node.js 24 and the Antigravity CLI available.

```powershell
agy plugin validate --strict .
$release = node .\scripts\build-windows-release.mjs | ConvertFrom-Json
node .\test\portable-preview.mjs $release.archive
Get-FileHash -Algorithm SHA256 -LiteralPath $release.archive
```

The build writes an installable ZIP and its SHA-256 file to `dist/`. The test uses an isolated Antigravity configuration and a synthetic conversation. It installs the plugin, verifies Codex-to-Antigravity delivery through both background receipt paths, then upgrades and removes the fixture plugin.

Match the Git tag to the version in both manifests. Before publishing, check the actual source and ZIP for the approved license and remove placeholder text from the README and release notes. Use the release notes as the GitHub Release description and attach the built ZIP and SHA-256 file as assets. The automatically generated source archives are useful for development. The Windows ZIP is the install package described in the README.
