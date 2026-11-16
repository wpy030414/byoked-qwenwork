# 模块规格：本地 BYOK 模型桥

## 职责
让千问办公的 `byok-` 自定义模型绕过 Qoder 网关的账号模型授权，直接请求用户在 `agents.db` 中登记的上游端点；上游同时支持 OpenAI 与 Anthropic 协议，并完整保留图片等多模态内容。交付形式只有 `pnpm apply` 与 `pnpm unapply` 两条互逆命令。

## 组成

| 文件 / 位置 | 职责 |
| --- | --- |
| `src/apply.js` | 注入补丁、写入设备 `.env` 门禁开关、复制桥、注册登录自启动、启动桥。 |
| `src/unapply.js` | 逆操作：回滚补丁、撤销门禁开关、删除自启动、停止桥、清理文件。 |
| `src/patch.js` | 六处补丁的幂等插入与回滚（四类 BYOK 校验补丁 + 桥接补丁 + 视觉保留补丁）。 |
| `src/paths.js` | 安装目录、`agents.db`、设备 `.env`、本地桥目录与注册表常量。 |
| `scripts/byok-model-bridge.cjs` | 本地桥，监听 `127.0.0.1:17895`，向上游转发 OpenAI 或 Anthropic 请求。 |
| `%USERPROFILE%\.qwenworkcn\.env` | 应用自带的设备配置；`ALLOW_CUSTOM_BYOK=1` 打开主进程的 BYOK 门禁。 |
| `%LOCALAPPDATA%\byoked-qwenwork-bridge` | 运行时副本、`start-bridge.vbs`、桥日志与 `state.json`。 |
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\ByokedQwenWorkBridge` | 登录自启动。 |

## 接口

### 本地桥
- `POST http://127.0.0.1:17895/v1/chat/completions`
- 请求：标准 OpenAI Chat Completions JSON，必须带 `model`；可选的 worker 私有头：
  - `Authorization: Bearer <API Key>`
  - `x-byok-style`：`openai` 或 `anthropic`，决定上游协议。
  - `x-byok-upstream`：用户登记的上游 URL，优先于 `agents.db` 查询。
- 请求内容：`messages` 原样保留 `text`、`image_url`（data URL 或 http(s) URL）、`input_audio` 等 part；`tools`、`tool_choice`、`max_tokens`、`temperature`、`top_p`、`top_k`、`stop`、`seed` 等参数一并透传。
- 响应：统一输出 OpenAI `chat.completion.chunk` SSE，以 `data: [DONE]` 结束；Anthropic 上游的事件会被转换为同样的 chunk（文本、`reasoning_content`、`tool_calls`、`finish_reason`、`usage`）。
- 上游解析：优先使用 `x-byok-upstream`，否则按 `model` 查 `byok_custom_models.model` 取 `url`、`style`、`format`、`provider`、`extra_params.baseUrl`；依次尝试原路径与补全后的路径，遇到 404/405 才换下一个候选。

### 上游协议
- **OpenAI**：请求原样转发；`Authorization` 原样透传；响应 SSE 原样流回。
- **Anthropic**：路径补全为 `/v1/messages`；使用 `x-api-key` 与 `anthropic-version: 2023-06-01`；请求转换规则：
  - `system`/`developer` 消息合并为顶层 `system`。
  - `image_url` 的 data URL 转为 `{type:"image", source:{type:"base64", media_type, data}}`；http(s) 图片会先下载并内联为 base64（上限 10 MB），失败时退化为 `{type:"url"}`。
  - `tool` 消息转为 `tool_result`，assistant 的 `tool_calls` 转为 `tool_use`；连续同角色消息合并。
  - OpenAI `tools`/`tool_choice` 转为 Anthropic 的 `input_schema` 与 `tool_choice`。
  - 若上游以 400 拒绝过大的 `max_tokens`，自动降到 8192 重试一次。
- 鉴权：Anthropic 上游把 `Authorization: Bearer` 转换为 `x-api-key`。

### 设备门禁
- 文件：`%USERPROFILE%\.qwenworkcn\.env`（测试可用 `QWENWORK_DEVICE_ENV` 指向别处）。
- 键值：`ALLOW_CUSTOM_BYOK=1`。应用启动时由 `loadQoderDotEnv` 读入，主进程 `AuthStatusService` 据此把 `allowCustomBYOK` 置真，自定义模型才会进入模型选择器并带上 `custom_model` 走 worker 补丁分支。
- `apply`：不存在该键则追加；存在但值不为 `1/true/yes/on` 则改写为 `1`，并把原行记入本地桥目录的 `state.json`。已为真时不改文件。
- `unapply`：只处理 `state.json` 中 `owned: true` 的记录；恢复原行或删除该键，保留 `.env` 中其他内容；若文件由本工具创建且删键后为空则删除文件。

