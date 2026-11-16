import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BS = String.fromCharCode(92);

export const BRIDGE_PORT = 17895;

const WORKER_REL = [
  'resources',
  'app.asar.unpacked',
  'node_modules',
  '@qoder-ai',
  'qoder-agent-sdk',
  'dist',
  '_worker',
  'qoder-worker-runtime.obf.mjs',
];

function installRoots() {
  const env = process.env;
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roots = [
    // 显式指定的安装根目录（可为安装根、版本目录或 resources 所在目录）。
    env.QWENWORK_INSTALL_ROOT,
    // 系统级安装：Program Files 可能因系统盘或本地化而不同，优先读环境变量。
    env.ProgramW6432 && path.join(env.ProgramW6432, 'QwenWorkCN'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'QwenWorkCN'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'QwenWorkCN'),
    // 用户级安装：Electron 应用默认的按用户安装目录。
    path.join(localAppData, 'Programs', 'QwenWorkCN'),
    path.join(localAppData, 'QwenWorkCN'),
    // 环境变量缺失时的兜底。
    'C:\\Program Files\\QwenWorkCN',
    'C:\\Program Files (x86)\\QwenWorkCN',
  ];
  const seen = new Set();
  const result = [];
  for (const root of roots) {
    if (!root) continue;
    let resolved;
    try {
      resolved = fs.realpathSync(root);
    } catch {
      continue;
    }
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

// 安装布局可能是 <根>/<版本号>/resources/...，也可能直接是 <根>/resources/...，
// 因此对每个候选目录本身及其一级子目录都检查一次。
function appDirs(root) {
  const dirs = [root];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) dirs.push(path.join(root, entry.name));
  }
  return dirs;
}

export function findWorker() {
  if (process.env.QWENWORK_WORKER_PATH) return process.env.QWENWORK_WORKER_PATH;
  const candidates = [];
  for (const root of installRoots()) {
    for (const appDir of appDirs(root)) {
      const file = path.join(appDir, ...WORKER_REL);
      let mtime;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      candidates.push({ file, mtime });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.file;
}

export function workerSearchHint() {
  if (process.env.QWENWORK_WORKER_PATH) {
    return 'QWENWORK_WORKER_PATH 指向的文件不存在：' + process.env.QWENWORK_WORKER_PATH;
  }
  const roots = installRoots();
  if (roots.length === 0) {
    return '已检查的安装目录均不存在；可用 QWENWORK_INSTALL_ROOT 指定千问办公安装根目录。';
  }
  return '已搜索：\n' + roots.map((root) => '  ' + root).join('\n');
}

export function localDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'byoked-qwenwork-bridge');
}

export function agentsDbPath() {
  if (process.env.QWENWORK_AGENTS_DB) return process.env.QWENWORK_AGENTS_DB;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'QwenWorkCN', 'data', 'agents.db');
}

export const RUN_KEY = ['HKCU','Software','Microsoft','Windows','CurrentVersion','Run'].join(BS);
export const RUN_VALUE = 'ByokedQwenWorkBridge';
