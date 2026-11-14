import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const execute = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function dispatchState(value) {
  if (value.active) return 'running';
  const result = JSON.parse(value.files?.['result.json'] || 'null');
  if (!result?.end || result.end.startsWith('0001-')) return 'died';
  if (result.launch_unconfirmed) return 'launch-unconfirmed';
  if (result.timeout) return 'timeout';
  if (result.needs_review || ['blocked', 'needs-decision'].includes(result.outcome)) return 'blocked';
  return result.exit_code === 0 ? 'done' : 'failed';
}
export class EditDispatch {
  constructor({ exe = process.env.HEV_EDIT_DISPATCH || 'hev', repo = process.env.HEV_EDIT_DISPATCH_REPO || 'media-edits', call = execute, wait = sleep } = {}) {
    Object.assign(this, { exe, repo, call, wait });
  }
  async command(args, dir) {
    const { stdout } = await this.call(this.exe, ['dispatch', ...args, '--host', 'mini', '--json'], { cwd: dir, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  }
  async show(name) { return dispatchState(JSON.parse(await this.command(['show', name]))); }
  async recover(job) {
    if (!['editing', 'queued'].includes(job.state) || job.dispatchRevision !== job.revision || !job.dispatchRun) return false;
    try { return ['running', 'launch-unconfirmed', 'done'].includes(await this.show(job.dispatchRun)); }
    catch { return false; }
  }
  async run({ job, dir, prompt, save, progress }) {
    if (job.dispatchRevision !== job.revision) {
      job.dispatchRun = `edit-${job.id}-r${job.revision}`;
      job.dispatchRevision = job.revision;
      job.dispatchLaunched = false;
    }
    // Persist identity before launch, so restart can reconcile an ambiguous launch.
    await save(job);
    if (!job.dispatchLaunched) {
      const order = path.join(dir, `order-${job.revision}.md`);
      await writeFile(order, `---\nname: ${job.dispatchRun}\nhost: mini\nrepo: ${JSON.stringify(this.repo)}\nbase: main\nharness: codex\nmodel: gpt-6.1-sol\ntimeout: 180\n---\nWork only in the absolute job directory ${JSON.stringify(dir)}. Before changing directory, remember the absolute dispatch run directory (the parent of your initial worktree); use it for dispatch bookkeeping. Change directory to the job directory before editing. The dispatch git worktree is incidental. Do NOT commit, push, create branches, or open a PR. Keep media and paths out of git and PRs.\nBefore editing, verify you can read every original in brief.json and run ffmpeg, ffprobe and the video skill's transcription tools. If unavailable, report the problem and fail; do not change permissions or containers.\n${prompt}\nWrite a short dispatch report in the remembered dispatch run directory/report.md and finish that run directory/status.md with done only after all deliverables exist; use blocked: reason on failure. These dispatch bookkeeping files are the only exception to working in the job directory.\n\n## Acceptance\n- final.mp4 and cut.json exist in ${JSON.stringify(dir)} and match the brief.\n- No commit, branch push or PR was created.\n`, { mode: 0o600 });
      let delay = 1000;
      while (true) {
        try { await this.command([order], dir); break; }
        catch (error) {
          if (!/host full/i.test(`${error.stderr || ''} ${error.message}`)) throw error;
          job.state = 'queued';
          await progress('queued', 'Waiting for an edit worker slot');
          await this.wait(delay);
          delay = Math.min(delay * 2, 30000);
        }
      }
      job.dispatchLaunched = true;
    }
    job.state = 'editing';
    await progress('started', 'Edit worker running');
    await save(job);
    while (true) {
      const state = await this.show(job.dispatchRun);
      if (state === 'done') return;
      if (!['running', 'launch-unconfirmed'].includes(state)) throw Error(`Edit worker ${state}`);
      await this.wait(1000);
    }
  }
  async clean(job) { await this.command(['clean', job.dispatchRun]); }
}
