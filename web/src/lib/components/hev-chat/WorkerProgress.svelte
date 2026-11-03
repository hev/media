<script lang="ts">
  import { onMount } from 'svelte';
  export type Progress = { revision: number; stage: string; message: string; at: number; agent: string; model: string };
  let { steps = [], state: jobState }: { steps?: Progress[]; state: string } = $props();
  let now = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const latest = $derived(steps.at(-1));
  const start = $derived(steps.findLast((s) => s.stage === 'started' || s.stage === 'building') ?? steps[0]);
  const elapsed = $derived(
    Math.max(
      0,
      Math.floor(
        ((['queued', 'editing', 'building'].includes(jobState) ? now : (latest?.at ?? now)) - (start?.at ?? now)) /
          1000,
      ),
    ),
  );
</script>

{#if latest}
  <details class="my-2 rounded-lg border p-2 text-sm" open={['queued', 'editing', 'building'].includes(jobState)}>
    <summary>{latest.agent} · {latest.message} · {elapsed}s</summary>
    <p class="mt-2 opacity-75">{latest.model} · revision {latest.revision}</p>
    <ol class="mt-2 space-y-1">
      {#each steps as step, i (i)}<li>{new Date(step.at).toLocaleTimeString()} · {step.message}</li>{/each}
    </ol>
  </details>
{/if}
