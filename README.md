# byoked-qwenwork

千问办公的本地 BYOK 模型桥。一条命令注入，正常启动千问办公即可使用自有模型。

## 使用

```bash
pnpm apply    # 注入 worker 补丁、注册登录自启动、立即启动本地桥
pnpm unapply  # 撤销补丁、移除自启动、停止桥并清理文件
```

`apply` 与 `unapply` 互为逆操作。应用后不需要任何专用启动脚本或环境变量，从桌面、开始菜单或任务栏正常打开千问办公即可；若执行 `apply` 时应用正在运行，重启一次应用让新补丁生效。

`apply` 会维护两处本地开关：worker 补丁，以及 `%USERPROFILE%\.qwenworkcn\.env` 中的 `ALLOW_CUSTOM_BYOK=1`。后者用于打开 2.1.0 主进程的 BYOK 门禁；`unapply` 只撤销本工具写入的这一行，保留该文件中的其他配置。

## 原理

1. 千问办公的 `qoder-agent-sdk` worker 负责会话与流式解析；BYOK 模型的推理请求原本发往 Qoder 网关，服务端会按账号权限返回 403。
2. 2.1.0 的 BYOK 门禁位于主进程：`allowCustomBYOK` 只认账号 `allow_byok >= 2` 或本地 `ALLOW_CUSTOM_BYOK` 开关。`pnpm apply` 在 `%USERPROFILE%\.qwenworkcn\.env` 写入 `ALLOW_CUSTOM_BYOK=1`（应用启动时会读取该设备配置文件），从而让客户端允许并展示自定义模型；`pnpm unapply` 只撤销本工具写入的这一行。
3. `pnpm apply` 在解包后的 worker 运行时里插入分支：带 `custom_model` 的推理请求改为构造标准 OpenAI `chat/completions` 请求，保留文本、图片与工具调用，发往 `127.0.0.1:17895` 的本地桥；同时让 BYOK 模型按 `agents.db` 的 `is_vl` 保留图片输入。
4. 本地桥优先用请求头解析上游，否则按模型名查询 `agents.db` 的 `byok_custom_models` 表：OpenAI 上游原样转发；Anthropic 上游把消息、图片与工具转换为 `/v1/messages` 请求，并把响应当场转换回 OpenAI SSE。
5. 桥接注册在 `HKCU\...\Run`，登录后以隐藏窗口自动启动；`apply` 也会立即启动它。

不修改 `app.asar`，不伪造账号状态，不做 MITM 证书拦截；门禁开关写在应用自己的设备配置里，不需要专用启动脚本或外部环境变量。

## 要求

- Windows，Node.js ≥ 22.13（使用内置 `node:sqlite`）。
- 已安装并登录千问办公；`agents.db` 中已有 `byok_custom_models` 记录。
- 模型上游接受 `Authorization: Bearer <API Key>`，并提供 OpenAI `chat/completions` 或 Anthropic `/v1/messages` 流式接口。
- 图片输入需要在模型编辑里勾选「图片支持」；未勾选时客户端仍会按文字占位处理。

## 限制

- Anthropic 上游不主动开启 thinking（`thinking` 事件会映射为 `reasoning_content`）；音频输入只对 OpenAI 上游透传。
- 官方升级覆盖 worker 后需要重新执行 `pnpm apply`；若升级同时改动 BYOK 门禁的环境变量名，需要同步更新本项目。
- 若系统或用户环境变量里设置了 `QODER_CLI_PATH`，千问办公会绕过 worker 补丁；`apply` 会检测并提示。
- 自定义模型的设置页签仍受客户端 profile 策略控制；本工具只负责让已登记的 `byok_custom_models` 记录在模型选择器中可用并直连上游。

## 目录

- `src/apply.js` — 一键注入：补丁、自启动、启动桥。
- `src/unapply.js` — 逆操作：回滚补丁、移除自启动、停止桥、清理文件。
- `src/patch.js` — worker 补丁的插入与回滚。
- `src/paths.js` — 安装目录、数据目录与注册表常量。
- `scripts/byok-model-bridge.cjs` — 本地桥，支持 OpenAI 与 Anthropic 上游及图片输入。
- `docs/` — 架构、决策与模块规格。
