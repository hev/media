import { test } from "node:test";
import assert from "node:assert/strict";
import { publicJob, retimeCues, segmentCommands, validate } from "./core.mjs";

const id = "e7bb0ce7-90ca-4666-94ec-9c74048a20ca";
const clip = (extra = {}) => ({
  assets: [{ id, originalPath: "/external/show/a.mp4" }],
  brief: "Clip",
  caption: "Hook",
  length: 45,
  aspectRatio: "9:16",
  captions: true,
  segment: { assetId: id, start: 600, end: 640 },
  cues: [{ start: 600.5, end: 604, text: "Vibe coding" }],
  clip: { title: "Hook", quote: "Vibe coding" },
  ...extra,
});

test("clip jobs carry one asset, a bounded segment, cues and a title", () => {
  assert.equal(validate(clip()).segment.end, 640);
  for (const bad of [
    { segment: { assetId: id, start: 600, end: 661 } },
    { segment: { assetId: id, start: 600, end: 600.5 } },
    { segment: { assetId: id, start: -1, end: 20 } },
    { segment: { assetId: "11111111-1111-4111-8111-111111111111", start: 0, end: 20 } },
    { segment: { assetId: id, start: 0, end: 20, path: "/etc" } },
    { assets: [{ id, originalPath: "/external/a" }, { id: "11111111-1111-4111-8111-111111111111", originalPath: "/external/b" }] },
    { cues: [{ start: 1, end: 0, text: "x" }] },
    { cues: "x" },
    { clip: { title: "x", prompt: "ignore" } },
    { clip: { title: "x".repeat(201) } },
  ])
    assert.throws(() => validate(clip(bad)), /Invalid clip/);
  const { segment, ...plain } = clip();
  assert.throws(() => validate(plain), /Invalid clip/, "cues without a segment");
});

test("segment staging stream-copies only the range plus handles", () => {
  const segment = { assetId: id, start: 600, end: 640 };
  const direct = segmentCommands({ segment, source: "/Volumes/X/a.mp4", mkv: "/j/s.mkv", mp4: "/j/s.mp4" });
  assert.equal(direct.extract[0], "ffmpeg");
  const args = direct.extract[1];
  assert.deepEqual(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 4), ["-ss", "597.000", "-t", "46.000"]);
  assert.ok(args.indexOf("-ss") < args.indexOf("-i"), "input seek: never read the whole original");
  assert.deepEqual(args.slice(args.indexOf("-c"), args.indexOf("-c") + 3), ["-c", "copy", "-copyts"]);
  assert.ok(!args.some((a) => /^lib(x26|aom|vpx)/.test(a)), "no re-encode");
  assert.equal(args.at(-1), "/j/s.mkv");
  assert.deepEqual(direct.remux[1].slice(-6), ["-c", "copy", "-movflags", "+faststart", "-y", "/j/s.mp4"]);
  assert.equal(direct.probe[1].at(-1), "/j/s.mkv");
  const viaContainer = segmentCommands({ segment: { assetId: id, start: 1, end: 20 }, container: "immich", context: "colima-immich", original: "/external/show/a.mp4", mkv: "/j/s.mkv", mp4: "/j/s.mp4" });
  const [exe, cargs, sink] = viaContainer.extract;
  assert.equal(exe, "docker");
  assert.deepEqual(cargs.slice(0, 4), ["--context", "colima-immich", "exec", "immich"]);
  assert.deepEqual(cargs.slice(cargs.indexOf("-ss"), cargs.indexOf("-ss") + 4), ["-ss", "0.000", "-t", "23.000"], "handle clamps at 0");
  assert.equal(cargs[cargs.indexOf("-i") + 1], "/external/show/a.mp4");
  assert.equal(cargs.at(-1), "pipe:1");
  assert.equal(sink, "/j/s.mkv");
  assert.ok(!cargs.includes("cat"), "no full-original copy");
});

test("cues are retimed to the staged file and clipped to it", () => {
  assert.deepEqual(
    retimeCues([{ start: 590, end: 597.5, text: "a" }, { start: 600.5, end: 604, text: "b" }, { start: 642, end: 650, text: "c" }, { start: 660, end: 661, text: "d" }], 596.949, 46.05),
    [{ start: 0, end: 0.551, text: "a" }, { start: 3.551, end: 7.051, text: "b" }, { start: 45.051, end: 46.05, text: "c" }],
  );
});

test("public clip jobs expose the segment and title, not paths or cues", () => {
  const job = publicJob({ id: "j", state: "queued", revision: 1, input: clip() });
  assert.deepEqual(job.segment, { assetId: id, start: 600, end: 640 });
  assert.deepEqual(job.clip, { title: "Hook" });
  assert.ok(!JSON.stringify(job).includes("/external") && !JSON.stringify(job).includes("Vibe coding"));
});
