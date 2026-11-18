import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { processSnapshot, stopProcessTree } from '../src/process-stop.ts';

test('stop removes a task and its stubborn descendant without stopping other tasks', async () => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const root = spawn(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e', 'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000)']);
    child.stdout.once('data',()=>console.log(child.pid));
    setInterval(()=>{},1000);
  `]);
  let descendant = 0;
  try {
    const [data] = await once(root.stdout!, 'data');
    descendant = Number(String(data).trim());
    assert.ok(descendant > 0);
    await stopProcessTree(root.pid!);
    const rows = processSnapshot();
    assert.equal(rows.some(r => r.pid === root.pid), false);
    assert.equal(rows.some(r => r.pid === unrelated.pid), true);
    // SIGKILL delivery/reaping can complete just after the signal is sent.
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(processSnapshot().some(r => r.pid === descendant && !r.command.includes('defunct')), false);
  } finally { unrelated.kill('SIGKILL'); root.kill('SIGKILL'); if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} } }
});