### worker 补丁
- 桥接补丁：在 legacy 推理发送点判断 `A.custom_model`，从 `A.messages`、`A.custom_model.model`、`A.custom_model.parameters.api_key` 组装 OpenAI 请求发往写死的桥地址；保留多模态 part、工具调用、工具结果与受限参数白名单，并附带 `x-byok-style`/`x-byok-upstream`。
- 视觉保留补丁：worker 在构造请求前会按 `model_config.is_vl` 把图片替换成文字占位；该补丁对 `custom_model` 请求按 `agents.db` 的 `is_vl` 判定，避免图片被丢弃。
- BYOK 校验补丁：`vkn` 恒真、`Asg` 强制 `allow_byok=2`、`normalizeUserStatus` 强制 `t=2`、`Ttg` 返回 `allow_byok=2`。

## 行为

### apply
1. 定位最新版本的解包 worker；找到桥接锚点后插入补丁，并补齐四类校验补丁与视觉保留补丁。
2. 写入前生成 `.byoked-bridge-bak`；写入后执行 `node --check`，失败则还原并退出。
3. 在设备 `.env` 写入或改写 `ALLOW_CUSTOM_BYOK=1`，并把归属记录到本地桥目录的 `state.json`。
4. 复制桥与 VBS 到本地桥目录，写入登录自启动，立即隐藏启动桥并等待端口就绪。
5. 若千问办公正在运行，已有 worker 可能仍使用旧代码；提示用户重启一次应用。
6. 若检测到持久化的 `QODER_CLI_PATH`，打印警告（该变量会让 SDK 绕过 worker）。

### unapply
1. 移除桥接补丁、四类校验补丁与视觉保留补丁；语法检查失败则保留补丁并退出。
2. 删除 `.byoked-bridge-bak`。
3. 删除登录自启动。
4. 按 `state.json` 的归属记录撤销设备 `.env` 中的门禁键（恢复原值或删除该行），保留其他配置。
5. 停止监听 `17895` 的进程，删除本地桥目录。

## 验收标准
- `pnpm apply` 后 worker 中同时存在桥地址与全部校验/视觉补丁，设备 `.env` 含 `ALLOW_CUSTOM_BYOK=1`，注册表自启动存在，桥在 `127.0.0.1:17895` 监听。
- 应用日志出现 `Resolved BYOK access ... allowCustomBYOK:true`，模型选择器出现 `agents.db` 中登记的 `byok-` 模型。
- 不设置外部环境变量、不使用专用启动脚本，从正常入口启动千问办公，选择 `byok-` 模型可收到真实回复；桥日志出现 `REQ model=... style=...` 与上游 200。
- 在客户端附带图片后，桥日志出现 `images>0` 与 `image_url` part；OpenAI 上游收到原始图片，Anthropic 上游收到 `image` 内容块，界面返回基于图片内容的回答。
- OpenAI 与 Anthropic 两种上游都返回可被应用渲染的流式回复；Anthropic 的工具调用与 usage 能映射为 OpenAI chunk。
- 重复执行 `pnpm apply` 不产生重复补丁。
- `pnpm unapply` 后桥地址与全部补丁消失，设备 `.env` 中的门禁键被撤销，自启动删除，桥进程停止，本地桥目录清理；worker 通过 `node --check`。
- 再次 `pnpm apply` 可完整恢复。

## 错误处理与限制
- 上游必须接受 Bearer 鉴权（Anthropic 会转换为 `x-api-key`）并提供流式接口；否则桥返回上游错误。
- Anthropic 上游的 `thinking` 会映射为 `reasoning_content`，但不主动开启 thinking；音频 part 仅对 OpenAI 上游透传，Anthropic 侧会被忽略。
- 远程图片下载失败时退化为 Anthropic 的 URL source；超过 10 MB 的图片不做内联。
- 视觉保留补丁按 `agents.db.is_vl` 判定；用户关闭「图片支持」的模型仍会把图片替换为文字占位。
- 官方升级覆盖 worker 后需重新 `apply`；补丁锚点变化时对应补丁会给出警告并跳过。
- `ALLOW_CUSTOM_BYOK` 是 2.1.0 主进程识别的本地开关；若官方改名或移除该开关，需要同步更新 `BYOK_ENV_KEY`，否则门禁不会打开。
- 自定义模型的设置页签仍受客户端 profile 策略控制；本工具不改该页签的可见性，只让已登记的 `byok_custom_models` 记录在模型选择器中可用并直连上游。
- 桥仅监听回环地址，只读 `agents.db`。

## 排查
- 桥日志：`%LOCALAPPDATA%\byoked-qwenwork-bridge\byok-model-bridge.log`；`REQ` 行包含 `images`、`style`、`upstreams` 与最近四条消息的 part 类型。
- 监听确认：`netstat -ano | findstr :17895`
- 补丁确认：worker 中存在 `http://127.0.0.1:17895/v1/chat/completions` 与 `supportsVision:l.is_vl||!g`。
- 门禁确认：`%USERPROFILE%\.qwenworkcn\.env` 中存在 `ALLOW_CUSTOM_BYOK=1`；应用日志应出现 `Resolved BYOK access {"envAllowsCustomByok":true,"allowCustomBYOK":true}`。若仍为 false，检查该文件与 `QWENWORK_DEVICE_ENV`。
- 自启动确认：`reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v ByokedQwenWorkBridge`

## 回滚
优先执行 `pnpm unapply`。兜底时用 worker 同目录的 `.byoked-bridge-bak` 覆盖，并删除自启动值与本地桥目录。
