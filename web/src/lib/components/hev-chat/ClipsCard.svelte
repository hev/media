<script lang="ts" module>
  export type ClipCandidate = {
    id: string;
    start: number;
    end: number;
    title: string;
    quote: string;
    why: string;
    selected: boolean;
    jobId?: string;
    error?: string;
  };
  export type Clips = {
    assetId: string;
    fileName?: string;
    duration?: number;
    steer: string;
    count: number;
    state: 'transcribing' | 'finding' | 'ready' | 'started' | 'failed';
    message: string;
    aspectRatio: string;
    captions: boolean;
    candidates: ClipCandidate[];
  };
</script>

<script lang="ts">
  import { getAssetPlaybackUrl } from '$lib/utils';

  type Job = { id: string; state: string };
  let {
    threadId,
    clips = $bindable(),
    edits,
    busy,
    onMake,
    onOpen,
  }: {
    threadId: string;
    clips: Clips;
    edits: Job[];
    busy: boolean;
    onMake: () => Promise<void>;
    onOpen: (assetId: string) => void;
  } = $props();
  let error = $state('');
  let player = $state<HTMLVideoElement>();
  let playing = $state<ClipCandidate>();
  const chosen = $derived(clips.candidates.filter((c) => c.selected && !c.jobId));
  const time = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  async function save() {
    error = '';
    const r = await fetch(`/hev-chat/threads/${threadId}/clips`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aspectRatio: clips.aspectRatio,
        captions: clips.captions,
        candidates: clips.candidates
          .filter((c) => !c.jobId)
          .map(({ id, selected, title, start, end }) => ({ id, selected, title, start: Number(start), end: Number(end) })),
      }),
    });
    if (!r.ok) {
      error = (await r.json().catch(() => ({}))).message ?? 'Could not save clips.';
      return false;
    }
    clips = await r.json();
    return true;
  }
  async function play(candidate: ClipCandidate) {
    playing = candidate;
    if (!player) return;
    if (!player.src) player.src = getAssetPlaybackUrl({ id: clips.assetId });
    player.currentTime = candidate.start;
    await player.play().catch(() => {});
  }
  async function make() {
    if (await save()) await onMake();
  }
</script>

<section aria-label="Clips" class="my-2 max-h-[55dvh] shrink-0 overflow-y-auto rounded-xl border p-3">
  <p class="font-semibold">
    Clips · {clips.fileName ?? 'video'}{#if clips.steer}
      · “{clips.steer}”{/if}
  </p>
  <p role="status" class="text-sm">{clips.message}</p>
  {#if clips.state === 'ready' || clips.state === 'started'}
    <div class="my-2 flex flex-wrap gap-4 text-sm">
      <label
        >Aspect ratio <select
          aria-label="Clip aspect ratio"
          bind:value={clips.aspectRatio}
          disabled={clips.state !== 'ready'}
          onchange={save}>{#each ['9:16', '1:1', '16:9', '4:5'] as ratio (ratio)}<option>{ratio}</option>{/each}</select
        ></label
      >
      <label
        ><input type="checkbox" bind:checked={clips.captions} disabled={clips.state !== 'ready'} onchange={save} /> Captions
        from the transcript</label
      >
      <span>No music</span>
    </div>
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={player}
      aria-label="Clip preview"
      class="mb-2 max-h-56 rounded-lg"
      class:hidden={!playing}
      controls
      playsinline
      preload="none"
      ontimeupdate={() => {
        if (playing && player && player.currentTime >= playing.end) player.pause();
      }}
    ></video>
    <ol class="flex flex-col gap-3">
      {#each clips.candidates as candidate, index (candidate.id)}
        {@const job = edits.find((e) => e.id === candidate.jobId)}
        <li class="rounded-lg border p-2" aria-label={`Clip ${index + 1}`}>
          <div class="flex flex-wrap items-center gap-2">
            <input
              type="checkbox"
              aria-label={`Select clip ${index + 1}`}
              bind:checked={candidate.selected}
              disabled={!!candidate.jobId || clips.state !== 'ready'}
              onchange={save}
            />
            <input
              class="min-w-0 flex-1 bg-transparent font-semibold"
              aria-label={`Title for clip ${index + 1}`}
              bind:value={candidate.title}
              maxlength={100}
              disabled={!!candidate.jobId || clips.state !== 'ready'}
              onchange={save}
            />
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-2 text-sm">
            <label
              >In <input
                class="w-20 bg-transparent"
                type="number"
                step="0.1"
                min="0"
                aria-label={`In point for clip ${index + 1} (seconds)`}
                bind:value={candidate.start}
                disabled={!!candidate.jobId || clips.state !== 'ready'}
                onchange={save}
              /></label
            >
            <label
              >Out <input
                class="w-20 bg-transparent"
                type="number"
                step="0.1"
                min="0"
                aria-label={`Out point for clip ${index + 1} (seconds)`}
                bind:value={candidate.end}
                disabled={!!candidate.jobId || clips.state !== 'ready'}
                onchange={save}
              /></label
            >
            <span>{time(candidate.start)}–{time(candidate.end)} · {Math.round(candidate.end - candidate.start)} s</span>
            <button type="button" class="underline" onclick={() => play(candidate)}
              >Play from {time(candidate.start)}</button
            >
            <button type="button" class="underline" onclick={() => onOpen(clips.assetId)}>Open in viewer</button>
          </div>
          <blockquote class="mt-1 border-l-2 pl-2 text-sm">“{candidate.quote}”</blockquote>
          {#if candidate.why}<p class="text-sm opacity-70">{candidate.why}</p>{/if}
          {#if candidate.jobId}<a class="text-sm underline" href={`#edit-${candidate.jobId}`}
              >Edit {candidate.jobId.slice(0, 8)} · {job?.state ?? 'queued'}</a
            >{/if}
          {#if candidate.error}<p role="alert" class="text-sm text-red-600">{candidate.error}</p>{/if}
        </li>
      {/each}
    </ol>
    {#if clips.state === 'ready'}
      <p class="mt-2 text-sm">
        Make clips starts one edit per selected clip; they render one at a time. You can also say “make clips”. Nothing is
        published.
      </p>
      <button
        type="button"
        class="mt-2 rounded-lg border p-2"
        disabled={busy || chosen.length === 0 || chosen.length > 20}
        onclick={make}>Make {chosen.length} {chosen.length === 1 ? 'clip' : 'clips'}</button
      >
    {/if}
  {/if}
  {#if error}<p role="alert" class="text-red-600">{error}</p>{/if}
</section>
