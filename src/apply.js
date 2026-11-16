import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { applyAuxPatches, applyPatch } from './patch.js';
import { BRIDGE_PORT, BYOK_ENV_KEY, deviceEnvPath, findWorker, localDir, RUN_KEY, RUN_VALUE, workerSearchHint } from './paths.js';

function checkSyntax(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  return result.status === 0 ? null : (result.stderr || '语法检查失败');
}

function probe(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(400);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitForPort(port, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    if (await probe(port)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function warnPersistentCliOverride() {
  const hives = [['HKCU', 'Environment'], ['HKLM', 'SYSTEM', 'CurrentControlSet', 'Control', 'Session Manager', 'Environment']]
    .map((parts) => parts.join(String.fromCharCode(92)));
  for (const hive of hives) {
    try {
      const out = execFileSync('reg', ['query', hive, '/v', 'QODER_CLI_PATH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (out.trim()) {
        console.warn('警告：' + hive + ' 中设置了 QODER_CLI_PATH，正常启动会绕过补丁；请先删除该变量。');
      }
    } catch {}
  }
}

function warnIfAppRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq QwenWorkCN.exe', '/NH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (out.includes('QwenWorkCN.exe')) {
      console.log('提示：千问办公正在运行，重启一次应用后新补丁才会生效。');
    }
  } catch {}
}

function splitLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function envLineValue(line) {
  const raw = line.slice(line.indexOf('=') + 1).trim();
  const unquoted = raw.replace(/^(['"])(.*)\1$/, '$2');
  const comment = unquoted.indexOf(' #');
  return (comment >= 0 ? unquoted.slice(0, comment) : unquoted).trim();
}

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(value);
}

// 2.1.0 的 BYOK 门禁在 app.asar 主进程里：allowCustomBYOK =
// 环境变量 ALLOW_CUSTOM_BYOK 为真，或账号 allow_byok >= 2。
// 应用启动时会读取设备目录的 .env，因此在这里写入该键，不改 app.asar。
function enableByokEnv() {
  const file = deviceEnvPath();
  let existing = null;
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const created = existing === null;
  const lines = splitLines(existing ?? '');
  const index = lines.findIndex((line) => /^\s*ALLOW_CUSTOM_BYOK\s*=/.test(line));
  let previousLine = null;
  let changed = false;
  if (index >= 0) {
    if (!isTruthyEnv(envLineValue(lines[index]))) {
      previousLine = lines[index];
      lines[index] = `${BYOK_ENV_KEY}=1`;
      changed = true;
    }
  } else {
    lines.push(`${BYOK_ENV_KEY}=1`);
    changed = true;
  }
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    console.log('已启用自定义模型门禁：' + file + '（' + BYOK_ENV_KEY + '=1）');
  } else {
    console.log('自定义模型门禁已开启：' + file);
  }
  return { file, owned: changed, created, previousLine };
}

// 记录本工具写入的 .env 键，unapply 时只撤销自己负责的部分。
function saveEnvState(dir, byokEnv) {
  const file = path.join(dir, 'state.json');
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {}
  const prior = state.byokEnv;
  state.byokEnv = byokEnv.owned
    ? byokEnv
    : prior && prior.file === byokEnv.file && prior.owned
      ? prior
      : { file: byokEnv.file, owned: false };
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

const worker = findWorker();
if (!worker) {
  console.error('找不到千问办公的 worker 运行时；请确认已安装千问办公。\n' + workerSearchHint());
  process.exit(1);
}

const original = fs.readFileSync(worker, 'utf8');
const bridge = applyPatch(original);
const aux = applyAuxPatches(bridge);
for (const warning of aux.warnings) console.warn('警告：' + warning);
const patched = aux.src;
if (patched !== original) {
  const backup = `${worker}.byoked-bridge-bak`;
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, original);
  fs.writeFileSync(worker, patched);
  const syntaxError = checkSyntax(worker);
  if (syntaxError) {
    fs.writeFileSync(worker, original);
    console.error('补丁后语法检查失败，已回滚：' + syntaxError.slice(0, 300));
    process.exit(2);
  }
  console.log('已注入 worker 补丁：' + worker);
} else {
  console.log('worker 补丁已是最新：' + worker);
}

const dir = localDir();
fs.mkdirSync(dir, { recursive: true });
const byokEnv = enableByokEnv();
saveEnvState(dir, byokEnv);
const bridgeSource = new URL('../scripts/byok-model-bridge.cjs', import.meta.url);
const bridgeTarget = path.join(dir, 'byok-model-bridge.cjs');
fs.copyFileSync(bridgeSource, bridgeTarget);

const vbs = path.join(dir, 'start-bridge.vbs');
const nodeExe = process.execPath;
const vbsContent = [
  'Set sh = CreateObject("WScript.Shell")',
  `sh.Run """${nodeExe}"" ""${bridgeTarget}""", 0, False`,
  '',
].join('\r\n');
fs.writeFileSync(vbs, vbsContent, 'utf8');

const runValue = `wscript.exe //B "${vbs}"`;
execFileSync('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', runValue, '/f'], { stdio: 'ignore' });
console.log('已注册登录自启动：' + RUN_VALUE);

if (!(await probe(BRIDGE_PORT))) {
  const child = spawn('wscript.exe', ['//B', vbs], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  if (!(await waitForPort(BRIDGE_PORT))) {
    console.error('桥接未能在 127.0.0.1:' + BRIDGE_PORT + ' 启动，请查看 ' + path.join(dir, 'byok-model-bridge.log'));
    process.exit(3);
  }
  console.log('桥接已启动：http://127.0.0.1:' + BRIDGE_PORT);
} else {
  console.log('桥接已在运行：http://127.0.0.1:' + BRIDGE_PORT);
}

warnPersistentCliOverride();
warnIfAppRunning();
console.log('完成。现在从任意入口正常启动千问办公即可使用 BYOK 模型。');
