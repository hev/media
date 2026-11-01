import {
  readFile,
  writeFile,
  mkdir,
  stat,
  rename,
  rm,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
const exec = promisify(execFile);
const builds = new Map();
export function selectExtras(cutIds, shortlist, hits = []) {
  const seen = new Set(cutIds);
  return [...shortlist, ...hits]
    .filter((a) => {
      if (!a?.id || seen.has(a.id) || a.type === "IMAGE") return false;
      seen.add(a.id);
      return true;
    })
    .slice(0, 4);
}
export function manifest(cut, job, revision) {
  let time = 0;
  const clips = cut.clips.map((original, i) => {
    const c = original.card
      ? {
          ...original,
          src: `graphics/card-${String(i).padStart(2, "0")}-${original.card}.mov`,
          in: 0,
          out: original.seconds,
        }
      : original;
    if (
      !c.src ||
      !Number.isFinite(c.in) ||
      !Number.isFinite(c.out) ||
      c.in < 0 ||
      c.out <= c.in
    )
      throw Error("Invalid cut");
    const id = job.input.assets.find((a) => c.src.includes(a.id))?.id;
    if (!id && !c.card) throw Error("Cut source not in job");
    const clip = {
      file: `${String(i + 1).padStart(2, "0")}_${id?.slice(0, 8) ?? "card"}.mov`,
      assetId: id ?? null,
      source: c.src,
      in: c.in,
      out: c.out,
      timeline: time,
      handles: 1,
    };
    time += c.out - c.in;
    return clip;
  });
  return {
    version: 1,
    job: job.id,
    revision,
    clips,
    extras: [],
    project: null,
  };
}
export function extraRange(duration, inspected) {
  const preferred = inspected?.bestRange ?? inspected;
  const at = preferred?.in ?? preferred?.start;
  const end = preferred?.out ?? preferred?.end;
  if (Number.isFinite(at) && Number.isFinite(end) && end > at)
    return {
      start: Math.max(0, Math.min(at, duration - Math.min(15, duration))),
      end: Math.min(duration, Math.max(at + 10, Math.min(end, at + 20))),
    };
  const start = Math.max(0, (duration - 15) / 2);
  return { start, end: Math.min(duration, start + 15) };
}
async function confined(dir, file) {
  const base = await realpath(dir),
    target = await realpath(path.resolve(dir, file));
  if (!target.startsWith(base + path.sep)) throw Error("Source outside job");
  return target;
}
async function probe(file) {
  return JSON.parse(
    (
      await exec("ffprobe", [
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        file,
      ])
    ).stdout,
  );
}
async function trim(source, dest, start, end) {
  const info = await probe(source);
  const duration = Number(info.format.duration);
  start = Math.max(0, start);
  end = Math.min(duration, end);
  if (!(end > start)) throw Error("Source range unavailable");
  const frames =
    JSON.parse(
      (
        await exec(
          "ffprobe",
          [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-skip_frame",
            "nokey",
            "-read_intervals",
            `${Math.max(0, start - 2)}%${end + 0.1}`,
            "-show_frames",
            "-show_entries",
            "frame=best_effort_timestamp_time",
            "-of",
            "json",
            source,
          ],
          { maxBuffer: 4 * 1024 * 1024 },
        )
      ).stdout,
    ).frames ?? [];
  const aligned = (t) =>
    frames.some(
      (f) => Math.abs(Number(f.best_effort_timestamp_time) - t) < 0.001,
    );
  if (
    aligned(start) &&
    (aligned(end) || Math.abs(end - duration) < 0.001) &&
    ["h264", "hevc", "prores"].includes(
      info.streams.find((s) => s.codec_type === "video")?.codec_name,
    )
  ) {
    await exec("ffmpeg", [
      "-v",
      "error",
      "-nostdin",
      "-ss",
      String(start),
      "-i",
      source,
      "-t",
      String(end - start),
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      dest,
    ]);
    return { start, end, duration: end - start, method: "copy" };
  }
  // Accurate boundaries require decoding arbitrary GOPs. CRF 16 preserves native
  // geometry, cadence and channel layout, including audio on muted timeline shots.
  await exec(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-ss",
      String(start),
      "-i",
      source,
      "-t",
      String(end - start),
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-crf",
      "16",
      "-preset",
      "fast",
      "-fps_mode",
      "passthrough",
      "-c:a",
      "pcm_s16le",
      "-movflags",
      "+faststart",
      dest,
    ],
    { maxBuffer: 1024 * 1024 },
  );
  return { start, end, duration: end - start, method: "encode" };
}
export async function buildKit({
  root,
  job,
  revision,
  candidates = [],
  resolveExtra,
}) {
  if (!Number.isInteger(revision) || revision < 1 || revision > job.revision)
    throw Error("Invalid revision");
  const key = `${root}/${job.id}/${revision}`;
  if (builds.has(key)) return builds.get(key);
  const pending = (async () => {
    const dir = path.join(root, job.id),
      zip = path.join(dir, `imovie-kit-${revision}.zip`);
    try {
      await stat(zip);
      return zip;
    } catch {}
    let cut;
    try {
      cut = JSON.parse(
        await readFile(path.join(dir, `cut-${revision}.json`), "utf8"),
      );
    } catch {
      if (
        revision !== job.revision ||
        ["queued", "editing"].includes(job.state)
      )
        throw Error("Historical cut unavailable");
      cut = JSON.parse(await readFile(path.join(dir, "cut.json"), "utf8"));
      await writeFile(
        path.join(dir, `cut-${revision}.json`),
        JSON.stringify(cut),
      );
    }
    const kit = manifest(cut, job, revision);
    const stage = path.join(dir, `kit-${revision}.building`);
    await rm(stage, { recursive: true, force: true });
    await mkdir(path.join(stage, "extras"), { recursive: true, mode: 0o700 });
    try {
      for (const clip of kit.clips) {
        const source = await confined(dir, clip.source);
        clip.range = await trim(
          source,
          path.join(stage, clip.file),
          clip.in - 1,
          clip.out + 1,
        );
        delete clip.source;
      }
      let inspection = {};
      try {
        inspection = JSON.parse(
          await readFile(path.join(dir, "inspection.json"), "utf8"),
        );
      } catch {}
      const extras = selectExtras(
        kit.clips.map((c) => c.assetId),
        candidates,
      );
      for (const asset of extras) {
        const source = await resolveExtra(asset);
        const duration = Number((await probe(source)).format.duration);
        const selected = extraRange(
          duration,
          inspection[asset.id] ??
            inspection.clips?.find((c) => c.assetId === asset.id),
        );
        const file = `extras/${String(kit.extras.length + 1).padStart(2, "0")}_${asset.id.slice(0, 8)}.mov`;
        const range = await trim(
          source,
          path.join(stage, file),
          selected.start,
          selected.end,
        );
        kit.extras.push({ assetId: asset.id, file, range });
      }
      if (kit.extras.length < 4)
        throw Error("At least four unused theme videos are required");
      const { copyFile } = await import("node:fs/promises");
      let preview = path.join(dir, `revision-${revision}.mp4`);
      try {
        await stat(preview);
      } catch {
        if (revision !== job.revision)
          throw Error("Historical preview unavailable");
        preview = path.join(dir, "final.mp4");
      }
      await copyFile(preview, path.join(stage, "preview.mp4"));
      const texts = [
        ...(cut.titles ?? []),
        ...(cut.captions ?? []),
        ...(cut.endCards ?? []),
        ...(cut.overlays ?? []).map((t) => ({
          ...t,
          text: t.props?.text ?? t.props?.title ?? t.props?.subtitle ?? "",
        })),
        ...cut.clips
          .filter((c) => c.card)
          .map((c) => ({
            start: kit.clips[cut.clips.indexOf(c)].timeline,
            end: kit.clips[cut.clips.indexOf(c)].timeline + c.seconds,
            text: Object.values(c.props ?? {})
              .filter((v) => typeof v === "string")
              .join(" / "),
          })),
      ];
      await writeFile(
        path.join(stage, "titles.txt"),
        texts
          .map(
            (t) =>
              `${t.start ?? t.at ?? 0}–${t.end ?? t.start ?? t.at ?? 0}s: ${t.text}`,
          )
          .join("\n") + "\n",
      );
      if (cut.music) {
        if (!cut.music.licensed || !cut.music.src)
          throw Error("Music license metadata required");
        await mkdir(path.join(stage, "music"));
        await copyFile(
          await confined(dir, cut.music.src),
          path.join(stage, "music", path.basename(cut.music.src)),
        );
      }
      await writeFile(
        path.join(stage, "kit.json"),
        JSON.stringify(kit, null, 2),
      );
      const { readdir } = await import("node:fs/promises");
      async function size(dir) {
        let total = 0;
        for (const e of await readdir(dir, { withFileTypes: true }))
          total += e.isDirectory()
            ? await size(path.join(dir, e.name))
            : (await stat(path.join(dir, e.name))).size;
        return total;
      }
      const bytes = await size(stage);
      if (bytes > 1.5e9) throw Error("Kit exceeds 1.5 GB; shorten the edit");
      await writeFile(
        path.join(stage, "README.txt"),
        `File → Import Media → select numbered clips → drag onto timeline in filename order.\nClips include up to 1 second handles on each side; trim handles using kit.json in/out and range.start.\nExtras are for swapping in; titles.txt contains text to recreate as iMovie titles; preview.mp4 is reference.\nMedia size: ${(bytes / 1e6).toFixed(1)} MB (ZIP is approximately this size); native resolution, fps and source audio retained.\n`,
      );
      await exec("/usr/bin/zip", ["-q", "-r", "-0", zip + ".tmp", "."], {
        cwd: stage,
      });
      await rename(zip + ".tmp", zip);
      return zip;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  })();
  builds.set(key, pending);
  try {
    return await pending;
  } finally {
    builds.delete(key);
  }
}
