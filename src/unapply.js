import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { removeAuxPatches, removePatch, isPatched } from './patch.js';
import { BRIDGE_PORT, BYOK_ENV_KEY, findWorker, localDir, RUN_KEY, RUN_VALUE, workerSearchHint } from './paths.js';

function checkSyntax(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  return result.status === 0 ? null : (result.stderr || '语法检查失败');
}

function stopBridge() {
  let output = '';
  try {
    output = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
  } catch {
    return;
  }
  const pids = new Set();
  for (const line of output.split(String.fromCharCode(10))) {
    const fields = line.trim().split(' ').filter(Boolean);
    if (fields.length < 5 || fields[0] !== 'TCP' || fields[3] !== 'LISTENING') continue;
    if (!fields[1].endsWith(':' + BRIDGE_PORT)) continue;
    const pid = fields[4];
    if (/^[0-9]+$/.test(pid)) pids.add(pid);
  }
  for (const pid of pids) {
    try {
      execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' });
      console.log('已停止桥接进程 PID ' + pid);
    } catch {}
  }
}

function splitLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// 只撤销 apply 自己写入或改写的那一行，保留用户 .env 中的其它内容。
function restoreByokEnv() {
  const statePath = path.join(localDir(), 'state.json');
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return;
  }
  const record = state && state.byokEnv;
  if (!record || !record.owned || !record.file) return;
  let text;
  try {
    text = fs.readFileSync(record.file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  const lines = splitLines(text);
  const pattern = new RegExp('^\\s*' + BYOK_ENV_KEY + '\\s*=');
  const index = lines.findIndex((line) => pattern.test(line));
  if (index < 0) return;
  if (record.previousLine) lines[index] = record.previousLine;
  else lines.splice(index, 1);
  const content = lines.length ? lines.join('\n') + '\n' : '';
  if (!content && record.created) {
    fs.rmSync(record.file, { force: true });
    console.log('已删除本工具创建的设备 .env：' + record.file);
  } else {
    fs.writeFileSync(record.file, content, 'utf8');
    console.log('已撤销自定义模型门禁覆盖：' + record.file);
  }
}

const worker = findWorker();
if (!worker) {
  console.error('找不到千问办公的 worker 运行时；可能未安装或安装目录已变化。\n' + workerSearchHint());
  process.exit(1);
}

const current = fs.readFileSync(worker, 'utf8');
const bridged = removePatch(current);
const aux = removeAuxPatches(bridged);
for (const warning of aux.warnings) console.warn('警告：' + warning);
const restored = aux.src;
if (restored !== current) {
  fs.writeFileSync(worker, restored);
  const syntaxError = checkSyntax(worker);
  if (syntaxError) {
    fs.writeFileSync(worker, current);
    console.error('回滚后语法检查失败，已保留补丁：' + syntaxError.slice(0, 300));
    process.exit(2);
  }
  console.log('已移除 worker 补丁：' + worker);
} else if (isPatched(current)) {
  console.error('检测到补丁但无法定位边界，未改动 worker。');
  process.exit(2);
} else {
  console.log('worker 当前没有本项目的补丁。');
}

const backup = `${worker}.byoked-bridge-bak`;
try {
  fs.rmSync(backup, { force: true });
} catch {}

try {
  execFileSync('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { stdio: 'ignore' });
  console.log('已移除登录自启动：' + RUN_VALUE);
} catch {
  console.log('登录自启动项本来就不存在。');
}

stopBridge();

try {
  restoreByokEnv();
} catch (e) {
  console.error('撤销自定义模型门禁失败：' + e.message);
}

const dir = localDir();
try {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log('已清理本地桥接文件：' + dir);
} catch (e) {
  console.error('清理本地桥接文件失败：' + e.message);
}

console.log('完成。千问办公已恢复到正常启动状态。');
