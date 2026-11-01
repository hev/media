#!/usr/bin/env node
// Research prototype. Candidate plist keys are hypotheses, NOT Apple's schema.
import { readFile, mkdir, mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { resolve, dirname, join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function run(command, args) {
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${command}: ${r.stderr || r.stdout}`);
  return r.stdout;
}
export function plan(cut) {
  if (!Array.isArray(cut.clips) || !cut.clips.length) throw new Error('cut.clips must be nonempty');
  let position = 0;
  return cut.clips.map((clip, index) => {
    if (typeof clip.src !== 'string' || !clip.src || !Number.isFinite(clip.in) ||
        !Number.isFinite(clip.out) || clip.in < 0 || clip.out <= clip.in) {
      throw new Error(`Invalid source or trim at clip ${index}`);
    }
    const entry = { index, asset: `Assets/${String(index).padStart(4, '0')}.mp4`,
      source: clip.src, sourceIn: clip.in, sourceOut: clip.out,
      start: position, duration: clip.out - clip.in, audio: clip.audio !== false };
    position += entry.duration;
    return entry;
  });
}

export async function build(cutPath, output, experimental = false) {
  if (!experimental) throw new Error('Unverified format: pass --experimental to generate a candidate, not a validated iMovie project');
  output = resolve(output);
  if (extname(output).toLowerCase() !== '.imoviemobile') throw new Error('Output must end in .iMovieMobile');
  try { await stat(output); throw new Error('Output already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const cut = JSON.parse(await readFile(cutPath, 'utf8'));
  const clips = plan(cut);
  const stage = await mkdtemp(join(tmpdir(), 'hev-imovie-spike-'));
  try {
    const payload = join(stage, 'payload');
    await mkdir(join(payload, 'Assets'), { recursive: true });
    for (const clip of clips) {
      const source = resolve(dirname(resolve(cutPath)), clip.source);
      const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', source]));
      if (!probe.streams.some(s => s.codec_type === 'video') ||
          clip.sourceOut > Number(probe.format.duration) + 0.05) throw new Error(`Clip ${clip.index} exceeds source duration or has no video`);
      // Re-encode rather than stream copy so cuts do not depend on keyframes.
      run('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-i', source, '-ss', String(clip.sourceIn),
        '-t', String(clip.duration), '-map', '0:v:0', ...(clip.audio ? ['-map', '0:a:0?'] : ['-an']),
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-movflags', '+faststart', join(payload, clip.asset)]);
    }
    const manifest = { status: 'UNVERIFIED_SCHEMA', name: cut.name || 'HEV spike', clips,
      overlays: cut.overlays || [], captions: cut.captions || [],
      limitations: ['Apple timeline keys are unknown', 'No verified native import',
        'Titles, transitions, music, crop and focus are not implemented'] };
    await writeFile(join(payload, 'hev-timeline.json'), JSON.stringify(manifest, null, 2));
    // These keys are deliberately labelled as guesses in the archive itself.
    // This candidate exists only to test importer rejection and learn the schema.
    const candidate = { HEVUnverifiedSchema: true, name: manifest.name,
      clips: clips.map(c => ({ media: c.asset, start: 0, duration: c.duration, audio: c.audio })) };
    await writeFile(join(payload, 'candidate.json'), JSON.stringify(candidate));
    run('plutil', ['-convert', 'xml1', '-o', join(payload, 'iMovieMobileProject.plist'), join(payload, 'candidate.json')]);
    await rm(join(payload, 'candidate.json'));
    await mkdir(dirname(output), { recursive: true });
    // zip refuses neither overwrites nor races; reserve the destination exclusively.
    const archive = join(stage, 'candidate.iMovieMobile');
    run('/usr/bin/ditto', ['-c', '-k', '--norsrc', payload, archive + '.zip']);
    const { copyFile, constants } = await import('node:fs/promises');
    await copyFile(archive + '.zip', output, constants.COPYFILE_EXCL);
    return { output, status: manifest.status, clips: clips.length };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [cut, output, flag] = process.argv.slice(2);
  if (!cut || !output || flag !== '--experimental') {
    console.error('Usage: node imovie-project.mjs cut.json output.iMovieMobile --experimental\nUNVERIFIED: native timeline schema is unknown. Do not distribute as a working project.');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await build(cut, output, true))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
