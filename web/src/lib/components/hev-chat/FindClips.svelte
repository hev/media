<script lang="ts">
  import { goto } from '$app/navigation';
  let { id }: { id: string } = $props();
  let busy = $state(false);
  let error = $state('');
  async function request(path: string, body: object) {
    const r = await fetch('/hev-chat' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('Could not start clips. Check that this is an external-library video.');
    return r.json();
  }
  // New thread with this video, then the clips card transcribes and finds moments.
  async function start() {
    busy = true;
    error = '';
    try {
      const thread = await request('/threads', {});
      await request(`/threads/${thread.id}/assets`, { ids: [id] });
      await request(`/threads/${thread.id}/clips`, { assetId: id });
      await goto('/chat/' + thread.id);
    } catch (error_) {
      error = error_ instanceof Error ? error_.message : String(error_);
    } finally {
      busy = false;
    }
  }
</script>

<div class="relative text-sm">
  <button
    type="button"
    class="rounded-lg border bg-immich-bg px-3 py-2 text-immich-fg dark:bg-immich-dark-bg dark:text-immich-dark-fg"
    disabled={busy}
    onclick={start}>Find clips</button
  >
  {#if error}<p role="alert">{error}</p>{/if}
</div>
