# DECISIONS

> ADR-001～009 记录了旧的 Web 管理端与 MITM 方案，相关代码已移除；当前有效方案见 ADR-010。

## ADR-001：绕过官方设置页，直接写入 byok_custom_models 表
- 日期：2026-11-16
- 状态：已采纳
- 背景（遇到了什么问题）：本机千问办公 2.1.0 的 `.status.json` 显示 `allow_byok=0`，设置页中 `customModels` 标签被隐藏；官方添加流程还依赖 SDK 连通性校验，当前不可用。
- 考虑过的方案：修改 `.status.json` 的 `allow_byok`；修改应用包内前端资源；修改系统配置服务缓存；直接写入应用使用的 SQLite 表。
- 决策：只写用户数据目录里的 `agents.db`，不修改安装目录、账号状态或云端策略。
- 为什么选这个：主程序仍从该表读取自定义模型，落点明确；改动范围最小，也不需要重打包应用。
- 为什么不选其他：改状态或应用包会随升级失效，且可能破坏签名或引入不可控副作用。
- 后果：用户必须重启千问办公刷新模型缓存；表结构变化时需要同步维护本项目。
- 何时重新审视：千问办公官方恢复可用的自定义模型入口，或自定义模型存储迁移到别处。

## ADR-002：使用 plainBase64 编码 API Key
- 日期：2026-11-16
- 状态：已采纳
- 背景（遇到了什么问题）：官方主程序用 Electron `safeStorage` 加密参数，但本工具是普通 Node 进程，无法在同一用户密钥上下文中使用该 API。
- 考虑过的方案：从 Electron 提取 safeStorage 密钥；调用主程序 IPC 代写；使用 `plainBase64` 回退格式；明文直接存 JSON。
- 决策：沿用主程序已支持的 `plainBase64` 回退格式，同时在页面和终端提示安全等级低于 `safeStorage`。
- 为什么选这个：主程序 `decodeParameter()` 能读取该格式，且不需要侵入 Electron 进程。
- 为什么不选其他：提取密钥或调用内部 IPC 脆弱且高风险；明文 JSON 不符合主程序参数结构。
- 后果：API Key 以可解码形式保存在本机数据库；持有该文件读权限的人可恢复 Key。
- 何时重新审视：找到稳定、受支持的本机密钥代理，或官方开放自定义模型写入 API。

## ADR-004：自定义模型默认 1000k 输入 / 300k 输出，并阻止零输入预算
- 日期：2026-11-16
- 状态：已采纳
- 背景（遇到了什么问题）：用户选择自有模型对话后立即失败，日志为 `The resolved model limits leave no usable input budget`。当前记录的最大输入和输出均为 1000k；千问办公按 `上下文 - 输出预留 - 安全预留` 计算输入预算，二者相等时预算为 0。
- 考虑过的方案：允许任意输入输出组合并在运行时报错；自动把输出改成固定 128k；校验输出不超过输入的一半；只提示用户手动修改数据库。
- 决策：新增模型默认 1000k 输入、300k 输出；保存时要求最大输出 Token 不超过最大输入 Token 的一半，并把当前 1000k/1000k 记录改为 1000k/300k。
- 为什么选这个：保留 1000k 上下文和较大的输出额度，同时给千问办公留出正向输入预算；比固定改写更尊重用户配置。
- 为什么不选其他：固定 128k 会破坏已有大输出需求；只在运行时报错无法解释真正的配置问题；要求手改数据库违背项目目标。
- 后果：极端“巨大输出、极小输入”的模型配置不再被允许；已有同类记录需要调低输出或调高输入。
- 何时重新审视：千问办公改变输入预算算法，或明确支持输入与输出相等的模型配置。

