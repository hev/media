import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
const pause = ms => new Promise(r => setTimeout(r, ms));
test('HTTP queue through fake hev dispatch/poll/render and restart reattach', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'edit-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const root = path.join(dir, 'jobs');
  await mkdir(bin); await mkdir(root);
  await writeFile(path.join(dir, 'original.mp4'), 'original');
  const fake = path.join(bin, 'hev');
  await writeFile(fake, `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls'))}, JSON.stringify(args)+'\\n');
if(args[1].endsWith('.md')) {
 fs.writeFileSync(path.join(process.cwd(),'cut.json'), JSON.stringify({width:1080,height:1920,clips:[{src:${JSON.stringify(path.join(dir, 'original.mp4'))},in:0,out:1}]}));
 fs.writeFileSync(path.join(process.cwd(),'final.mp4'),'fake video');
 console.log('launched');
} else if(args[1]==='show') {
 const countFile=${JSON.stringify(path.join(dir, 'polls'))}; let count=fs.existsSync(countFile)?Number(fs.readFileSync(countFile)):0; fs.writeFileSync(countFile,String(count+1));
 console.log(JSON.stringify({active:count<2,files:{'result.json':JSON.stringify({end:'2026-11-14T12:00:00Z',exit_code:0})}}));
} else console.log('{}');
`, { mode: 0o700 });
  await writeFile(path.join(bin, 'ffprobe'), `#!${process.execPath}\nconsole.log(JSON.stringify({streams:[{width:1080,height:1920}],format:{duration:'1'}}));`, { mode: 0o700 });
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(r => socket.close(r));
  let child, logs = '';
  const start = () => {
    child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('.', import.meta.url), env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HEV_EDIT_DISPATCH: fake, HEV_EDIT_ROOT: root, HEV_EDIT_EXTERNAL_ROOT: dir, HEV_EDIT_PROMO_SCRIPTS: dir, HEV_EDIT_VIDEO_SKILL: '/fake/video/SKILL.md', HEV_EDIT_SECRET: 'test', HEV_EDIT_PORT: String(port) } });
    child.stderr.on('data', b => logs += b);
  };
  const stop = async () => { if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } };
  t.after(stop);
  const request = async (route, options = {}) => fetch(`http://127.0.0.1:${port}${route}`, { ...options, headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' } });
  const until = async fn => { for (let i=0;i<150;i++) { const result = await fn(); if(result) return result; await pause(50); } assert.fail(`condition timed out: ${logs}`); };
  start();
  await until(async () => { try { return (await request('/jobs')).ok; } catch { return false; } });
  const res = await request('/jobs', { method: 'POST', body: JSON.stringify({ assets:[{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',originalPath:'/external/original.mp4'}], brief:'Test', caption:'Test', length:1 }) });
  assert.equal(res.status, 201); const job = await res.json();
  await until(async () => { try { return JSON.parse(await readFile(path.join(root, job.id, 'job.json'))).dispatchLaunched; } catch { return false; } });
  await stop(); start();
  const rendered = await until(async () => { try { const j = await (await request(`/jobs/${job.id}`)).json(); assert.notEqual(j.state, 'failed', logs); return j.state === 'rendered' && j; } catch (e) { if (e.code === 'ERR_ASSERTION') throw e; return false; } });
  assert.equal(rendered.duration, 1);
  assert.ok(rendered.progress.some(p => p.dispatchRun));
  assert.equal(await (await request(`/jobs/${job.id}/preview`)).text(), 'fake video');
  const calls = (await readFile(path.join(dir, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(a => a[1].endsWith('.md')).length, 1);
  assert.ok(calls.filter(a => a[1] === 'show').length >= 3);
  assert.ok(calls.some(a => a[1] === 'clean'));
});
