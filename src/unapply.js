import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { removeAuxPatches, removePatch, isPatched } from './patch.js';
import { BRIDGE_PORT, findWorker, localDir, RUN_KEY, RUN_VALUE, workerSearchHint } from './paths.js';

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

const dir = localDir();
try {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log('已清理本地桥接文件：' + dir);
} catch (e) {
  console.error('清理本地桥接文件失败：' + e.message);
}

console.log('完成。千问办公已恢复到正常启动状态。');