## ADR-005：使用独立编辑弹窗管理已有模型
- 日期：2026-11-16
- 状态：已采纳
- 背景（遇到了什么问题）：原页面的编辑只提供少量行内字段，无法调整 Token 上限与图片支持；添加弹窗的取消按钮因 `method="dialog"` 会触发提交流程。
- 考虑过的方案：扩充行内编辑控件；为编辑复用弹窗并显式处理取消事件；保留旧表单但增加更多输入框。
- 决策：添加与编辑共用同一个弹窗；取消按钮使用 `type="button"` 并显式关闭；编辑时 API Key 留空表示保留原值。
- 为什么选这个：共享表单避免添加与编辑字段不一致，显式事件处理避免原生 dialog 的默认提交行为。
- 为什么不选其他：行内编辑在窄屏下拥挤，扩展现有表单仍会重复两套字段。
- 后果：编辑已有模型需要通过“编辑”按钮进入弹窗；保存后仍建议重启千问办公刷新缓存。
- 何时重新审视：页面改为完整的设置页组件体系，或有统一的表单状态管理方案。

## ADR-003：数据库被占用时退化为只读模式
- 日期：2026-11-16
- 状态：已采纳
- 背景（遇到了什么问题）：千问办公运行时会打开 SQLite 文件；此时强行写入可能出现锁冲突，且用户未必愿意退出应用。
- 考虑过的方案：始终拒绝启动；强制关闭千问办公；始终以只读方式打开；启动时检测可写性，可写则正常模式、不可写则只读模式。
- 决策：启动时按可写性切换模式；只读模式下页面仍可查看模型，但禁用所有写操作。
- 为什么选这个：兼顾查看与写入安全，避免误关闭用户正在使用的应用。
- 为什么不选其他：始终拒绝或强制关闭用户体验差；始终只读无法完成核心目标。
- 后果：用户想保存改动时必须先退出千问办公再重启本工具。
- 何时重新审视：找到安全的应用内热更新模型缓存机制。

## ADR-006：给 worker 运行时打 BYOK 恒真补丁，禁止向服务端求证
- 日期：2026-11-16
- 状态：已采纳
- 背景（遇到了什么问题）：自定义模型的连通性校验 `checkBYOKModel`（worker 内实现函数 `vkn`）以 `route:"server"` 把用户 Key 随请求上报 `gateway.qwenwork.cn` 的 `/algo/api/v2/by*` 接口求证，服务端策略返回 `Request-supplied BYOK is disabled`；而实际推理的 `baseUrl` 取自模型自身的 `url` 字段（直连用户端点），该校验是唯一阻断点，且属于客户端主动上报而非服务端强制。
- 考虑过的方案：屏蔽网关域名（误伤全部云端功能）；改账号状态快照的 `allow_byok`（UI 侧已由 `ALLOW_CUSTOM_BYOK=1` 放行，与本校验无关）；在 `vkn` 函数体开头插入早返回使校验恒真；重写执行链路强制直连。
- 决策：在 `app.asar.unpacked/node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs` 中，将 `async function vkn(A,e,t,i,r,n,o,s){` 替换为 `async function vkn(A,e,t,i,r,n,o,s){if(1)return;`，使其两处调用（`validate_byok_model` 的 `Xrt` 包装与 `check_byok_config` 处理器）恒真且不再发起上报。
- 为什么选这个：单点最小改动覆盖全部调用方；不触碰 `app.asar` 及其完整性清单；补丁 12 字节、可随原始备份一键回滚。
- 为什么不选其他：屏蔽域名影响面过大；状态快照路径与该校验无关；重写链路在 34MB 混淆代码中不可维护，且官方升级同样会覆盖。
- 后果：设置入口的连通性测试不再真实探测，Key 或地址配错只会在真实对话时暴露；千问办公每次升级到新版本目录都会覆盖补丁，需按本 ADR 重新应用；ADR-001 中「不修改安装目录」的约束自本条起放开为上述例外。若日后发现对话请求也改走网关中继（不再直连），本补丁需重新评估。
- 何时重新审视：官方恢复 BYOK 校验接口放行，或 worker 运行时引入启动完整性校验导致补丁失效。

