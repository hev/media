import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { ResolveQueue, bridge, selectExtras } from "./resolve.mjs";
const job = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  revision: 2,
  state: "drafted",
};
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "resolve-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("queue coalesces, serializes revisions, caches ready and persists states", async (t) => {
  const root = await fixture(t);
  let active = 0,
    max = 0;
  const states = [];
  const q = new ResolveQueue({
    root,
    build: async (item) => {
      active++;
      max = Math.max(max, active);
      states.push(item.state);
      const zip = path.join(root, `r${item.revision}.zip`);
      await writeFile(zip, "zip");
      active--;
      return { zip };
    },
  });
  const [a, b] = await Promise.all([q.request(job, 1), q.request(job, 1)]);
  assert.equal(a, b);
  await q.request(job, 2);
  await q.drain();
  assert.equal(max, 1);
  assert.deepEqual(states, ["building", "building"]);
  assert.equal((await q.status(job, 1)).state, "ready");
  await q.request(job, 1);
  await q.drain();
  assert.equal(states.length, 2);
  const restored = new ResolveQueue({
    root,
    build: () => assert.fail("replay"),
  });
  await restored.restore([job]);
  assert.equal((await restored.status(job, 2)).state, "ready");
  assert.equal(JSON.parse(await readFile(q.file(job, 1))).state, "ready");
});
test("failed builds and interrupted queued/building builds never replay", async (t) => {
  const root = await fixture(t);
  let count = 0;
  const q = new ResolveQueue({
    root,
    build: async () => {
      count++;
      throw Error("unreachable");
    },
  });
  await q.request(job, 1);
  await q.drain();
  assert.equal((await q.status(job, 1)).state, "failed");
  await q.request(job, 1);
  assert.equal(count, 1);
  await q.persist({ ...job, revision: 2, state: "building" });
  const restored = new ResolveQueue({
    root,
    build: () => assert.fail("replay"),
  });
  await restored.restore([job]);
  assert.equal((await restored.status(job, 2)).state, "failed");
});
test("bridge preserves source ranges, canvas, framing, audio and separate text", () => {
  const cut = bridge({
    clips: [{ src: "media/a.mov", in: 1, out: 3, focus: 0.2, audio: false }],
    titles: [{ start: 0, end: 2, text: "Title" }],
    captions: [{ start: 2, end: 3, text: "Speech" }],
  });
  assert.equal(cut.width, 1080);
  assert.equal(cut.height, 1920);
  assert.equal(cut.clips[0].in, 1);
  assert.equal(cut.clips[0].focus, 0.2);
  assert.equal(cut.clips[0].audio, false);
  assert.deepEqual(
    cut.captions.map((c) => c.text),
    ["Title", "Speech"],
  );
  assert.throws(() => bridge({ clips: [{ src: "a", in: 3, out: 1 }] }));
  assert.throws(() => bridge({ ...cut, music: { src: "x" } }));
  assert.deepEqual(
    selectExtras(
      ["used"],
      [
        { id: "used" },
        { id: "a" },
        { id: "a" },
        { id: "photo", type: "IMAGE" },
        ...["b", "c", "d", "e"].map((id) => ({ id })),
      ],
    ).map((a) => a.id),
    ["a", "b", "c", "d"],
  );
});
test("resolve-open rejects invalid arguments before any network operation", () => {
  for (const args of [
    [],
    ["bad"],
    [job.id, "0"],
    [job.id, "01"],
    [job.id, "1", "extra"],
  ])
    assert.throws(
      () =>
        execFileSync(
          "sh",
          [new URL("./bin/resolve-open", import.meta.url).pathname, ...args],
          { stdio: "pipe" },
        ),
      (e) => e.status === 2,
    );
});

test("download streams ZIP bytes only for a ready revision", async (t) => {
  const { downloadResolve } = await import("./resolve.mjs");
  const { createServer } = await import("node:http");
  const root = await fixture(t),
    zip = path.join(root, "ready.zip");
  await writeFile(zip, "real zip bytes");
  let state = "building";
  const server = createServer((req, res) => {
    void downloadResolve({ status: async () => ({ state, zip }) }, job, 1, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const value of ["idle", "queued", "building", "failed"]) {
    state = value;
    assert.equal((await fetch(url)).status, 409);
  }
  state = "ready";
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.equal(await response.text(), "real zip bytes");
});

test("FCPXML bridge writes ordered rational ranges, portrait crop and separate SRT", async (t) => {
  const root = await fixture(t),
    cut = bridge({
      name: "XML fixture",
      clips: [
        {
          src: "media/a.mov",
          in: 1,
          out: 3,
          fit: "fill",
          focus: 0.8,
          audio: true,
        },
        { src: "media/b.mov", in: 2, out: 3, fit: "fit", audio: false },
      ],
      titles: [{ start: 0, end: 3, text: "Editable title" }],
    });
  await writeFile(path.join(root, "cut.json"), JSON.stringify(cut));
  const fact = {
    duration: 10,
    width: 1920,
    height: 1080,
    fps: 30,
    nominal_fps: "30",
    timecode: "01:00:00:00",
    audio: true,
    audio_rate: 48000,
  };
  await writeFile(
    path.join(root, "probe.json"),
    JSON.stringify({ "media/a.mov": fact, "media/b.mov": fact }),
  );
  const kit = process.env.HEV_EDIT_TEST_KIT ?? "/Users/hev/skills/video/kit";
  execFileSync("python3", [
    path.join(kit, "cut.py"),
    "timeline",
    path.join(root, "cut.json"),
    "--root",
    "/Users/hev/Movies/hev-video/fixture",
  ]);
  execFileSync("python3", [
    path.join(kit, "cut.py"),
    "srt",
    path.join(root, "cut.json"),
  ]);
  const xml = await readFile(path.join(root, "out/timeline.fcpxml"), "utf8");
  assert.match(xml, /width="1080" height="1920"/);
  assert.match(xml, /offset="0s" start="3601\/1s" duration="60\/30s"/);
  assert.match(xml, /offset="60\/30s" start="3602\/1s" duration="30\/30s"/);
  assert.match(xml, /adjust-transform position="-/);
  assert.match(
    xml,
    /file:\/\/\/Users\/hev\/Movies\/hev-video\/fixture\/media\/a.mov/,
  );
  assert.match(
    await readFile(path.join(root, "out/captions.srt"), "utf8"),
    /00:00:00,000 --> 00:00:03,000\nEditable title/,
  );
});
