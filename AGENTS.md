# AGENTS.md

维护千问办公的本地 BYOK 模型桥。

## 概述
- 本项目是什么：用 `pnpm apply` 给千问办公的 worker 注入 BYOK 直连补丁、写入设备 `.env` 的 BYOK 门禁开关，并注册本地模型桥的登录自启动；`pnpm unapply` 完整回滚。

## 边界与范围
- 范围内：定位千问办公安装目录与 `agents.db`、注入与回滚 worker 补丁、维护 `%USERPROFILE%\.qwenworkcn\.env` 中的 `ALLOW_CUSTOM_BYOK` 开关、注册用户级登录自启动、在本地桥中转发 BYOK 模型请求。
- 例外授权：为让 BYOK 模型直连用户自有端点，允许修改安装目录内解包后的 `qoder-agent-sdk` worker 运行时，并注册 `HKCU` 登录自启动；允许按归属记录增删设备 `.env` 中的 `ALLOW_CUSTOM_BYOK` 键。方案与回滚见 `docs/DECISIONS.md` ADR-010～012 与 `docs/specs/module-byok-bridge.md`。改动前必须保留原始备份，官方升级覆盖后需重新执行 `pnpm apply`。
- 非目标（明确排除）：破解账号、修改 `app.asar`、伪造云端策略、Web 管理界面、多用户或远程部署。

## Agent 操作指南
- 如何理解本项目：先看 `docs/ARCHITECTURE.md` 的模块表，再看 `docs/specs/module-byok-bridge.md` 的使用与限制；实现细节以 `src/` 与 `scripts/` 源码为准。
- 全局规则 / 约定：回答与文档使用中文；`pnpm apply` 与 `pnpm unapply` 是唯一用户入口；修改补丁锚点、桥接协议、设备 `.env` 键名或目录布局时同步更新 `docs/DECISIONS.md`、`docs/specs/module-byok-bridge.md`；`apply` 内置补丁语法自检。

## 目录速查
- `src/apply.js` — 一键注入：worker 补丁、设备 `.env` 门禁、登录自启动、启动桥。
- `src/unapply.js` — 逆操作：回滚补丁、撤销门禁、移除自启动、停止桥、清理文件。
- `src/patch.js` — worker 补丁的幂等插入与回滚。
- `src/paths.js` — 安装目录、数据目录、设备 `.env` 与注册表常量。
- `scripts/byok-model-bridge.cjs` — 本地 OpenAI 兼容桥。
- `docs/` — PRD、架构、决策与使用说明。
