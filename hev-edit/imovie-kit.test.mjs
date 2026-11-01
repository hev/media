import { test } from "node:test";
import assert from "node:assert/strict";
import { manifest, selectExtras, buildKit } from "./imovie-kit.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const job = {
  id: "job",
  revision: 2,
  input: { assets: [{ id: "source-b" }, { id: "source-a" }] },
};
const cut = {
  clips: [
    { src: "media/source-a.mov", in: 2, out: 5 },
    { src: "media/source-b.mp4", in: 0, out: 2 },
  ],
};
test("fixture cut manifest preserves timeline order, source IDs, ranges and handles", () => {
  const kit = manifest(cut, job, 2);
  assert.deepEqual(
    kit.clips.map((c) => [
      c.file,
      c.assetId,
      c.in,
      c.out,
      c.timeline,
      c.handles,
    ]),
    [
      ["01_source-a.mov", "source-a", 2, 5, 0, 1],
      ["02_source-b.mov", "source-b", 0, 2, 3, 1],
    ],
  );
  assert.equal(kit.project, null);
  assert.throws(() =>
    manifest({ clips: [{ src: "unknown", in: 0, out: 1 }] }, job, 2),
  );
});
test("extras prioritize unused shortlist then ranked hits and dedupe used and repeated IDs", () => {
  const a = (id) => ({ id, type: "VIDEO" });
  assert.deepEqual(
    selectExtras(
      ["cut"],
      [a("cut"), a("short"), a("short"), { id: "image", type: "IMAGE" }],
      [a("short"), a("hit"), a("cut")],
    ).map((a) => a.id),
    ["short", "hit"],
  );
});
test("cache is revision specific and rejects unavailable historical cuts and invalid revisions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kit-cache-"));
  try {
    await mkdir(path.join(root, "job"));
    await writeFile(path.join(root, "job", "imovie-kit-1.zip"), "cached-one");
    const file = await buildKit({ root, job, revision: 1 });
    assert.equal(file, path.join(root, "job", "imovie-kit-1.zip"));
    await assert.rejects(buildKit({ root, job, revision: 2 }));
    await assert.rejects(
      buildKit({ root, job, revision: 3 }),
      /Invalid revision/,
    );
    await assert.rejects(
      buildKit({ root, job: { ...job, revision: 3 }, revision: 2 }),
      /Historical cut/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ZIP build preserves ordered media ranges, source audio, titles and separate extras", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { readFile } = await import("node:fs/promises");
  const exec = promisify(execFile);
  const root = await mkdtemp(path.join(tmpdir(), "kit-media-"));
  const job = {
    id: "fixture",
    revision: 1,
    state: "rendered",
    input: { assets: [{ id: "one" }] },
  };
  const dir = path.join(root, job.id);
  try {
    await mkdir(dir);
    await exec("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=160x90:r=24:d=5",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=5",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      path.join(dir, "one.mp4"),
    ]);
    await writeFile(
      path.join(dir, "cut.json"),
      JSON.stringify({
        clips: [{ src: "one.mp4", in: 1, out: 3 }],
        captions: [{ start: 0, end: 2, text: "Fixture title" }],
      }),
    );
    const { copyFile } = await import("node:fs/promises");
    await copyFile(path.join(dir, "one.mp4"), path.join(dir, "revision-1.mp4"));
    const args = {
      root,
      job,
      revision: 1,
      candidates: ["a", "b", "c", "d"].map((id) => ({ id })),
      resolveExtra: async () => path.join(dir, "one.mp4"),
    };
    const [first, second] = await Promise.all([buildKit(args), buildKit(args)]);
    assert.equal(first, second);
    const unpack = path.join(root, "unpack");
    await mkdir(unpack);
    await exec("unzip", ["-q", first, "-d", unpack]);
    const kit = JSON.parse(
      await readFile(path.join(unpack, "kit.json"), "utf8"),
    );
    assert.deepEqual(kit.clips[0].range, {
      start: 0,
      end: 4,
      duration: 4,
      method: "encode",
    });
    assert.equal(kit.extras[0].range.method, "copy");
    assert.equal(kit.extras.length, 4);
    assert.ok(kit.extras.every((a) => a.assetId !== "one"));
    assert.equal(
      await readFile(path.join(unpack, "titles.txt"), "utf8"),
      "0–2s: Fixture title\n",
    );
    const data = JSON.parse(
      (
        await exec("ffprobe", [
          "-v",
          "error",
          "-show_format",
          "-show_streams",
          "-of",
          "json",
          path.join(unpack, kit.clips[0].file),
        ])
      ).stdout,
    );
    assert.ok(Math.abs(Number(data.format.duration) - 4) < 0.1);
    assert.equal(data.streams[0].width, 160);
    assert.equal(data.streams[0].r_frame_rate, "24/1");
    assert.ok(data.streams.some((s) => s.codec_type === "audio"));
    assert.equal(
      (await readFile(path.join(unpack, "README.txt"), "utf8"))
        .trim()
        .split("\n").length,
      4,
    );
    assert.equal(
      await buildKit({
        ...args,
        resolveExtra: async () => {
          throw Error("cache must avoid rebuild");
        },
      }),
      first,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extras use inspection ranges when present, otherwise the middle fifteen seconds", async () => {
  const { extraRange } = await import("./imovie-kit.mjs");
  assert.deepEqual(extraRange(60), { start: 22.5, end: 37.5 });
  assert.deepEqual(extraRange(60, { bestRange: { in: 4, out: 18 } }), {
    start: 4,
    end: 18,
  });
  assert.deepEqual(extraRange(6), { start: 0, end: 6 });
});
