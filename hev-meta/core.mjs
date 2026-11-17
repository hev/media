// Pure helpers for hev-meta: path mapping, whisper/ffmpeg commands, transcript
// parsing and caption writing. No I/O beyond realpath in hostPath.
import { realpath } from "node:fs/promises";
import path from "node:path";

export const ASSET_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// Immich original paths are container paths under /external. Map them onto the
// host root and refuse anything that escapes it (including through symlinks).
export async function hostPath(original, root) {
  if (
    typeof original !== "string" ||
    !original.startsWith("/external/") ||
    original.split("/").includes("..") ||
    original.includes("\0")
  )
    throw Error("Original is outside /external");
  const base = await realpath(root);
  const target = await realpath(path.join(base, original.slice("/external/".length)));
  if (!target.startsWith(base + path.sep)) throw Error("Original escapes external root");
  // Hidden directories (including .immich) are excluded from the library.
  if (path.relative(base, target).split(path.sep).some((p) => p.startsWith(".")))
    throw Error("Original is in a hidden directory");
  return target;
}

// The reverse mapping for `hev-meta transcribe --path PATH`.
export async function containerPath(file, root) {
  const base = await realpath(root);
  const target = await realpath(file);
  if (!target.startsWith(base + path.sep)) throw Error("Path is outside the external root");
  return "/external/" + path.relative(base, target).split(path.sep).join("/");
}

export function audioArgs(input, output) {
  return ["-nostdin", "-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", output];
}

// Read through an existing read-only container mount when a LaunchAgent cannot
// read the removable volume (board #377). The container decodes to a WAV
// stream; the host rewrites it with a correct header.
export function containerAudioCommands({ context = "default", container, original, output }) {
  return [
    ["docker", ["--context", context, "exec", container, "nice", "-n", "19", "ffmpeg", "-nostdin", "-v", "error", "-i", original, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"]],
    ["ffmpeg", ["-nostdin", "-v", "error", "-f", "wav", "-i", "pipe:0", "-c:a", "pcm_s16le", "-y", output]],
  ];
}

export function whisperArgs({ model, vadModel, wav, outBase, prompt, threads = 4 }) {
  const args = ["-m", model, "-f", wav, "-l", "auto", "-t", String(threads), "-ml", "84", "-sow", "-ojf", "-of", outBase, "-np"];
  if (vadModel) args.push("--vad", "-vm", vadModel);
  if (prompt) args.push("--prompt", prompt);
  return args;
}

export function cleanText(text) {
  return String(text ?? "")
    .replace(/\[_?[A-Z]+_?\d*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

// The vocabulary prompt names people and terms in this asset. Whisper still
// prefers common spellings ("Megan" for "Meghan"), so correct capitalized
// words within one edit (two for seven-letter names) of a capitalized
// vocabulary word of five or more letters.
export function vocabulary(prompt) {
  return [...new Set(String(prompt ?? "").match(/\p{L}[\p{L}'’-]*/gu) ?? [])].filter(
    (w) => w.length >= 5 && /^\p{Lu}/u.test(w),
  );
}
export function applyVocabulary(text, words) {
  if (!words.length) return text;
  return text.replace(/\p{L}[\p{L}'’-]*/gu, (word) => {
    if (!/^\p{Lu}/u.test(word) || word.length < 4) return word;
    const hit = words.find(
      (v) =>
        v.toLowerCase() !== word.toLowerCase() &&
        distance(v.toLowerCase(), word.toLowerCase()) <= (v.length >= 7 ? 2 : 1),
    );
    return hit ?? word;
  });
}

// whisper-cli -ojf output → [{id,start,end,text}] in seconds. Segment offsets
// are remapped through VAD by whisper.cpp; token offsets are not, so words are
// not stored.
export function parseWhisper(json, prompt) {
  const words = vocabulary(prompt);
  const segments = [];
  for (const s of json?.transcription ?? []) {
    const raw = cleanText(s.text);
    const start = Number(s.offsets?.from) / 1000,
      end = Number(s.offsets?.to) / 1000;
    if (!raw || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const text = applyVocabulary(raw, words);
    segments.push({ id: segments.length, start: round(start), end: round(end), text, ...(text !== raw ? { raw } : {}) });
  }
  return { language: json?.result?.language ?? "unknown", segments };
}
const round = (n) => Math.round(n * 1000) / 1000;

function stamp(seconds, separator) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000),
    m = Math.floor((ms % 3600000) / 60000),
    s = Math.floor((ms % 60000) / 1000);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms % 1000, 3)}`;
}
// Cue text must not contain a blank line or the "-->" separator.
const cue = (text) => text.replace(/-->/g, "→").replace(/\n\s*\n/g, "\n");

export function toVtt(segments) {
  return (
    "WEBVTT\n\n" +
    segments.map((s, i) => `${i + 1}\n${stamp(s.start, ".")} --> ${stamp(s.end, ".")}\n${cue(s.text)}\n`).join("\n")
  );
}
export function toSrt(segments) {
  return segments.map((s, i) => `${i + 1}\n${stamp(s.start, ",")} --> ${stamp(s.end, ",")}\n${cue(s.text)}\n`).join("\n");
}

export function parseLanguageProbability(stderr) {
  const m = String(stderr).match(/auto-detected language: (\w+) \(p = ([\d.]+)\)/);
  return m ? { language: m[1], probability: Number(m[2]) } : undefined;
}
