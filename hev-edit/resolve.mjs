import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  stat,
  readdir,
  realpath,
  symlink,
  copyFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export function revisionKey(job, revision) {
  if (
    !/^[a-f0-9-]{36}$/.test(job.id) ||
    !Number.isInteger(revision) ||
    revision < 1 ||
    revision > job.revision ||
    (revision === job.revision && ["queued", "editing"].includes(job.state))
  )
    throw Error("Rendered revision unavailable");
  return `${job.id}/r${revision}`;
}
export const slug = (name) =>
  String(name ?? "edit")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "edit";
export function selectExtras(used, candidates) {
  const seen = new Set(used);
  return candidates
    .filter((a) => {
      if (!a?.id || seen.has(a.id) || a.type === "IMAGE") return false;
      seen.add(a.id);
      return true;
    })
    .slice(0, 4);
}
export function bridge(cut) {
  if (!Array.isArray(cut.clips) || !cut.clips.length) throw Error("Empty cut");
  const fps = cut.fps ?? 30,
    width = cut.width ?? 1080,
    height = cut.height ?? 1920;
  if (
    !Number.isInteger(fps) ||
    fps < 1 ||
    fps > 120 ||
    ![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 8192)
  )
    throw Error("Invalid canvas or cadence");
  const captions = [
    ...(cut.titles ?? []),
    ...(cut.captions ?? []),
    ...(cut.endCards ?? []),
  ];
  // Existing Remotion layers remain separate alpha video layers. Simple text is
  // delivered as SRT rather than burning it into original camera footage.
  for (const c of [...captions, ...(cut.overlays ?? [])])
    if (
      !Number.isFinite(c.start) ||
      !Number.isFinite(c.end) ||
      c.start < 0 ||
      c.end <= c.start
    )
      throw Error("Invalid text range");
  for (const c of cut.clips) {
    if (!c.src && !c.card) throw Error("Missing source");
    if (
      !c.card &&
      (!Number.isFinite(c.in) ||
        !Number.isFinite(c.out) ||
        c.in < 0 ||
        c.out <= c.in)
    )
      throw Error("Invalid clip range");
    if (
      c.focus !== undefined &&
      (!Number.isFinite(c.focus) || c.focus < 0 || c.focus > 1)
    )
      throw Error("Invalid focus");
  }
  if (cut.music && (!cut.music.licensed || !cut.music.src))
    throw Error("Music license metadata required");
  return {
    ...cut,
    fps,
    width,
    height,
    captions: mergeText(captions),
    // Workers may describe a burned title twice: editable timed text plus a
    // Remotion-style composition descriptor, without producing an alpha MOV.
    // The matching timed text already provides the editable Resolve title.
    overlays: (cut.overlays ?? []).filter(
      (layer) =>
        !(
          layer.comp === "Title" &&
          !layer.file &&
          captions.some(
            (text) =>
              text.text === layer.props?.text &&
              text.start === layer.start &&
              text.end === layer.end,
          )
        ),
    ),
  };
}
export class ResolveQueue {
  constructor({ root, build }) {
    Object.assign(this, { root, build });
    this.jobs = new Map();
    this.requests = new Map();
  }
  file(job, rev) {
    return path.join(this.root, job.id, "resolve", `state-r${rev}.json`);
  }
  async persist(item) {
    if (item.progress?.at(-1)?.stage !== item.state)
      (item.progress ??= []).push({
        revision: item.revision,
        stage: item.state,
        message: item.message,
        at: Date.now(),
        agent: "Resolve builder",
        model: "native Python / Resolve API",
      });
    const file = this.file(item, item.revision);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file + ".tmp", JSON.stringify(item), { mode: 0o600 });
    await rename(file + ".tmp", file);
  }
  async status(job, revision) {
    const key = revisionKey(job, revision);
    if (this.jobs.has(key)) return this.jobs.get(key);
    let item;
    try {
      item = JSON.parse(await readFile(this.file(job, revision), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT")
        return { state: "idle", message: "Build an editable Resolve project" };
      throw e;
    }
    if (["queued", "building"].includes(item.state)) {
      item.state = "failed";
      item.message =
        "Resolve build interrupted; inspect artifacts before rebuilding.";
      await this.persist(item);
    }
    if (item.state === "ready") {
      try {
        await stat(item.zip);
      } catch {
        item.state = "failed";
        item.message = "Resolve archive is missing";
        await this.persist(item);
      }
    }
    this.jobs.set(key, item);
    return item;
  }
  async restore(jobs) {
    for (const job of jobs) {
      let files;
      try {
        files = await readdir(path.dirname(this.file(job, 1)));
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      for (const f of files) {
        const m = f.match(/^state-r([1-9][0-9]*)\.json$/);
        if (m) await this.status(job, Number(m[1]));
      }
    }
  }
  async request(job, revision, candidates = []) {
    const key = revisionKey(job, revision);
    if (this.requests.has(key)) return this.requests.get(key);
    const pending = (async () => {
      const existing = await this.status(job, revision);
      if (!["idle", "failed"].includes(existing.state)) return existing;
      const item = {
        id: job.id,
        revision,
        candidates,
        progress: existing.progress ?? [],
        state: "queued",
        message: "Queued for Resolve",
      };
      this.jobs.set(key, item);
      await this.persist(item);
      setImmediate(() => void this.drain());
      return item;
    })();
    this.requests.set(key, pending);
    try {
      return await pending;
    } finally {
      this.requests.delete(key);
    }
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
    for (const item of this.jobs.values()) {
      if (item.state !== "queued") continue;
      try {
        item.state = "building";
        item.message = "Building editable Resolve project";
        await this.persist(item);
        const result = await this.build(item);
        await stat(result.zip);
        Object.assign(item, result, {
          state: "ready",
          message: "Ready for Resolve",
          command: `resolve-open ${item.id} ${item.revision}`,
        });
      } catch (e) {
        item.state = "failed";
        item.error = e.message; // private persisted diagnostic, never a browser message
        item.message =
          "Resolve project could not be built. Inspect the private build log.";
      }
      await this.persist(item);
    }
  }
}
export function publicResolve(item) {
  const failure =
    "Resolve project could not be built. Inspect the private build log.";
  return {
    state: item.state,
    message: item.state === "failed" ? failure : item.message,
    command: item.command,
    progress: (item.progress ?? []).map(
      ({ revision, stage, message, at, agent, model }) => ({
        revision,
        stage,
        message: stage === "failed" ? failure : message,
        at,
        agent,
        model,
      }),
    ),
  };
}
export async function buildResolve({
  root,
  job,
  revision,
  candidates = [],
  resolveExtra,
  skill,
  run = exec,
}) {
  revisionKey(job, revision);
  const dir = path.join(root, job.id),
    out = path.join(dir, "resolve", `r${revision}`);
  let cut;
  try {
    cut = JSON.parse(
      await readFile(path.join(dir, `cut-${revision}.json`), "utf8"),
    );
  } catch (e) {
    if (e.code !== "ENOENT" || revision !== job.revision) throw e;
    cut = JSON.parse(await readFile(path.join(dir, "cut.json"), "utf8"));
    await writeFile(
      path.join(dir, `cut-${revision}.json`),
      JSON.stringify(cut),
    );
  }
  cut = bridge(cut);
  // Job identity in the name prevents replacing another job's or Adam's project.
  const name = `${slug(cut.name)}-${job.id}-r${revision}`;
  await mkdir(path.join(out, "media"), { recursive: true, mode: 0o700 });
  const base = await realpath(dir),
    copies = new Map();
  async function stage(src, external = false) {
    const source = await realpath(path.resolve(dir, src));
    if (!external && !source.startsWith(base + path.sep))
      throw Error("Source outside job");
    if (copies.has(source)) return copies.get(source);
    const rel = `media/${String(copies.size + 1).padStart(2, "0")}_${path.basename(source).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    await cloneOriginal(source, path.join(out, rel));
    copies.set(source, rel);
    return rel;
  }
  const used = [];
  for (let i = 0; i < cut.clips.length; i++) {
    const c = cut.clips[i];
    if (c.card) {
      c.src = `graphics/card-${String(i).padStart(2, "0")}-${c.card}.mov`;
      c.in = 0;
      c.out = c.seconds;
      delete c.card;
    }
    const asset = job.input.assets.find((a) => c.src.includes(a.id));
    if (asset) used.push(asset.id);
    c.src = await stage(c.src);
  }
  for (const asset of selectExtras(used, candidates))
    await stage(await resolveExtra(asset), true);
  if (cut.music) cut.music.src = await stage(cut.music.src);
  // Keep generated overlays separate and package them with the same root.
  for (let i = 0; i < cut.overlays.length; i++) {
    const layer = cut.overlays[i];
    const source =
      layer.file ?? `graphics/${String(i).padStart(2, "0")}-${layer.comp}.mov`;
    layer.file = await stage(source);
  }
  await writeFile(path.join(out, "cut.json"), JSON.stringify(cut, null, 2));
  const link = path.join(os.homedir(), "Movies", "hev-video", name);
  await mkdir(path.dirname(link), { recursive: true });
  try {
    await symlink(out, link);
  } catch (e) {
    if (e.code !== "EEXIST" || (await realpath(link)) !== (await realpath(out)))
      throw Error("Resolve media path already belongs to another folder");
  }
  const skillRoot = skill.endsWith(".md")
    ? path.resolve(path.dirname(skill), "..")
    : skill;
  const kit = path.join(skillRoot, "kit");
  const invoke = async (exe, args) =>
    run(exe, args, { cwd: out, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  await invoke("python3", [
    fileURLToPath(new URL("./resolve-fit.py", import.meta.url)),
    out,
  ]);
  await invoke("python3", [
    path.join(kit, "cut.py"),
    "timeline",
    path.join(out, "cut.json"),
    "--root",
    link,
  ]);
  await invoke("python3", [
    path.join(kit, "cut.py"),
    "srt",
    path.join(out, "cut.json"),
  ]);
  await invoke("python3", [
    fileURLToPath(new URL("./resolve-xml.py", import.meta.url)),
    out,
  ]);
  for (const f of ["timeline.fcpxml", "captions.srt"])
    await copyFile(path.join(out, "out", f), path.join(out, f));
  const drp = path.join(out, `${name}.drp`);
  // Startup and scripting have finite deadlines. Never use screen automation.
  await invoke("/usr/bin/open", ["-a", "DaVinci Resolve"]);
  try {
    await invoke("python3", [
      fileURLToPath(new URL("./resolve-project.py", import.meta.url)),
      out,
      name,
      link,
      kit,
    ]);
  } catch (e) {
    throw Error(
      e.code === 3
        ? "Resolve Studio is not reachable; enable Local scripting and start Studio"
        : String(e.stderr || e.message).slice(-700),
    );
  }
  await stat(drp);
  await writeFile(
    path.join(out, "README.txt"),
    `In Resolve: File > Import Project > ${name}.drp (or File > Import > Timeline > timeline.fcpxml)\nImport captions.srt as subtitles (includes timed titles).\nKeep this folder at ~/Movies/hev-video/${name}/ on the laptop.\n`,
  );
  const zip = path.join(dir, "resolve", `${name}.zip`);
  // --keepParent root must be the portable project name, not rN.
  await run("/usr/bin/zip", ["-q", "-r", "-0", zip + ".tmp", name], {
    cwd: path.dirname(link),
    timeout: 180000,
  });
  await rename(zip + ".tmp", zip);
  return { zip, folder: out, name, drp };
}

export async function downloadResolve(queue, job, revision, res) {
  const item = await queue.status(job, revision);
  if (item.state !== "ready") {
    res.writeHead(409).end("Resolve project is not ready");
    return;
  }
  const file = await stat(item.zip);
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Length": file.size,
    "Content-Disposition": `attachment; filename="${path.basename(item.zip)}"`,
  });
  await pipeline(createReadStream(item.zip), res);
}

export async function cloneOriginal(source, dest) {
  await copyFile(source, dest + ".tmp", constants.COPYFILE_FICLONE);
  await rename(dest + ".tmp", dest);
}

export function mergeText(captions) {
  const points = [...new Set(captions.flatMap((c) => [c.start, c.end]))].sort(
      (a, b) => a - b,
    ),
    out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i],
      end = points[i + 1],
      text = captions
        .filter((c) => c.start <= start && c.end >= end)
        .map((c) => c.text)
        .join("\n");
    if (text) out.push({ start, end, text });
  }
  return out;
}

// Resolve failures belong to the handoff, never to the rendered edit.
export async function prebuildResolve(queue, job) {
  try { await queue.request(job, job.revision); }
  catch { /* request/build failures are surfaced by Resolve status and retry */ }
}
