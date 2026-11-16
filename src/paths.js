import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BS = String.fromCharCode(92);

export const BRIDGE_PORT = 17895;

export function findWorker() {
  if (process.env.QWENWORK_WORKER_PATH) return process.env.QWENWORK_WORKER_PATH;
  const roots = [
    process.env.QWENWORK_INSTALL_ROOT,
    'C:/Program Files/QwenWorkCN',
    'C:/Program Files (x86)/QwenWorkCN',
  ].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(
        root,
        entry.name,
        'resources',
        'app.asar.unpacked',
        'node_modules',
        '@qoder-ai',
        'qoder-agent-sdk',
        'dist',
        '_worker',
        'qoder-worker-runtime.obf.mjs',
      );
      if (fs.existsSync(file)) {
        candidates.push({ file, mtime: fs.statSync(file).mtimeMs });
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.file;
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