### ADR-006 追记（2026-11-16 晚）
- 实测结果：恒真补丁生效，设置页可直接保存模型；但对话被服务端以 403 拒绝，错误体为 `You do not have access to this model service. Please check your account permissions.`，界面上映射为「暂无使用权限」。该文案在 app.asar、worker 运行时及全部本地资源中均不存在，来自认证网关（`wss://…/ws`，设备注册 + 账号 token，发现服务响应带验签）的服务端裁决。
- 结论修正：qoder-cli 框架下的 byok 对话推理同样经网关中继；背景中「直连用户端点」的判断只适用于 opencode 等本地引擎的 provider 构造。预留分支「对话走网关中继」已被证实。
- 影响面：403 属服务端强制，客户端补丁无法解除。唯一本地出路是把 byok 模型路由切到 opencode 执行框架（自带 `OPENCODE_PROVIDER_BASE_URL` + `Authorization: Bearer` 直连机制，安装目录已分发 `agent-sdk/opencode`），但路由决策位于打包 app.asar 主进程（SessionModelRouteService / catalog snapshot），快照缓存 `data/model-catalog/chat-modes-v2/*.lkg` 为加密容器。需 asar 级改动方可实施，暂未动手。

### ADR-006 二次追记（同日）：服务端裁决的正面强攻
- 已实施（worker 运行时全部通过 `node --check`）：
  1. `Asg` 与 `Ttg` 两个账号状态归一化出口强制 `allow_byok=2`（原内部开关仅对 @alibaba-inc.com 邮箱放行；服务端仍可拒绝，此项只统一本地视图）。
  2. 保持 `vkn` 恒真；设置页保存已验证可用。
- 已验证但**未应用**的 asar 方案：`out/main/main.js` 中 `resolveLocalByokModelRoute` 把 BYOK 模型硬编码为 `harness:"qoder-cli"`（走认证网关），可在该文件偏移 326401940 处将 `qoder-cli` 等长改为 `opencode`，使 BYOK 路由走 `OPENCODE_PROVIDER_BASE_URL` + Bearer Key 直连。试制副本与主 asar 头（15417613 字节）完全一致，改动单一锚点、无需重算长度；试制文件留于仓库 `app.asar.patch-stage`，原始 asar 已备份为 `resources/app.asar.orig-20261116-2`。
- 未应用原因与验证条件：本地无法在无图形会话下确认 opencode 引擎能吃下 byok 模型参数，且 403 也可能还受服务端模型白名单限制。应用命令（确认后执行）：`cp app.asar.patch-stage "C:\Program Files\QwenWorkCN\2.1.0-26111315\resources\app.asar"`；回滚：`cp "...\resources\app.asar.orig-20261116-2" "...\resources\app.asar"`。重启千问办公后观察是否出现 `OPENCODE_*` 环境或直连端点请求；若出现新错误需继续分析日志。

## ADR-007：把 BYOK 模型执行引擎从 qoder-cli 切到 opencode（已应用，待验证）
- 日期：2026-11-16
- 状态：已应用
- 背景（遇到了什么问题）：ADR-006 追记确认 qoder-cli 下 BYOK 对话经认证网关被服务端 403 拒绝；安装目录已分发 opencode 引擎，其 provider 走 `OPENCODE_PROVIDER_BASE_URL` + `OPENCODE_API_KEY` 直连用户端点，不经过网关。
- 决策：在 `resources/app.asar` 内 `out/main/main.js` 偏移 326401940 处，将 `resolveLocalByokModelRoute` 硬编码的 `harness:"qoder-cli"` 改为 `harness:"opencode"`；只改 1 字节，asar 头与其余字节不变，不需重算索引。
- 为什么选这个：这是让对话请求落到直连引擎的最短路径；BYOK 模型键仍由数据库解码，API Key 与模型地址继续来自用户配置。
- 为什么不选其他：服务端 403 无法从客户端解除；保持 qoder-cli 等于永远不可用；重打包 asar 风险大于原地等长替换。
- 后果：必须重启千问办公后生效；若 opencode 引擎不接受该 BYOK 路由，对话会报新错误，需据日志继续修；官方升级覆盖 asar 后需重新应用。回滚：用 `resources/app.asar.orig-20261116-2` 覆盖 `resources/app.asar`。
- 验证方式：启动千问办公，用 `byok-` 模型发消息；检查 `logs/<时间>/main.log` 是否出现 `OPENCODE_*` 环境或直连端点请求，以及是否仍有 403。

