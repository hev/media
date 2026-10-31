import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  authorized,
  originalPath,
  validate,
  transition,
  Queue,
  publicJob,
  publishRevision,
} from "./core.mjs";
test("launcher requires exact nonempty shared secret", () => {
  assert.equal(authorized(undefined, "x"), false);
  assert.equal(authorized("Bearer x", ""), false);
  assert.equal(authorized("Bearer wrong", "x"), false);
  assert.equal(authorized("Bearer x", "x"), true);
});
test("mapping rejects non-external paths, traversal, and symlink escapes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hev-edit-"));
  try {
    await mkdir(path.join(root, "external"));
    await writeFile(path.join(root, "outside"), "x");
    await writeFile(path.join(root, "external", "video"), "x");
    await symlink(
      path.join(root, "outside"),
      path.join(root, "external", "escape"),
    );
    assert.equal(
      await originalPath("/external/video", path.join(root, "external")),
      await realpath(path.join(root, "external", "video")),
    );
    for (const name of [
      "/upload/video",
      "/external/../outside",
      "/external/escape",
      "/externality/video",
    ])
      await assert.rejects(originalPath(name, path.join(root, "external")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("brief limits and unexpected properties rejected", () => {
  const input = {
    assets: [
      {
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        originalPath: "/external/x",
      },
    ],
    brief: "Reel",
    caption: "Dogs",
    length: 30,
  };
  assert.equal(validate(input), input);
  for (const change of [
    { length: 61 },
    { length: 0 },
    { assets: [] },
    { publish: true },
    { brief: "" },
  ])
    assert.throws(() => validate({ ...input, ...change }));
});
test("state machine refuses skipped states and terminal transitions", () => {
  const job = { state: "queued" };
  assert.throws(() => transition(job, "drafted", "bad"));
  for (const state of ["editing", "rendered", "uploading", "drafted"])
    transition(job, state, state);
  assert.throws(() => transition(job, "editing", "bad"));
  assert.equal(
    publicJob({ ...job, input: { secret: "hidden" } }).input,
    undefined,
  );
});
test("queue serializes workers and records failure without dropping subsequent jobs", async () => {
  let running = 0,
    max = 0;
  let finish;
  const done = new Promise((r) => (finish = r));
  let count = 0;
  const queue = new Queue(async (job, update) => {
    running++;
    max = Math.max(max, running);
    await new Promise((r) => setTimeout(r, 10));
    running--;
    count++;
    if (count === 1) throw Error("worker failed");
    await update("rendered", "ok");
    await update("uploading", "ok");
    await update("drafted", "ok");
    finish();
  });
  const first = await queue.add({});
  const second = await queue.add({});
  await done;
  assert.equal(max, 1);
  assert.equal(first.state, "failed");
  assert.equal(second.state, "drafted");
});

test("publish creates only the selected revision draft and repeated clicks are idempotent", async () => {
  const job = {
    revision: 2,
    state: "uploading",
    revisions: [
      { revision: 1, mediaUrl: "one" },
      { revision: 2, mediaUrl: "two" },
    ],
  };
  let calls = 0;
  let saved = 0;
  const draft = async (r) => {
    calls++;
    assert.equal(r.mediaUrl, "two");
    return "https://buffer/draft";
  };
  assert.equal(calls, 0);
  await publishRevision(job, 2, async () => saved++, draft);
  await publishRevision(job, 2, async () => saved++, draft);
  assert.equal(calls, 1);
  assert.equal(saved, 2);
  assert.equal(job.revisions[0].bufferUrl, undefined);
  assert.equal(job.state, "drafted");
  await assert.rejects(publishRevision(job, 3, async () => {}, draft));
});
test("ambiguous publish failure cannot silently create another draft", async () => {
  const job = { revision: 1, revisions: [{ revision: 1 }] };
  let calls = 0;
  const draft = async () => {
    calls++;
    throw Error("network interrupted");
  };
  await assert.rejects(publishRevision(job, 1, async () => {}, draft));
  await assert.rejects(publishRevision(job, 1, async () => {}, draft));
  assert.equal(calls, 1);
});
