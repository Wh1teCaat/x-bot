/** 用假浏览器验证池位以系统命令启动，并在人工确认前保持空闲。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

/** 发送一条本地命令并读取单行响应。 */
function command(path: string, action: string): Promise<{ state: string; message: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(path); let data = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('超时')));
    socket.once('connect', () => socket.write(JSON.stringify({ action }) + '\n'));
    socket.on('data', chunk => { data += chunk; if (data.includes('\n')) { socket.end(); resolve(JSON.parse(data)); } });
    socket.once('error', reject);
  });
}

test('starts an isolated native browser and waits for explicit login confirmation', { skip: process.platform !== 'darwin', timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xbot-pool-test-'));
  const bin = join(dir, 'fake-browser'), argsFile = join(dir, 'browser-args');
  await mkdir(join(dir, '.data'), { recursive: true });
  await writeFile(bin, '#!/bin/sh\nprintf "%s\\n" "$@" > "$XBOT_TEST_BROWSER_ARGS"\nexec sleep 60\n', { mode: 0o700 });
  const script = fileURLToPath(new URL('../scripts/account/account-session.ts', import.meta.url));
  const child = spawn(process.execPath, [script, '12345', 'Alice'], { cwd: dir, env: { ...process.env, X_BROWSER_EXECUTABLE: bin, XBOT_TEST_BROWSER_ARGS: argsFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('池位启动失败'); })]);
    const socket = join(dir, '.data', 'account-sessions', '12345.sock');
    assert.equal((await command(socket, 'status')).state, 'awaiting_login');
    assert.match((await command(socket, 'run')).message, /先登录/);
    let args = '';
    for (let i = 0; i < 100 && !args; i++) {
      args = await readFile(argsFile, 'utf8').catch(() => '');
      if (!args) await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.ok(args.includes(`--user-data-dir=${join(await realpath(dir), '.data', 'browser-profiles', '12345')}`));
    assert.match(args, /--remote-debugging-port=/);
    assert.doesNotMatch(args, /--enable-automation|--remote-debugging-pipe/);
    await command(socket, 'stop');
    if (child.exitCode === null) await once(child, 'exit');
    assert.equal(child.exitCode, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit').catch(() => {}); }
    await rm(dir, { recursive: true, force: true });
  }
});