### ADR-007 追记：旧会话冻结引擎
- 2026-11-16 日志显示失败会话 `6py5mw14` 带有 `frozenHarness:true`（冻结为 qoder-cli），旧会话恢复时经 `resolveFrozenHarnessRouteFromSnapshot` 解析路由，可能绕过已修改的「新会话」路径。因此验证时必须新建对话再选 BYOK 模型；若新对话成功而旧对话仍 403，属预期行为。
- 静态发现：`resolveLocalByokModelRoute` 对 `frozenHarness` 非 qoder-cli 的情况直接抛 `model_route_harness_incompatible`。若新对话成功但旧会话需要迁移，需把该拒绝改为放行，并同步修改冻结引擎传播逻辑；尚未改动。

### ADR-007 回滚记录（同日）
- 应用试制补丁后千问办公无法启动（主进程退出码 1，无错误输出）；把 `app.asar.orig-20261116-2` 拷回后应用恢复正常启动，当前 `app.asar` 与原版逐字节一致。结论：安装目录存在未识别的打包完整性校验或签名绑定，原地改 asar 不可行。
- 下一步转向：不碰 asar，改为在解包的 worker 运行时中寻找由主进程传入的 `OPENCODE_*` provider 配置注入点，或直接在 worker 内改写 BYOK 推理的 transport；若均不可行则放弃 ADR-007 路线。

## ADR-008：用本地 MITM 代理拦截 BYOK 校验请求（当前推荐）
- 日期：2026-11-16
- 状态：已实现，待主人实测
- 背景（遇到了什么问题）：ADR-007 证明 app.asar 不可改（原字节替换即无法启动），服务端 403 又无法从客户端解除。主人提出拦截外部 BYOK 网络校验请求，选择环境变量 + 本地 CA 路线。
- 决策：不碰安装目录，在项目 `proxy-src/` 放一个 node-mitmproxy 代理，对 `/algo/api/v2/byok/check` 回 `{"success":true}`、对 `/algo/api/v2/byok/config` 回 `{"providers":[]}`；其余 HTTPS 请求透明转发。`proxy-ca/ca.crt` 为自签 CA，通过 `NODE_EXTRA_CA_CERTS` 注入千问办公启动环境，代理环境变量指向 `127.0.0.1:17891`；启动脚本为 `proxy-src/launch-qwenwork.cmd`，使用说明为 `docs/specs/byok-bridge.md`。
- 为什么选这个：拦的是「校验请求」本身，不伪造账号状态、不改应用包；即使 worker 的 vkn 补丁失效，代理仍能在网络层返回成功。本地已用 curl + 本地 CA 验证两条拦截路径都返回 200 和预期 JSON，HTTPS 透明转发返回 200。
- 为什么不选其他：SNI 层劫持会误伤共用域名的正常功能；改 asar 会触发启动失败；只改 allow_byok 状态无法影响服务端推理裁决。
- 后果：必须先启动代理再用脚本启动千问办公；代理仅监听本机；对话推理请求不在拦截名单中，若服务端仍在推理链路做账号授权并检查模型白名单，则仍会 403，届时本方案无效并停止扩展。
- 何时重新审视：主人用新对话实测结果出来后；官方改变 BYOK 校验路径时。

