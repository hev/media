// Clips mode orchestration: transcript from hev-meta, find-clips through the
// chat model, and one hev-edit job per confirmed clip.
import * as sdk from '@immich/sdk';
import type Anthropic from '@anthropic-ai/sdk';
import type { sessionOptions } from './immich.js';
import type { Thread, Threads } from './threads.js';
import {
  clipJob,
  findClipsRequest,
  parseSteer,
  proposedClips,
  validateCandidates,
  type ClipsState,
  type Segment,
} from './clips.js';

type Options = ReturnType<typeof sessionOptions>;

// hev-meta checks the same Immich session; forward only the caller's token.
export async function meta(path: string, options: Options, init: RequestInit = {}) {
  const url = process.env.HEV_META_URL;
  if (!url) throw Error('Transcripts are not configured');
  return fetch(url + path, {
    ...init,
    headers: { ...init.headers, Authorization: options.headers.Authorization, 'Content-Type': 'application/json' },
  });
}

export async function transcript(assetId: string, options: Options, request = meta) {
  const response = await request('/transcripts/' + assetId, options);
  if (!response.ok) throw Error('Transcript service unavailable');
  return (await response.json()) as {
    state: string;
    position?: number;
    transcript?: { segments: Segment[]; duration: number };
  };
}

export async function clipSource(id: string, options: Options, api = sdk) {
  const asset = await api.getAssetInfo({ id }, options);
  if (asset.type !== 'VIDEO' || !asset.originalPath?.startsWith('/external/'))
    throw Error('Clips need a video from the external library.');
  return asset;
}

export function newClips(asset: { id: string; originalFileName?: string }, steerText: string): ClipsState {
  const { steer, count } = parseSteer(steerText);
  return {
    assetId: asset.id,
    fileName: asset.originalFileName,
    steer,
    count,
    state: 'transcribing',
    message: 'Checking for a transcript…',
    aspectRatio: '9:16',
    captions: true,
    candidates: [],
    updatedAt: Date.now(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const running = new Set<string>();

// Advance one thread's clips from transcribing → finding → ready. Safe to call
// repeatedly (e.g. from polling after a restart): one runner per thread.
export async function advanceClips(
  deps: {
    threads: Threads;
    client: Pick<Anthropic, 'messages'>;
    model: string;
    request?: typeof meta;
    wait?: (ms: number) => Promise<void>;
  },
  owner: string,
  threadId: string,
  options: Options,
) {
  const { threads, client, model, request = meta, wait = sleep } = deps;
  if (running.has(threadId)) return;
  running.add(threadId);
  const update = (change: Partial<ClipsState>) => {
    const current = threads.clips(owner, threadId)?.clips;
    if (!current) return undefined;
    Object.assign(current, change);
    threads.saveClips(owner, threadId, current);
    return current;
  };
  try {
    let requested = false;
    for (;;) {
      const clips = threads.clips(owner, threadId)?.clips;
      if (!clips || !['transcribing', 'finding'].includes(clips.state)) return;
      const status = await transcript(clips.assetId, options, request);
      if (status.state === 'failed' && requested) throw Error('transcription failed');
      if (status.state === 'none' || status.state === 'failed') {
        const response = await request('/transcripts/' + clips.assetId, options, { method: 'POST', body: '{}' });
        if (!response.ok) throw Error('transcript request refused');
        requested = true;
        update({ state: 'transcribing', message: 'Transcript requested. Transcribing locally…' });
        await wait(3000);
        continue;
      }
      if (status.state !== 'done' || !status.transcript) {
        update({
          state: 'transcribing',
          message:
            status.state === 'running'
              ? 'Transcribing speech locally…'
              : `Waiting to transcribe (${status.position ?? 0} ahead)…`,
        });
        await wait(5000);
        continue;
      }
      const segments = status.transcript.segments;
      update({ state: 'finding', message: 'Finding clips in the transcript…', duration: status.transcript.duration });
      const message = await client.messages.create(findClipsRequest(segments, clips.steer, clips.count, model));
      const candidates = validateCandidates(proposedClips(message as any), segments, { count: clips.count });
      if (!candidates.length) {
        update({ state: 'failed', message: 'No standalone clips were found. Try /clips with a different steer.' });
        return;
      }
      update({
        state: 'ready',
        candidates,
        message: `${candidates.length} candidate clips. Choose clips, adjust titles or in/out, then Make clips.`,
      });
      return;
    }
  } catch {
    // Upstream errors may contain private data; keep the card message generic.
    update({ state: 'failed', message: 'Could not prepare clips. Try /clips again.' });
  } finally {
    running.delete(threadId);
  }
}

// After the confirmation: one edit job per selected clip, queued in hev-edit.
export async function launchClips(
  deps: {
    threads: Threads;
    launcher: (path: string, init?: RequestInit) => Promise<Response>;
    request?: typeof meta;
    api?: typeof sdk;
  },
  owner: string,
  thread: Thread,
  options: Options,
) {
  const { threads, launcher, request = meta, api = sdk } = deps;
  const threadId = thread.id;
  const record = threads.clips(owner, threadId);
  if (!record) throw Error('Find clips first with /clips.');
  const clips = record.clips;
  const asset = await clipSource(clips.assetId, options, api);
  const status = await transcript(clips.assetId, options, request);
  if (status.state !== 'done' || !status.transcript) throw Error('The transcript is not ready yet.');
  const jobs = [];
  for (const candidate of clips.candidates.filter((c) => c.selected && !c.jobId)) {
    const response = await launcher('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...clipJob(asset as any, candidate, clips, status.transcript.segments),
        threadId,
        ownerId: owner,
      }),
    });
    if (!response.ok) {
      candidate.error = 'The edit service could not accept this clip.';
      continue;
    }
    const job = (await response.json()) as { id: string };
    candidate.jobId = job.id;
    delete candidate.error;
    jobs.push(job);
    threads.claim(owner, thread, job.id);
  }
  clips.state = 'started';
  clips.message = jobs.length
    ? `Started ${jobs.length} clip edit${jobs.length === 1 ? '' : 's'}. They render one at a time; each has its own edit card.`
    : 'No clip edits could be started.';
  // Launching consumes the confirmation.
  threads.saveClips(owner, threadId, clips, null);
  return jobs;
}
