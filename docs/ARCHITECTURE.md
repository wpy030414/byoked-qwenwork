# 架构

## 目标
在不修改 `app.asar`、不伪造账号状态的前提下，让千问办公的 BYOK 模型请求绕过 Qoder 网关的账号模型授权，直接访问用户配置的模型端点。

## 模块

| 模块 | 职责 |
| --- | --- |
| `src/apply.js` | 定位 worker、写入补丁、写入设备 `.env` 的 BYOK 门禁开关、创建本地桥文件与登录自启动、立即启动桥。 |
| `src/unapply.js` | 逆操作：回滚 worker 补丁、撤销本工具写入的门禁行、删除自启动、停止桥、清理本地文件。 |
| `src/patch.js` | 补丁文本的插入、迁移与回滚；桥地址硬编码为 `http://127.0.0.1:17895/v1/chat/completions`，并保留 BYOK 模型的图片输入。 |
| `src/paths.js` | 解析千问办公安装目录、`agents.db`、设备 `.env`、本地桥目录与 `HKCU` 注册表常量。 |
| `scripts/byok-model-bridge.cjs` | 监听 `127.0.0.1:17895`，按模型名或请求头解析上游；OpenAI 上游原样转发，Anthropic 上游负责请求/响应双向转换，图片统一转换后发送。 |
| 千问办公 worker | 官方 `qoder-agent-sdk` 会话运行时；补丁只替换其 legacy 推理发送分支，并让 BYOK 模型按 `agents.db` 的 `is_vl` 保留图片输入。 |
| 设备 `.env` | `%USERPROFILE%\.qwenworkcn\.env`；应用启动时读取，`ALLOW_CUSTOM_BYOK=1` 打开主进程的 BYOK 门禁。 |
| `agents.db` | 模型数据的最终来源；桥只读 `byok_custom_models`。 |

## 运行时数据流

1. 千问办公启动时读取设备 `.env`；`ALLOW_CUSTOM_BYOK=1` 使主进程的 `allowCustomBYOK` 为真，模型选择器展示 `agents.db` 中的自定义模型。
2. 用户在千问办公新建对话并选择 `byok-` 模型，可附带图片。
3. worker 解析出 `custom_model`（含模型名、API Key 与 style），补丁把消息与多模态内容转换为标准 OpenAI 请求，发往 `127.0.0.1:17895`。
4. 本地桥解析上游协议：OpenAI 上游原样转发；Anthropic 上游把消息、图片、工具转换为 `messages` 请求，并把 Anthropic SSE 转换为 OpenAI chunk。
5. 统一后的 OpenAI SSE 回到 worker，由官方流式解析器渲染。

## 持久化与生命周期

- worker 补丁：写在安装目录的解包 worker 文件中；`apply` 前生成 `.byoked-bridge-bak`，`unapply` 成功后删除。
- 设备门禁：`apply` 在 `%USERPROFILE%\.qwenworkcn\.env` 写入或改写 `ALLOW_CUSTOM_BYOK=1`，并在本地桥目录的 `state.json` 记录归属；`unapply` 只撤销这一行（或恢复原值），不触碰文件中其他配置。
- 本地桥：源文件复制到 `%LOCALAPPDATA%\byoked-qwenwork-bridge`；登录自启动值 `ByokedQwenWorkBridge` 位于 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`。
- 官方升级覆盖 worker 后，补丁失效；重新执行 `pnpm apply` 即可。若门禁开关改名，需要同步更新 `src/paths.js`。

## 边界
- 不修改 `app.asar`，不拦截 TLS，不伪造用户状态或云端权限。
- 设备 `.env` 只增加 `ALLOW_CUSTOM_BYOK=1`（或改写该键），由 `unapply` 按归属记录精确撤销；不写账号状态。
- 桥只监听回环地址，只读 `agents.db`，不写模型表。