### ADR-008 追记：启动脚本闪退修复
- 用户反馈 `launch-qwenwork.cmd` 启动后闪退。排查发现直接带同样环境变量启动 `QwenWorkCN.exe` 可以正常打开主窗口；推测是旧版脚本缺少 `setlocal EnableExtensions`、缺少 CA 文件存在性检查，或残留的旧进程与崩溃处理器干扰。
- 已更新 `proxy-src/launch-qwenwork.cmd`：启用命令扩展、验证 CA 文件存在、显式打印启动信息，并通过 `start "QwenWorkCN-BYOK"` 启动。实测脚本启动后主窗口标题为「千问办公」且保持运行。

### ADR-008 追记 2：启动脚本需要用户手动运行
- 从工具后台会话（CMD）启动的 `launch-qwenwork.cmd` 虽能拉起主进程，但后台会话结束时进程组会被回收，窗口随之消失；这不是脚本本身的闪退。用户从资源管理器双击运行时，脚本正常。
- 代理进程最近有对 `59.82.112.5:80` 的 ETIMEDOUT，说明有请求未遵循代理或目标不可达；已加异常兜底，代理继续运行。

## ADR-009：结束客户端侧绕过尝试（服务端授权不可绕）
- 日期：2026-11-16
- 状态：已被 ADR-010 取代
- 背景（遇到了什么问题）：ADR-008 的本地 CA + MITM 代理启动成功，但新建对话仍报「暂无使用权限」。最新日志显示 `sourceNamespace:"qodercli-result"`、`sourceCode:403`、`failureKind:"permission-denied"`，错误体 `You do not have access to this model service. Please check your account permissions.`。代理日志未见对 BYOK 校验接口的 INTERCEPT 记录，说明失败不来自被拦截的 check/config 接口，而是 qoder-cli 的推理结果本身。
- 决策：停止所有客户端侧绕过尝试；保留已验证有效的模型写入能力与可选代理脚本，但不继续伪造账号、改 asar、粗暴转发推理流量。
- 为什么选这个：403 是网关在推理链路上的账号/模型授权裁决，服务端可随时重验；客户端侧只能改变请求外观，不能让服务器凭空授予权限。
- 后果：千问办公中使用自有 Key 的对话仍受账号权限限制；若要使用自有 Key，应在原生 BYOK 工具中进行。
- 何时重新审视：官方为该账号开放 BYOK 或提供受支持的自定义模型权限入口。

