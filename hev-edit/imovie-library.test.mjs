import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LibraryQueue,
  auditLibrary,
  frameFilter,
  revisionKey,
} from "./imovie-library.mjs";
const job = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  revision: 2,
  state: "rendered",
};
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "imovie-queue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = path.join(root, "test.imovielibrary");
  await mkdir(path.join(library, "event", "Original Media"), {
    recursive: true,
  });
  await writeFile(
    path.join(library, "event", "Original Media", "clip.mov"),
    "fixture",
  );
  const zip = library + ".zip";
  await writeFile(zip, "fixture");
  return { root, library, zip, lock: path.join(root, "lock") };
}
test("coalesces requests, serializes desktop builds, caches each revision and persists ready", async (t) => {
  const f = await fixture(t);
  let active = 0,
    max = 0,
    calls = 0;
  const q = new LibraryQueue({
    ...f,
    build: async () => {
      calls++;
      active++;
      max = Math.max(active, max);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return f;
    },
  });
  const states = await Promise.all([
    q.request(job, 1),
    q.request(job, 1),
    q.request(job, 2),
  ]);
  assert.equal(states[0], states[1]);
  await q.drain();
  assert.equal(calls, 2);
  assert.equal(max, 1);
  assert.equal((await q.request(job, 1)).state, "ready");
  const fresh = new LibraryQueue({
    ...f,
    build: () => assert.fail("cached build replayed"),
  });
  assert.equal((await fresh.request(job, 1)).state, "ready");
  assert.equal(
    JSON.parse(
      await readFile(path.join(f.root, job.id, "imovie/state-r1.json")),
    ).state,
    "ready",
  );
});
test("busy desktop and external lock wait without running a builder", async (t) => {
  const f = await fixture(t);
  let busy = true,
    calls = 0;
  const q = new LibraryQueue({
    ...f,
    delay: 60000,
    busy: async () => busy,
    build: async () => {
      calls++;
      return f;
    },
  });
  await q.request(job, 1);
  await q.drain();
  assert.equal((await q.status(job, 1)).state, "waiting");
  assert.equal(calls, 0);
  busy = false;
  await mkdir(f.lock);
  await q.drain();
  assert.equal(calls, 0);
  await rm(f.lock, { recursive: true });
  await q.drain();
  assert.equal(calls, 1);
  assert.equal((await q.status(job, 1)).state, "ready");
});
test("build failure releases lock, remains failed and never retries automatically", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const q = new LibraryQueue({
    ...f,
    build: async () => {
      calls++;
      throw Error("dialog blocked");
    },
  });
  await q.request(job, 1);
  await q.drain();
  assert.equal((await q.request(job, 1)).state, "failed");
  await q.drain();
  assert.equal(calls, 1);
  await mkdir(f.lock);
  await rm(f.lock, { recursive: true });
});
test("restart does not replay an interrupted native operation; GET is inert", async (t) => {
  const f = await fixture(t);
  const folder = path.join(f.root, job.id, "imovie");
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, "state-r1.json"),
    JSON.stringify({ id: job.id, revision: 1, state: "building" }),
  );
  const q = new LibraryQueue({
    ...f,
    build: () => assert.fail("interrupted operation replayed"),
  });
  assert.equal((await q.status(job, 2)).state, "idle");
  assert.equal(q.jobs.size, 0);
  assert.equal((await q.request(job, 1)).state, "failed");
});
test("library audit rejects escaping media links and permits internal cache link", async (t) => {
  const f = await fixture(t);
  await symlink(".", path.join(f.library, ".fcpcache"));
  assert.equal((await auditLibrary(f.library)).media, 1);
  await symlink("/tmp", path.join(f.library, "outside"));
  await assert.rejects(auditLibrary(f.library), /outside reference/);
});
test("revision and framing validation preserve fit/focus and reject invalid values", () => {
  assert.throws(() => revisionKey(job, 3));
  assert.throws(() => revisionKey({ ...job, id: "../../x" }, 1));
  assert.throws(() => revisionKey({ ...job, state: "editing" }, 2));
  assert.match(
    frameFilter(
      { fit: "fill", focus: 0.8 },
      { width: 1080, height: 1920, fps: 30 },
    ),
    /\(iw-1080\)\*0.8/,
  );
  assert.match(
    frameFilter({ fit: "fit" }, { width: 1080, height: 1920 }),
    /boxblur=40:5/,
  );
  assert.throws(() => frameFilter({ focus: 2 }, {}));
});


test('desktop release is bound to exact peer process and expiry',async()=>{
 const {screenBusy,released}=await import('./imovie-screen.mjs');
 const peer={agent_pid:123,agent_started:456,state:'working',role:'boh'};
 const lease={pid:123,started:456,until:Date.now()+60000};
 assert.equal(await screenBusy({panes:[peer]},async()=>lease),false);
 assert.equal(await screenBusy({panes:[peer]},async()=>({...lease,started:455})),true);
 assert.equal(released(peer,{...lease,until:Date.now()-1}),false);
 assert.equal(released(peer,{...lease,until:Date.now()+3600000}),false);
 assert.equal(await screenBusy({panes:[peer]},async()=>{throw Error('unavailable')}),true);
});

test('restart resumes queued work before desktop entry but preserves ready cache',async t=>{
 const f=await fixture(t);const folder=path.join(f.root,job.id,'imovie');await mkdir(folder,{recursive:true});
 await writeFile(path.join(folder,'state-r1.json'),JSON.stringify({id:job.id,revision:1,state:'waiting'}));
 let calls=0;const q=new LibraryQueue({...f,build:async()=>{calls++;return f;}});
 await q.restore([job]);await q.drain();assert.equal(calls,1);
 const fresh=new LibraryQueue({...f,build:()=>assert.fail('ready replayed')});
 assert.equal((await fresh.status(job,1)).state,'ready');
});
