<script lang="ts">
  import { goto } from '$app/navigation';
  let { ids }: { ids: string[] } = $props();
  let threads = $state<{ id: string; title: string }[]>([]);
  let open = $state(false);
  let busy = $state(false);
  let error = $state('');
  async function request(path: string, body?: object) {
    const r = await fetch('/hev-chat' + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) throw Error('Could not add to chat. Check your selection and sign-in.');
    return r.json();
  }
  async function toggle() {
    try {
      threads = (await request('/threads')).slice(0, 8);
      open = !open;
      error = '';
    } catch (e) {
      error = String(e);
    }
  }
  async function add(id?: string) {
    busy = true;
    error = '';
    try {
      id ??= (await request('/threads', {})).id;
      await request(`/threads/${id}/assets`, { ids });
      await goto('/chat/' + id);
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="relative text-sm">
  <button
    type="button"
    class="rounded-lg border px-3 py-2"
    disabled={busy || !ids.length || ids.length > 20}
    onclick={toggle}>Add to chat</button
  >
  {#if open}
    <div
      class="absolute right-0 z-50 max-h-80 w-64 overflow-y-auto rounded-lg border bg-immich-bg p-2 text-immich-fg shadow-lg dark:bg-immich-dark-bg dark:text-immich-dark-fg"
    >
      <p class="p-2 font-semibold">Add {ids.length} to a thread</p>
      <button type="button" class="block w-full p-2 text-left underline" disabled={busy} onclick={() => add()}
        >New thread</button
      >
      {#each threads as thread (thread.id)}<button
          type="button"
          class="block w-full truncate p-2 text-left underline"
          disabled={busy}
          onclick={() => add(thread.id)}>{thread.title}</button
        >{/each}
    </div>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
</div>
