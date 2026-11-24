# Antigravity–Codex 协作桥

[English](README.md) | 简体中文

在 Antigravity 里查找本机已有的 Codex 桌面会话，直接派工、追问和收回执。这个预览版面向 Windows，沿用两个官方客户端的登录和聊天记录。

## 项目状态与支持范围

项目仍在维护，目前提供 Windows 桌面预览版。插件在 Antigravity 中显示为 **Codex Conversation Bridge**。安装包见 [GitHub Releases](https://github.com/OverDustD7/antigravity-codex-bridge/releases)。

## 环境要求

- Windows，已安装并登录官方 Codex 桌面端。
- Antigravity 桌面端，终端能运行 `agy`。
- Node.js 24 或更新版本，终端能运行 `node`。

## 安装

把 ZIP 解压到单独的目录，在该目录打开 PowerShell。等 Codex 当前工作结束，在系统托盘彻底退出 Codex，再执行下面的命令。

```powershell
agy plugin install (Get-Location).Path
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-windows-native-desktop.ps1 -Install
```

用 Windows 的官方图标打开 Codex。从解压目录运行 `node .\src\daily.mjs control bridge_status`，应看到 `ready: true` 和 `desktopTransport: "official_desktop"`。在 Antigravity 的 **Customizations → Installed** 查找 **Codex Conversation Bridge**。如果装完仍看到旧的工具列表，可以重开 Antigravity。 [Antigravity 插件安装文档](https://antigravity.google/docs/plugins/#cli-shell-subcommands-agy-plugin)

Antigravity 插件提供派工工具、协作规则和会话钩子。Windows 安装脚本会一次性设置当前用户的 `CODEX_CLI_PATH` 适配器。官方桌面仍负责启动 Codex 核心和配置原生工具，协作桥接入这一份核心。接到正式派工后，Codex 可以用消息附带的反馈命令向原会话交回执。

### 可选功能：让 Codex 主动联系 Antigravity

如果还需要让 Codex 自己发现正在监听的 Antigravity 会话并主动发消息，在解压目录注册独立的 MCP 服务。这一步需要终端能运行 `codex`。

```powershell
codex mcp add agy_bridge -- node (Join-Path (Get-Location).Path 'src/daily.mjs') codex-mcp
codex mcp list
```

列表中应显示 `agy_bridge`。重新加载 Codex 后，会提供 `agy_list_listeners`、`agy_send_message` 和 `agy_message_status`。 [Codex MCP 配置文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli#configure-with-the-cli)

## 第一次使用

1. 在 Antigravity 里指定一个 Codex 项目，请它列出该项目的聊天。结果应包含聊天标题和工作目录。
2. 选一个测试聊天，请它向这个 Codex 原聊天发「请回复 BRIDGE_OK」，然后等回执。你可以在 Codex 原聊天中核对收到的消息，在 Antigravity 原聊天中看到回执。
3. 正式派工时，在 Antigravity 里确认目标和验收要求，再交给 Codex。桥会把回执操作写入正式派工消息。普通交流按原文发送。

## 两边怎么分工

- **Antigravity 先和你定方向。** 把需求、取舍、初步路线和验收条件谈清楚，再发到对应的 Codex 原聊天。每次正式指导工作或负责阶段验收时，使用 `purpose: coordination` 附上分工和回执说明。
- **Codex 负责做完。** 补齐计划，自主实施、测试和验收。小进展合并为一条，长阶段在方向仍可调整时主动同步。阶段汇报发完就在原回合接着做。确实卡住或遇到重大路线分歧时，附证据说明。说明书等面向读者的大段写作可以交给 Antigravity。
- **Antigravity 整理进展、检查方向。** 对照已确认的路线图和证据，用人话讲清结果、实际影响和下一步。只有发现重大跑偏，或有依据支持更好的下一步，才就这条汇报联系原 Codex 聊天。重大分歧先给建议，需要你拍板或新增授权时再提问。你已授权的无人值守范围内，可以按路线图选择可逆的方案并记录。

[Antigravity 协调规则](rules/AGENTS.md) · [Codex 执行和回执规则](docs/codex-role.md)

## 数据和权限

桥接入本机 Codex 桌面已有会话后，可以读取、发送和管理这些会话。全局安装会把工具提供给 Antigravity 的各个聊天。权限仍由各客户端管理，转发资料时注意接收方。登录凭证由各客户端保管。桥把路由、投递记录、回执正文和自动生成的本机控制密钥存放在 `%USERPROFILE%\.codex-conversation-bridge`，通过本机命名管道和回环接口通信。模型调用仍走原客户端和账号。注册桌面适配器期间，保留解压目录。 [Codex App Server](https://learn.chatgpt.com/docs/app-server)

## 回执与重启

`codex_wait` 在后台等事件。Codex 离线或桥后台重启时，原等待沿保存的游标静默续接，实际回执才唤醒对应会话。断连记录留在收件箱供主动查看。退出并重开 Antigravity 后，普通监听在原 Antigravity 会话再次运行时续接。

如需重开 Antigravity 后自动向闲置原聊天推送回执，可启用 Sidecar 并用 `codex_bind_desktop` 绑定原 Antigravity 会话、Codex 原聊天及最后确认的游标。把下面的条目合并到 `~/.gemini/config/config.json` 的 `sidecars`，保留已有条目。同一对聊天保留一种回执投递方式。 [Sidecar 配置文档](https://antigravity.google/docs/sidecars/)

```json
{
  "sidecars": {
    "codex-conversation-bridge/receipts": { "enabled": true }
  }
}
```

## 升级和卸载

升级时，先结束当前工作并彻底退出 Antigravity 和 Codex。从旧目录运行 `node .\src\daily.mjs control bridge_shutdown`。如果原来用的是 0.1.1 的桥启动器，再运行 `node .\src\desktop-shared.mjs stop`。如果旧目录注册过适配器，先从旧目录执行下面的适配器卸载命令，再从新版目录安装。如果注册了 `agy_bridge`，也从新版目录重新注册。本地桥接数据会保留。

卸载时，关闭自己启用的 Sidecar，结束工作并彻底退出 Antigravity 和 Codex，然后从解压目录执行下面的命令。

```powershell
agy plugin uninstall codex-conversation-bridge
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-windows-native-desktop.ps1 -Uninstall
node .\src\daily.mjs control bridge_shutdown
```

如果注册了可选的 Codex MCP 服务，用 `codex mcp remove agy_bridge` 移除。之后可以用原图标打开 Codex。原聊天和桥的本地数据会保留。若还需要历史回执，处理数据目录前先备份。

## 排查

- 如果桥找不到桌面后台，安装完成后从托盘退出 Codex，再用官方图标打开。如果官方图标仍沿用旧环境，注销 Windows 后重新登录一次。
- 如果找不到 `codex.exe`，把官方 CLI 的可执行文件加入 `PATH`，或在启动桥之前把 `BRIDGE_CODEX_EXE` 设为它的实际绝对路径。
- 如果回执等待断线，保存最后确认的 `nextCursor`，先查 `codex_inbox`。MCP 工具暂时不可用时，可以用会话钩子给出的备用脚本。
- 派工返回 `CODEX_MESSAGE_NOT_SENT` 时，等 Codex 恢复连接后用原请求编号和原参数重试。返回 `REQUEST_IN_FLIGHT_OR_UNCERTAIN` 时，先到原聊天核对是否收到。
- 本机使用 Node.js 24.20.0、Antigravity CLI 1.5.16 和 Codex CLI `0.171.0-alpha.13` 自带的 App Server 验证。安装器使用本机隔离配置和测试数据。全新 Windows 账号下的完整桌面安装尚未验收。

## 问题反馈

报告问题时附上客户端版本和脱敏后的复现步骤。 [GitHub Issues](https://github.com/OverDustD7/antigravity-codex-bridge/issues)

## 许可证

本项目原创代码和文档采用 [MIT 许可证](LICENSE)。Codex、Antigravity 和 Node.js 各自单独安装，适用各自条款。
