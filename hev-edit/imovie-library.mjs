import {
  mkdir,
  readFile,
  writeFile,
  rename,
  stat,
  realpath,
  readdir,
  lstat,
  readlink,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export const validJob = (id) =>
  typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);
export function revisionKey(job, revision) {
  if (
    !validJob(job.id) ||
    !Number.isInteger(revision) ||
    revision < 1 ||
    revision > job.revision ||
    (revision === job.revision && ["queued", "editing"].includes(job.state))
  )
    throw Error("Rendered revision unavailable");
  return `${job.id}/r${revision}`;
}
export function slug(name) {
  return (
    String(name ?? "edit")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || "edit"
  );
}
export function frameFilter(clip, cut) {
  const w = cut.width ?? 1080,
    h = cut.height ?? 1920;
  if (![w, h].every((n) => Number.isInteger(n) && n > 0 && n <= 8192))
    throw Error("Invalid canvas");
  const focus = clip.focus ?? 0.5;
  if (
    !Number.isFinite(cut.fps ?? 30) ||
    (cut.fps ?? 30) <= 0 ||
    (cut.fps ?? 30) > 240
  )
    throw Error("Invalid cadence");
  if (!Number.isFinite(focus) || focus < 0 || focus > 1)
    throw Error("Invalid framing");
  const vf =
    clip.fit === "fit"
      ? `split[a][b];[a]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=40:5[bg];[b]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2`
      : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(iw-${w})*${focus}:(ih-${h})/2`;
  return vf + `,fps=${cut.fps ?? 30},setsar=1,format=yuv420p`;
}
async function checksum(file) {
  const hash = createHash("sha256");
  for await (const b of createReadStream(file)) hash.update(b);
  return hash.digest("hex");
}
export async function auditLibrary(library, expected = []) {
  const base = await realpath(library);
  let media = 0;
  const originals = new Map();
  async function walk(dir) {
    for (const name of await readdir(dir)) {
      const file = path.join(dir, name),
        info = await lstat(file);
      if (info.isSymbolicLink()) {
        const target = await realpath(file);
        if (target !== base && !target.startsWith(base + path.sep))
          throw Error("Library contains outside reference");
        // .fcpcache points to its own parent. Do not recurse through links.
        await readlink(file);
      } else if (info.isDirectory()) await walk(file);
      else if (file.includes("/Original Media/")) {
        media++;
        originals.set(name, file);
      }
    }
  }
  await walk(base);
  if (!media) throw Error("Library has no internal media");
  for (const source of expected) {
    const copied = originals.get(path.basename(source));
    if (!copied || (await checksum(copied)) !== (await checksum(source)))
      throw Error("Library media missing or does not match staged original");
  }
  return { media };
}
export class LibraryQueue {
  constructor({
    root,
    build,
    busy = async () => false,
    lock = "/tmp/hev-imovie-screen.lock",
    delay = 5000,
  }) {
    Object.assign(this, { root, build, busy, lock, delay });
    this.jobs = new Map();
    this.requests = new Map();
    this.running = false;
  }
  async persist(item) {
    const file = path.join(
      this.root,
      item.id,
      "imovie",
      `state-r${item.revision}.json`,
    );
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file + ".tmp", JSON.stringify(item), { mode: 0o600 });
    await rename(file + ".tmp", file);
  }
  async restore(jobs) {
    for (const job of jobs) {
      let files;
      try { files = await readdir(path.join(this.root,job.id,'imovie')); } catch(e) { if(e.code === 'ENOENT') continue; throw e; }
      for (const file of files) {
        const match = file.match(/^state-r([1-9][0-9]*)\.json$/);
        if (match) await this.request(job,Number(match[1]));
      }
    }
  }
  async status(job, revision) {
    const key = revisionKey(job, revision);
    if (this.jobs.has(key)) return this.jobs.get(key);
    try {
      const item = JSON.parse(
        await readFile(
          path.join(this.root, job.id, "imovie", `state-r${revision}.json`),
          "utf8",
        ),
      );
      if (item.state === "building" || (item.startedAt && ["waiting","queued"].includes(item.state))) {
        Object.assign(item, {
          state: "failed",
          message:
            "Library build interrupted. Inspect the mini before requesting a rebuild.",
        });
        this.jobs.set(key, item);
        await this.persist(item);
      }
      return item;
    } catch (e) {
      if (e.code === "ENOENT")
        return { state: "idle", message: "Build an editable iMovie library" };
      throw e;
    }
  }
  async request(job, revision, candidates = []) {
    const key = revisionKey(job, revision);
    if (this.requests.has(key)) return this.requests.get(key);
    const pending = this.enqueue(job, revision, candidates);
    this.requests.set(key, pending);
    try {
      return await pending;
    } finally {
      this.requests.delete(key);
    }
  }
  async enqueue(job, revision, candidates) {
    const key = revisionKey(job, revision);
    if (this.jobs.has(key)) return this.jobs.get(key);
    let item;
    try {
      item = JSON.parse(
        await readFile(
          path.join(this.root, job.id, "imovie", `state-r${revision}.json`),
          "utf8",
        ),
      );
      if (item.state === "ready") {
        await stat(item.zip);
        this.jobs.set(key, item);
        return item;
      }
      // An interrupted desktop operation needs inspection, never a silent replay.
      if (item.state === "building" || (item.startedAt && ["waiting","queued"].includes(item.state)))
        item = {
          ...item,
          state: "failed",
          message:
            "Library build interrupted. Inspect the mini before requesting a rebuild.",
        };
    } catch(e) {
      if(e.code !== 'ENOENT') throw e;
      item = null;
    }
    if (item && ['queued','waiting'].includes(item.state) && !item.startedAt) item.state = 'queued';
    item ??= {
      id: job.id,
      revision,
      candidates,
      state: "queued",
      message: "Queued for iMovie",
    };
    this.jobs.set(key, item);
    await this.persist(item);
    if (item.state === "queued") setImmediate(() => void this.drain());
    return item;
  }
  async drain() {
    if (this.draining) return this.draining;
    this.draining = this.work();
    try {
      await this.draining;
    } finally {
      this.draining = null;
    }
  }
  async work() {
    this.running = true;
    try {
      for (const item of this.jobs.values()) {
        if (!["queued", "waiting"].includes(item.state)) continue;
        const update = async (state, message) => {
          Object.assign(item, { state, message });
          await this.persist(item);
        };
        let locked = false;
        try {
          if (await this.busy()) {
            await update("waiting", "Waiting for the mini's screen");
            continue;
          }
          try {
            await mkdir(this.lock);
            locked = true;
          } catch (e) {
            if (e.code !== "EEXIST") throw e;
            await update("waiting", "Waiting for the mini's screen");
            continue;
          }
          item.startedAt = Date.now();
          await update("building", "Building editable iMovie library");
          const result = await this.build(item, update);
          await auditLibrary(result.library, result.expectedMedia);
          await stat(result.zip);
          Object.assign(item, result, {
            command: `imovie-open ${item.id} ${item.revision}`,
          });
          await update(
            "ready",
            "Ready in iMovie — portrait export: Share → App Preview",
          );
        } catch (e) {
          await update(
            "failed",
            `iMovie library could not be built: ${e.message}. The manual kit is available.`,
          );
        } finally {
          if (locked) await rm(this.lock, { recursive: true });
        }
      }
    } finally {
      this.running = false;
      if ([...this.jobs.values()].some((i) => i.state === "waiting")) {
        const timer = setTimeout(() => void this.drain(), this.delay);
        timer.unref?.();
      }
    }
  }
}
export async function preparePortrait({ root, job, revision, kitZip }) {
  const dir = path.join(root, job.id),
    out = path.join(dir, "imovie", `input-r${revision}`);
  await mkdir(out, { recursive: true, mode: 0o700 });
  await exec("/usr/bin/ditto", ["-x", "-k", kitZip, out]);
  const kit = JSON.parse(await readFile(path.join(out, "kit.json"), "utf8"));
  const cut = JSON.parse(
    await readFile(path.join(dir, `cut-${revision}.json`), "utf8"),
  );
  for (let i = 0; i < kit.clips.length; i++) {
    const clip = kit.clips[i],
      file = path.join(out, clip.file),
      tmp = file + ".reframe.mov";
    const source = await realpath(path.resolve(dir, cut.clips[i].src));
    if (!source.startsWith((await realpath(dir)) + path.sep))
      throw Error("Source outside job");
    await exec(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-ss",
        String(clip.range.start),
        "-i",
        source,
        "-t",
        String(clip.range.duration),
        "-vf",
        frameFilter(cut.clips[i], cut),
        "-c:v",
        "libx264",
        "-crf",
        "16",
        "-preset",
        "fast",
        "-c:a",
        "pcm_s16le",
        tmp,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    await rename(tmp, file);
  }
  await writeFile(path.join(out, "cut.json"), JSON.stringify(cut));
  return { out, kit, cut };
}