## ADR-010：worker 内改道 + 本地模型桥，绕过网关模型授权（已实测可用）
- 日期：2026-11-16
- 状态：已实现并验证
- 背景（遇到了什么问题）：ADR-006～009 已证明服务端会在模型推理链路上对 BYOK 请求返回 403。静态分析和运行日志进一步确认：BYOK 路由固定为 `harness:"qoder-cli"`，worker 收到 `custom_model` 后仍走 legacy 网关（`sendRemoteChatAsk`），请求体由 WASM 签名/加密，无法在 MITM 层翻译成自有端点请求。
- 决策：在解包 worker 的 legacy 推理发送点加入一个分支：当请求带 `custom_model` 时，不再构造网关请求，而是从 `A.messages`、`A.custom_model.model`、`A.custom_model.parameters.api_key` 直接构造标准 OpenAI `chat/completions` 请求，发往硬编码的本机桥 `http://127.0.0.1:17895/v1/chat/completions`。桥接 `scripts/byok-model-bridge.cjs` 按模型名从 `agents.db` 查上游 URL，带原 `Authorization` 头转发，并把 SSE 流原样返回。
- 交付方式：`pnpm apply` 负责注入 BYOK 校验补丁（`vkn` 恒真、`allow_byok=2`）与桥接补丁、把桥复制到 `%LOCALAPPDATA%/byoked-qwenwork-bridge`、注册 `HKCU` 登录自启动并立即启动桥；`pnpm unapply` 负责回滚补丁、删除自启动、停止桥并清理文件。两条命令互为逆操作，不依赖外部启动环境变量或专用启动脚本。（2026-11-16 晚修订：2.1.0 主进程的 BYOK 门禁改用设备 `.env` 的 `ALLOW_CUSTOM_BYOK=1` 打开，见 ADR-012；仍然不需要外部启动环境变量。）
- 为什么选这个：只替换模型传输层，会话/提示词/流式解析仍由官方 worker 负责；不改 `app.asar`（避开完整性校验），不伪造账号或服务端策略，不依赖 MITM 证书，也不需要解密 worker 的请求体；正常入口启动即可生效。
- 为什么不选其他：改 asar 改路由会导致应用无法启动；MITM 只能拦 check/config，拦不到已加密的推理请求；强制 `allow_byok` 不影响网关裁决；opencode 直连需要改主进程连接策略，范围更大；专用启动脚本或环境变量不符合「无感」要求。
- 验证方式：用与主进程相同的 SDK 启动参数做探针，补丁后桥接收到标准 OpenAI 请求并返回真实回复；随后在不设置任何环境变量、不使用专用脚本的情况下正常启动千问办公，新建对话、选择 `Hy 4 Flash` 发送消息，界面返回真实模型回复，桥日志显示上游返回 200。`pnpm apply` 重复执行幂等；`pnpm unapply` 后桥进程停止、自启动与补丁均消失，再次 `apply` 可恢复。
- 后果：桥必须保持运行（登录自启动负责）；官方升级覆盖 worker 后需重新 `apply`；若上游不接受 Bearer 鉴权，需要扩展桥接。
- 回滚：执行 `pnpm unapply`；兜底时用 worker 同目录的 `.byoked-bridge-bak` 覆盖，并删除自启动值与本地桥目录。

## ADR-011：桥接完整支持图片与 OpenAI/Anthropic 上游
- 日期：2026-11-16
- 状态：已实现并验证
- 背景（遇到了什么问题）：ADR-010 的桥只把消息内容拍平成文本，图片、工具调用全部丢失；上游也只按 OpenAI `chat/completions` 拼接地址。客户端自带的「图片支持」开关虽然写入了 `agents.db.is_vl`，但 SDK 在 `wKl` 里只读取 `customModelOverride.isVl` 或目录项的 `is_vl`，BYOK 模型拿不到该值，图片在到达 worker 前就被替换成文字占位。
- 决策：
  1. worker 桥接分支改为保留原始 content part（`text`/`image_url`/`input_audio`）、`tool_calls`/`tool_call_id`、`tools` 与受控参数白名单，并通过 `x-byok-style`、`x-byok-upstream` 把上游协议与地址带进桥。
  2. 新增视觉保留补丁：把 `XQA` 的 `supportsVision` 改为「`l.is_vl` 为真，或存在 `custom_model` 且 `agents.db` 中该模型的 `is_vl` 为真」；数据库不可用时按支持图片处理。
  3. 桥按 `style` 选择协议：OpenAI 上游原样转发；Anthropic 上游把消息、图片、工具转换为 `/v1/messages` 请求，再把 Anthropic SSE 转换为 OpenAI chunk（文本、`reasoning_content`、`tool_calls`、`finish_reason`、`usage`），回给官方流式解析器。
- 为什么选这个：官方解析器只认 OpenAI chunk，转换放在桥里可以同时支持两类上游；视觉判定读 `agents.db`，与客户端模型编辑里的「图片支持」保持一致，不用改写 `app.asar`。
- 为什么不选其他：改 `app.asar` 会破坏完整性校验；让 worker 直连 Anthropic 需要在补丁里复制整套 SSE 解析；把图片永远当作文本会丢失多模态能力；无条件强制支持图片会让未开启图片能力的模型收到无法处理的输入。
- 验证方式：桥级测试覆盖 OpenAI 透传图片、Anthropic 请求转换（system、base64 图片、URL 图片下载、tools、tool_use/tool_result、角色合并）与 SSE 转换（文本、reasoning、tool_calls、finish_reason、usage）；worker 分支单测覆盖消息/图片/工具/参数保留与请求头。真实应用重启后附带一张金门大桥照片提问，桥日志显示 `images=8` 与 `image_url` part，界面返回了对照片内容的准确描述。
- 后果：模型编辑里未勾选「图片支持」的 BYOK 模型仍按文字占位处理；Anthropic 上游不主动开启 thinking，音频只对 OpenAI 透传；远程图片会先下载并内联（上限 10 MB）。
- 回滚：执行 `pnpm unapply`，视觉保留补丁与桥接补丁一并移除。

