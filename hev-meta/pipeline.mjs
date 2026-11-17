// One asset: extract 16 kHz mono audio to internal disk, run whisper.cpp at
// background priority, write transcript files, index, delete the audio.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  audioArgs,
  containerAudioCommands,
  hostPath,
  parseLanguageProbability,
  parseWhisper,
  toSrt,
  toVtt,
  whisperArgs,
} from "./core.mjs";

export function config(env = process.env) {
  const home = env.HOME ?? "";
  return {
    data: env.HEV_META_DATA ?? path.join(home, ".local/share/hev-meta"),
    transcripts: env.HEV_META_TRANSCRIPTS ?? "/Volumes/EXTERNAL/.immich/hev-meta/transcripts",
    external: env.HEV_META_EXTERNAL_ROOT ?? "/Volumes/EXTERNAL",
    container: env.HEV_META_SOURCE_CONTAINER || undefined,
    context: env.HEV_META_DOCKER_CONTEXT ?? "default",
    immich: env.HEV_META_IMMICH_URL ?? "http://127.0.0.1:2283/api",
    apiKey: env.HEV_META_IMMICH_API_KEY || undefined,
    whisper: env.HEV_META_WHISPER ?? "whisper-cli",
    model: env.HEV_META_MODEL ?? path.join(home, "video/models/ggml-large-v3-turbo.bin"),
    vadModel: env.HEV_META_VAD_MODEL ?? path.join(home, "video/models/ggml-silero-v5.1.2.bin"),
    threads: Number(env.HEV_META_THREADS ?? 4),
    tmp: env.HEV_META_TMP ?? tmpdir(),
    port: Number(env.HEV_META_PORT ?? 2292),
    bind: env.HEV_META_BIND ?? "127.0.0.1",
    poll: Number(env.HEV_META_POLL ?? 0),
  };
}

// Background QoS on macOS: low CPU/IO priority so editing on the mini wins.
const background = (exe, args) => (process.platform === "darwin" ? ["taskpolicy", ["-b", exe, ...args]] : [exe, args]);

export function run(exe, args, { stdin, collect = false } = {}) {
  const [cmd, argv] = background(exe, args);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    let out = "",
      err = "";
    child.stdout.on("data", (b) => {
      if (collect) out += b;
    });
    child.stderr.on("data", (b) => {
      err = (err + b).slice(-20000);
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve({ out, err }) : reject(Error(`${exe} exited ${code}: ${err.slice(-400)}`))));
    if (stdin) stdin(child.stdin);
  });
}

async function extract(job, cfg, wav) {
  if (cfg.container) {
    const [[dexe, dargs], [fexe, fargs]] = containerAudioCommands({
      context: cfg.context,
      container: cfg.container,
      original: job.original_path,
      output: wav,
    });
    const source = spawn(dexe, dargs, { stdio: ["ignore", "pipe", "pipe"] });
    source.stderr.resume();
    const exited = new Promise((resolve, reject) => {
      source.on("error", reject);
      source.on("close", (code) => (code === 0 ? resolve() : reject(Error("Container audio extraction failed"))));
    });
    await Promise.all([run(fexe, fargs, { stdin: (sink) => source.stdout.pipe(sink) }), exited]);
    return;
  }
  await run("ffmpeg", audioArgs(await hostPath(job.original_path, cfg.external), wav));
}

export async function engineVersion(cfg) {
  try {
    const { out, err } = await run(cfg.whisper, ["--version"], { collect: true });
    return `whisper.cpp ${(out + err).match(/version:?\s*([\d.]+)/)?.[1] ?? "unknown"}`;
  } catch {
    return "whisper.cpp unknown";
  }
}

async function atomic(file, text) {
  await writeFile(file + ".tmp", text, { mode: 0o644 });
  await rename(file + ".tmp", file);
}

export async function transcribe(job, cfg, store, log = console.log) {
  const started = Date.now();
  const temp = await mkdtemp(path.join(cfg.tmp, "hev-meta-"));
  try {
    const wav = path.join(temp, "audio.wav");
    log(`hev-meta: job ${job.id} asset ${job.asset_id}: extracting audio`);
    await extract(job, cfg, wav);
    const duration = ((await stat(wav)).size - 44) / 32000;
    log(`hev-meta: job ${job.id}: ${duration.toFixed(1)} s of audio; running whisper`);
    const outBase = path.join(temp, "whisper");
    const { err } = await run(
      cfg.whisper,
      whisperArgs({ model: cfg.model, vadModel: cfg.vadModel, wav, outBase, prompt: job.prompt, threads: cfg.threads }),
    );
    const parsed = parseWhisper(JSON.parse(await readFile(outBase + ".json", "utf8")), job.prompt);
    const transcript = {
      version: 1,
      assetId: job.asset_id,
      checksum: job.checksum,
      language: parsed.language,
      languageProbability: parseLanguageProbability(err)?.probability,
      model: path.basename(cfg.model, ".bin").replace(/^ggml-/, ""),
      vad: cfg.vadModel ? path.basename(cfg.vadModel, ".bin").replace(/^ggml-/, "") : undefined,
      engine: await engineVersion(cfg),
      prompt: job.prompt || "",
      duration: Math.round(duration * 1000) / 1000,
      createdAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      segments: parsed.segments,
    };
    const dir = path.join(cfg.transcripts, job.asset_id);
    await mkdir(dir, { recursive: true });
    await atomic(path.join(dir, "transcript.vtt"), toVtt(transcript.segments));
    await atomic(path.join(dir, "transcript.srt"), toSrt(transcript.segments));
    await atomic(path.join(dir, "transcript.json"), JSON.stringify(transcript, null, 2));
    store.finish(job.id, transcript, dir);
    log(
      `hev-meta: job ${job.id} asset ${job.asset_id}: done, ${transcript.segments.length} segments, language ${transcript.language}, ${((Date.now() - started) / 1000).toFixed(1)} s wall`,
    );
    return transcript;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

