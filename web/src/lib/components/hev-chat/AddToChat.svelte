<script lang="ts">
  import Portal from '$lib/elements/Portal.svelte';
  import { goto } from '$app/navigation';
  let { ids }: { ids: string[] } = $props();
  let threads = $state<{ id: string; title: string }[]>([]);
  let open = $state(false);
  let busy = $state(false);
  let error = $state('');
  let position = $state({ left: 8, top: 64 });
  async function request(path: string, body?: object) {
    const r = await fetch('/hev-chat' + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(body && { body: JSON.stringify(body) }),
    });
    if (!r.ok) throw new Error('Could not add to chat. Check your selection and sign-in.');
    return r.json();
  }
  async function toggle(event: MouseEvent) {
    const rect = (event.currentTarget as HTMLButtonElement).getBoundingClientRect();
    position = {
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 264)),
      top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 340)),
    };
    try {
      const recent = await request('/threads');
      threads = recent.slice(0, 8);
      open = !open;
      error = '';
    } catch (error_) {
      error = String(error_);
    }
  }
  async function add(id?: string) {
    busy = true;
    error = '';
    try {
      if (!id) {
        const created = await request('/threads', {});
        id = created.id;
      }
      await request(`/threads/${id}/assets`, { ids });
      await goto('/chat/' + id);
    } catch (error_) {
      error = String(error_);
    } finally {
      busy = false;
    }
  }
</script>

<div class="relative text-sm">
  <button
    type="button"
    class="rounded-lg border bg-immich-bg px-3 py-2 text-immich-fg dark:bg-immich-dark-bg dark:text-immich-dark-fg"
    disabled={busy || ids.length === 0 || ids.length > 20}
    onclick={toggle}>Add to chat</button
  >
  {#if open}
    <Portal target="body">
      <button
        type="button"
        class="fixed inset-0 z-9999 cursor-default"
        aria-label="Close Add to chat"
        onclick={() => (open = false)}
      ></button>
      <div
        role="region"
        aria-label="Recent chat threads"
        style:left="{position.left}px"
        style:top="{position.top}px"
        class="fixed z-10000 max-h-80 w-64 overflow-y-auto rounded-lg border bg-immich-bg p-2 text-immich-fg shadow-lg dark:bg-immich-dark-bg dark:text-immich-dark-fg"
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
    </Portal>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
</div>