## ADR-012：用设备 .env 打开 2.1.0 主进程的 BYOK 门禁（已实测可用）
- 日期：2026-11-16
- 状态：已采纳
- 背景（遇到了什么问题）：`pnpm apply` 后 worker 补丁、视觉补丁、桥与自启动都正常，但千问办公里没有自定义模型请求到达桥（桥日志只有监听行）。主日志显示 `[AuthManager] Resolved BYOK access {"source":"auth_manager_cache","allowBYOK":0,"envAllowsCustomByok":false,"allowCustomBYOK":false}`，且 `agents.db.byok_custom_models` 为空。静态分析 2.1.0 的 `out/main/main.js`：`AuthStatusService` 用 `hasCustomByokEnvOverride() || (getUserStatus()?.allowBYOK ?? 0) >= 2` 决定 `allowCustomBYOK`；前者读取进程环境或设备目录 `.env` 的 `ALLOW_CUSTOM_BYOK` / `ALLOW_BYOK`。worker 里的 `vkn` 与 `allow_byok` 补丁只覆盖旧路径，无法影响主进程门禁。
- 考虑过的方案：改 `app.asar` 主进程常量；改 `.status.json` 的 `allow_byok`；在启动器里注入外部环境变量；使用应用自带设备 `.env` 的 `ALLOW_CUSTOM_BYOK=1`。
- 决策：使用设备 `.env`。`apply` 在 `%USERPROFILE%\.qwenworkcn\.env` 写入或改写 `ALLOW_CUSTOM_BYOK=1`，并把归属记入本地桥目录 `state.json`；`unapply` 只撤销本工具写入的这一行（恢复原值或删除），文件由本工具创建且删键后为空时删除文件。模型记录仍由 `byok_custom_models` 提供，桥不写模型表。
- 为什么选这个：这是应用自身支持的本地配置读取路径（`loadQoderDotEnv` + `hasCustomByokEnvOverride`），不触碰 `app.asar`（避开完整性校验），不需要专用启动脚本，`unapply` 可精确回滚；改动只有一行配置。
- 为什么不选其他：改 `app.asar` 会触发打包完整性校验（ADR-007 已验证无法启动）；`.status.json` 不是 AuthManager 的实时来源且会被覆盖；外部环境变量需要改注册表或启动器，违背“无感启动”要求。
- 后果：`apply` 会新增或修改设备 `.env` 的一行；若官方升级改名或移除该开关，门禁会失效，需要同步 `BYOK_ENV_KEY`。自定义模型设置页签仍受 profile 策略控制；本 ADR 只保证已登记的模型出现在选择器并走直连桥。
- 验证方式：写入后重启应用，主日志变为 `envAllowsCustomByok:true, allowCustomBYOK:true`；模型选择器出现 `agents.db` 中的自定义模型；发送消息后桥日志出现 `REQ model=claude-sonnet-5 ... style=anthropic upstreams=2` 与 `UPSTREAM .../v1/messages anthropic 200`，界面返回真实回复。`apply` 重复执行不重复写键；`unapply` 后 `.env` 被删除、worker 补丁/自启动/桥/本地目录全部清理；再次 `apply` 可恢复。
- 何时重新审视：官方改变 BYOK 门禁实现，或开放稳定的自定义模型管理入口。
