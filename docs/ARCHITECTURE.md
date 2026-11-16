# 架构

## 目标
在不修改 `app.asar`、不伪造账号状态的前提下，让千问办公的 BYOK 模型请求绕过 Qoder 网关的账号模型授权，直接访问用户配置的模型端点。

## 模块

| 模块 | 职责 |
| --- | --- |
| `src/apply.js` | 定位 worker、写入补丁、创建本地桥文件与登录自启动、立即启动桥。 |
| `src/unapply.js` | 逆操作：回滚 worker 补丁、删除自启动、停止桥、清理本地文件。 |
| `src/patch.js` | 补丁文本的插入、迁移与回滚；桥地址硬编码为 `http://127.0.0.1:17895/v1/chat/completions`，并保留 BYOK 模型的图片输入。 |
| `src/paths.js` | 解析千问办公安装目录、`agents.db`、本地桥目录与 `HKCU` 注册表常量。 |
| `scripts/byok-model-bridge.cjs` | 监听 `127.0.0.1:17895`，按模型名或请求头解析上游；OpenAI 上游原样转发，Anthropic 上游负责请求/响应双向转换，图片统一转换后发送。 |
| 千问办公 worker | 官方 `qoder-agent-sdk` 会话运行时；补丁只替换其 legacy 推理发送分支，并让 BYOK 模型按 `agents.db` 的 `is_vl` 保留图片输入。 |
| `agents.db` | 模型数据的最终来源；桥只读 `byok_custom_models`。 |

## 运行时数据流

1. 用户在千问办公新建对话并选择 `byok-` 模型，可附带图片。
2. worker 解析出 `custom_model`（含模型名、API Key 与 style），补丁把消息与多模态内容转换为标准 OpenAI 请求，发往 `127.0.0.1:17895`。
3. 本地桥解析上游协议：OpenAI 上游原样转发；Anthropic 上游把消息、图片、工具转换为 `messages` 请求，并把 Anthropic SSE 转换为 OpenAI chunk。
4. 统一后的 OpenAI SSE 回到 worker，由官方流式解析器渲染。

## 持久化与生命周期

- worker 补丁：写在安装目录的解包 worker 文件中；`apply` 前生成 `.byoked-bridge-bak`，`unapply` 成功后删除。
- 本地桥：源文件复制到 `%LOCALAPPDATA%\byoked-qwenwork-bridge`；登录自启动值 `ByokedQwenWorkBridge` 位于 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`。
- 官方升级覆盖 worker 后，补丁失效；重新执行 `pnpm apply` 即可。

## 边界
- 不修改 `app.asar`，不拦截 TLS，不伪造用户状态或云端权限。
- 桥只监听回环地址，只读 `agents.db`，不写模型表。
