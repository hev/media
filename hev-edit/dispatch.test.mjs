import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EditDispatch, dispatchState } from './dispatch.mjs';
const response = (state) => ({ active: state === 'running', files: { 'result.json': JSON.stringify({ end: '2026-11-14T12:00:00Z', exit_code: state === 'failed' ? 1 : 0, timeout: state === 'timeout', ...(state === 'died' ? { end: '0001-01-01T00:00:00Z' } : {}) }) } });
for (const state of ['running', 'done', 'failed', 'timeout', 'died']) test(`kit result maps ${state}`, () => assert.equal(dispatchState(response(state)), state));
test('launch order, explicit harness/model, capacity backoff and cleanup', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'edit-dispatch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [], waits = [], progress = [];
  let launches = 0;
  const adapter = new EditDispatch({ repo: 'private-scratch', exe: '/fake/hev', wait: async ms => waits.push(ms), call: async (exe, args) => {
    calls.push({ exe, args });
    if (args[1].endsWith('.md') && ++launches < 3) throw Object.assign(Error('capacity'), { stderr: 'host full (3/3)' });
    return { stdout: JSON.stringify(response('done')) };
  } });
  const job = { id: '12345678-1111-2222-3333-123456789012', revision: 2 };
  await adapter.run({ job, dir, prompt: 'Keep original prompt. final.mp4 cut.json progress-2.json', save: async () => {}, progress: async (stage) => progress.push([stage, job.state]) });
  assert.deepEqual(waits, [1000, 2000]);
  assert.deepEqual(progress.slice(0, 2), [['queued', 'queued'], ['queued', 'queued']]);
  const order = await readFile(path.join(dir, 'order-2.md'), 'utf8');
  for (const text of ['host: mini', 'repo: "private-scratch"', 'harness: codex', 'model: gpt-6.1-sol', 'timeout: 180', dir, 'Do NOT commit, push, create branches, or open a PR', 'Keep original prompt. final.mp4 cut.json progress-2.json']) assert.ok(order.includes(text), text);
  // hev dispatch rejects orders without an Acceptance section after the frontmatter.
  assert.match(order.split(/^---$/m)[2], /^## Acceptance\n- /m);
  assert.deepEqual(calls[0], { exe: '/fake/hev', args: ['dispatch', path.join(dir, 'order-2.md'), '--host', 'mini', '--json'] });
  await adapter.clean(job);
  assert.deepEqual(calls.at(-1).args, ['dispatch', 'clean', job.dispatchRun, '--host', 'mini', '--json']);
});
for (const state of ['failed', 'timeout', 'died']) test(`worker ${state} rejects without relaunch`, async () => {
  const adapter = new EditDispatch({ call: async () => ({ stdout: JSON.stringify(response(state)) }) });
  await assert.rejects(adapter.run({ job: { revision: 1, dispatchRevision: 1, dispatchRun: 'existing', dispatchLaunched: true }, save: async () => {}, progress: async () => {} }), new RegExp(state));
});
test('restart reattaches running/completed runs, rejects missing or failed runs', async () => {
  const job = { state: 'editing', revision: 1, dispatchRevision: 1, dispatchRun: 'existing' };
  for (const state of ['running', 'done', 'failed', 'timeout', 'died']) {
    const calls = [];
    const adapter = new EditDispatch({ call: async (exe, args) => { calls.push(args); return { stdout: JSON.stringify(response(state)) }; } });
    assert.equal(await adapter.recover(job), ['running', 'done'].includes(state));
    if (state === 'done') await adapter.run({ job: { ...job, dispatchLaunched: true }, save: async () => {}, progress: async () => {} });
    assert.ok(calls.every(args => args[1] === 'show'));
  }
  assert.equal(await new EditDispatch({ call: async () => { throw Error('gone'); } }).recover(job), false);
});
test('queue records dispatch failures with a plain note and dispatch identity', async () => {
  const { Queue } = await import('./core.mjs');
  for (const state of ['failed', 'timeout']) {
    const job = { id: state, state: 'queued', revision: 1, dispatchRevision: 1, dispatchRun: `edit-${state}`, dispatchLaunched: true };
    const adapter = new EditDispatch({ call: async () => ({ stdout: JSON.stringify(response(state)) }) });
    const queue = new Queue(async job => adapter.run({ job, save: async () => {}, progress: async () => {} }));
    queue.jobs.set(job.id, job);
    await queue.drain();
    assert.equal(job.state, 'failed');
    assert.equal(job.note, 'Edit failed; inspect the private job log before retrying');
    assert.equal(job.progress.at(-1).dispatchRun, job.dispatchRun);
  }
});
