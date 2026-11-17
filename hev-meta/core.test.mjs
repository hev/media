import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyVocabulary,
  audioArgs,
  containerAudioCommands,
  containerPath,
  hostPath,
  parseLanguageProbability,
  parseWhisper,
  toSrt,
  toVtt,
  vocabulary,
  whisperArgs,
} from "./core.mjs";

test("maps /external originals onto the host root and refuses escapes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "meta-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "meta-out-"));
  await mkdir(path.join(root, "2026 Trip"));
  await mkdir(path.join(root, ".immich"));
  await writeFile(path.join(root, "2026 Trip", "a b.mp4"), "x");
  await writeFile(path.join(root, ".immich", "x.mp4"), "x");
  await writeFile(path.join(outside, "secret.mp4"), "x");
  await symlink(path.join(outside, "secret.mp4"), path.join(root, "link.mp4"));
  const real = await hostPath("/external/2026 Trip/a b.mp4", root);
  assert.equal(path.basename(real), "a b.mp4");
  assert.equal(await containerPath(real, root), "/external/2026 Trip/a b.mp4");
  await assert.rejects(hostPath("/upload/a.mp4", root));
  await assert.rejects(hostPath("/external/../etc/passwd", root));
  await assert.rejects(hostPath("/external/link.mp4", root), /escapes/);
  await assert.rejects(hostPath("/external/.immich/x.mp4", root), /hidden/);
  await assert.rejects(containerPath(path.join(outside, "secret.mp4"), root));
});

test("audio and whisper commands use 16 kHz mono, auto language, VAD and the prompt", () => {
  assert.deepEqual(audioArgs("/in.mp4", "/t/a.wav").slice(-9), ["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", "/t/a.wav"]);
  const args = whisperArgs({ model: "/m.bin", vadModel: "/v.bin", wav: "/t/a.wav", outBase: "/t/w", prompt: "Meghan, Data Fuel" });
  assert.deepEqual(args.slice(0, 6), ["-m", "/m.bin", "-f", "/t/a.wav", "-l", "auto"]);
  for (const flag of ["--vad", "-ojf", "-sow"]) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf("-vm") + 1], "/v.bin");
  assert.equal(args[args.indexOf("--prompt") + 1], "Meghan, Data Fuel");
  assert.ok(!whisperArgs({ model: "/m", wav: "/a", outBase: "/o" }).includes("--prompt"));
  const [docker, host] = containerAudioCommands({ context: "colima-immich", container: "immich", original: "/external/x.mp4", output: "/t/a.wav" });
  assert.deepEqual(docker[1].slice(0, 5), ["--context", "colima-immich", "exec", "immich", "nice"]);
  assert.ok(docker[1].includes("/external/x.mp4") && docker[1].at(-1) === "pipe:1");
  assert.deepEqual(host[1].slice(-2), ["-y", "/t/a.wav"]);
});

test("parses whisper JSON into cleaned second-based segments", () => {
  const json = {
    result: { language: "en" },
    transcription: [
      { offsets: { from: 1190, to: 8290 }, text: " I'm Megan with Full Send [_TT_12]" },
      { offsets: { from: 8290, to: 8290 }, text: " empty" },
      { offsets: { from: 8290, to: 14190 }, text: "  with me Adam Hevner,  who's here" },
      { offsets: { from: 15000, to: 16000 }, text: " " },
    ],
  };
  const parsed = parseWhisper(json, "Meghan, Adam Hevenor, hev mind, Full Send");
  assert.equal(parsed.language, "en");
  assert.deepEqual(parsed.segments, [
    { id: 0, start: 1.19, end: 8.29, text: "I'm Meghan with Full Send", raw: "I'm Megan with Full Send" },
    { id: 1, start: 8.29, end: 14.19, text: "with me Adam Hevenor, who's here", raw: "with me Adam Hevner, who's here" },
  ]);
  assert.deepEqual(parseLanguageProbability("whisper_full: auto-detected language: en (p = 0.999900)"), { language: "en", probability: 0.9999 });
});

test("vocabulary pass only corrects capitalized near-misses of long names", () => {
  const words = vocabulary("Meghan, Adam Hevenor, hev mind, Full Send, Data Fuel, vibe coding");
  assert.deepEqual(words, ["Meghan", "Hevenor"]);
  assert.equal(applyVocabulary("Megan said megan and Meghan; Heaven or Hevner.", words), "Meghan said megan and Meghan; Heaven or Hevenor.");
  assert.equal(applyVocabulary("Morgan", words), "Morgan");
});

test("writes VTT and SRT with correct timestamps and safe cue text", () => {
  const segments = [
    { start: 0, end: 1.5, text: "Hello" },
    { start: 3661.25, end: 3662.004, text: "a --> b\n\nc" },
  ];
  assert.equal(toVtt(segments), "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.500\nHello\n\n2\n01:01:01.250 --> 01:01:02.004\na → b\nc\n");
  assert.equal(toSrt(segments), "1\n00:00:00,000 --> 00:00:01,500\nHello\n\n2\n01:01:01,250 --> 01:01:02,004\na → b\nc\n");
});
