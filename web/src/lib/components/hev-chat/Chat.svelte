<script lang="ts">
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { getAssetInfo } from '@immich/sdk';
  import { onDestroy, onMount, tick } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';

  type Revision = { revision: number; preview: string; bufferUrl?: string };
  type Thread = { id: string; title: string; messages: Message[]; selected: Photo[]; jobs: string[] };
  let threads = $state<Thread[]>([]);
  let current = $state<Thread>();
  let drawer = $state(false);
  let selected = $state<string[]>([]);
  let revisions = $state<Record<string, number>>({});
  let log: HTMLDivElement;
  let following = $state(true);
  async function api(path: string, method = 'GET', body?: object) {
    const r = await fetch('/hev-chat' + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body && { body: JSON.stringify(body) }),
    });
    if (!r.ok) throw new Error('Request failed. Please try again.');
    return r.json();
  }
  async function list() {
    threads = await api('/threads');
  }
  async function newThread() {
    const t = await api('/threads', 'POST');
    await list();
    await goto('/chat/' + t.id);
  }
  async function load(id: string) {
    if (busy) return;
    current = await api('/threads/' + id);
    messages = current!.messages;
    selected = current!.selected.map((a) => a.id);
    edits = [];
    following = true;
    drawer = false;
    await refreshEdits();
    await scrollLatest();
  }
  $effect(() => {
    const id = page.params.threadId;
    if (id && current?.id !== id) void load(id);
  });
  async function scrollLatest() {
    await tick();
    if (following && log) log.scrollTop = log.scrollHeight;
  }
  async function rename(t: Thread) {
    const title = prompt('Thread name', t.title);
    if (title) {
      await api('/threads/' + t.id, 'PATCH', { title });
      await list();
    }
  }
  async function remove(t: Thread) {
    if (!confirm('Delete this thread? Edit files will be retained.')) return;
    await api('/threads/' + t.id, 'DELETE');
    await list();
    if (current?.id === t.id) {
      current = undefined;
      messages = [];
      await goto('/chat');
    }
  }
  async function useSelection() {
    if (!current) return;
    current = await api('/threads/' + current.id + '/selection', 'POST', { ids: selected });
    question =
      'Use these selected videos in an edit. Propose a brief and length and ask me to confirm before starting.';
    await send();
  }
  async function revise(edit: Edit) {
    const change = prompt('What should change?');
    if (change) {
      await api('/edits/' + edit.id + '/revise', 'POST', { change });
      await refreshEdits();
    }
  }
  type LibraryBuild = { state: string; message: string; command?: string };
  let libraryBuilds = $state<Record<string, LibraryBuild>>({});
  let libraryPending = $state<Record<string, boolean>>({});
  async function imovie(edit: Edit) {
    const revision = revisions[edit.id] ?? edit.revision;
    const key = edit.id + ':' + revision;
    libraryPending[key] = true;
    try {
      libraryBuilds[key] = await api(`/edits/${edit.id}/imovie-library?revision=${revision}`, 'POST');
    } catch (error_) {
      error = String(error_);
    } finally {
      libraryPending[key] = false;
    }
  }
  async function refreshLibraries() {
    for (const edit of edits) {
      const revision = revisions[edit.id] ?? edit.revision;
      const key = edit.id + ':' + revision;
      // GET only reads existing state; viewing a card never starts a build.
      try {
        const response = await fetch(`/hev-chat/edits/${edit.id}/imovie-library?revision=${revision}`);
        if (response.ok) libraryBuilds[key] = await response.json();
      } catch {
        /* preserve last observed state during a network interruption */
      }
    }
  }
  async function publish(edit: Edit) {
    try {
      await api('/edits/' + edit.id + '/publish', 'POST', { revision: revisions[edit.id] ?? edit.revision });
      await refreshEdits();
    } catch (error_) {
      error = String(error_);
    }
  }
  type Edit = {
    revisions?: Revision[];
    threadId?: string;
    id: string;
    state: string;
    note: string;
    preview?: string;
    bufferUrl?: string;
    revision: number;
  };
  let edits = $state<Edit[]>([]);
  let timer: ReturnType<typeof setInterval>;
  async function refreshEdits() {
    try {
      if (!current) return;
      const response = await fetch('/hev-chat/threads/' + current.id + '/edits');
      if (response.ok) {
        edits = await response.json();
        await refreshLibraries();
        await scrollLatest();
      }
    } catch {
      /* next poll can recover */
    }
  }
  onMount(() => {
    void list();
    timer = setInterval(() => void refreshEdits(), 3000);
  });
  onDestroy(() => clearInterval(timer));
  type Photo = { id: string; originalFileName?: string };
  type Message = { role: 'user' | 'assistant'; content: string; assets: Photo[]; jobs?: string[] };
  let messages = $state<Message[]>([]);
  let question = $state('');
  let busy = $state(false);
  let error = $state('');
  let controller: AbortController | undefined;
  onDestroy(() => controller?.abort());

  async function send() {
    if (busy || !question.trim()) return;
    if (!current) {
      const t = await api('/threads', 'POST');
      await goto('/chat/' + t.id);
      await load(t.id);
    }
    error = '';
    messages.push({ role: 'user', content: question.trim(), assets: [] });
    question = '';
    const history = messages.slice(-20).map(({ role, content }) => ({ role, content }));
    messages.push({ role: 'assistant', content: '', assets: [] });
    const index = messages.length - 1;
    busy = true;
    controller = new AbortController();
    try {
      const response = await fetch('/hev-chat/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: current!.id, messages: history }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body)
        throw new Error(
          response.status === 401 ? 'Sign in to Immich to use chat.' : 'Chat is unavailable. Please try again.',
        );
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let done = false;
      const consume = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        switch (event.type) {
          case 'text': {
            messages[index].content += event.text;
            break;
          }
          case 'edit': {
            const previous = edits.findIndex((job) => job.id === event.job.id);
            if (previous === -1) {
              edits.push(event.job);
            } else edits[previous] = event.job;
            if (messages.every((m) => !m.jobs?.includes(event.job.id))) {
              messages[index].jobs ??= [];
              messages[index].jobs!.push(event.job.id);
            }
            break;
          }
          case 'assets': {
            const seen = new Set(messages[index].assets.map((asset) => asset.id));
            messages[index].assets.push(...event.assets.filter((asset: Photo) => !seen.has(asset.id)));

            break;
          }
          case 'error': {
            throw new Error(event.message);
          }
          case 'done': {
            done = true;
            // No default
            break;
          }
        }
      };
      while (true) {
        const chunk = await reader.read();
        pending += decoder.decode(chunk.value, { stream: !chunk.done });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) consume(line);
        await scrollLatest();
        if (chunk.done) break;
      }
      consume(pending);
      if (!done) throw new Error('The response ended early. Please try again.');
    } catch (error_) {
      error = error_ instanceof Error ? error_.message : 'Chat is unavailable.';
    } finally {
      busy = false;
      await list();
      await scrollLatest();
    }
  }

  async function openPhoto(id: string) {
    try {
      assetViewerManager.setAsset(await getAssetInfo({ ...authManager.params, id }));
    } catch {
      error = 'This photo is no longer available.';
    }
  }
  const cursor = $derived({ current: assetViewerManager.asset! });
</script>

<UserPageLayout title="Chat">
  <div class="relative flex h-full min-h-0 dark:text-immich-dark-fg">
    <aside
      class={`${drawer ? 'block' : 'hidden'} w-56 shrink-0 overflow-y-auto border-r p-3 max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-20 max-md:bg-immich-bg md:block max-md:dark:bg-immich-dark-bg`}
      aria-label="Threads"
    >
      <button type="button" class="mb-2 block md:hidden" onclick={() => (drawer = false)}>Close threads</button>
      <button type="button" class="mb-4 rounded-xl border p-3" onclick={newThread} disabled={busy}>New thread</button>
      {#each threads as thread (thread.id)}
        <div class="mb-3 rounded-xl p-2" class:bg-immich-gray={current?.id === thread.id}>
          <a
            class="block wrap-break-word underline"
            href={`/chat/${thread.id}`}
            onclick={(e) => {
              if (busy) e.preventDefault();
            }}>{thread.title}</a
          >
          <button type="button" class="mr-3 text-sm" onclick={() => rename(thread)}>Rename</button><button
            type="button"
            class="text-sm"
            disabled={busy}
            onclick={() => remove(thread)}>Delete</button
          >
        </div>
      {/each}
      <nav aria-label="Edits">
        <p class="font-semibold">Edits</p>
        {#each threads as thread (thread.id)}{#each thread.jobs as id (id)}<a
              class="block text-sm underline"
              href={`/chat/${thread.id}#edit-${id}`}>{thread.title} · {id.slice(0, 8)}</a
            >{/each}{/each}
      </nav>
    </aside>
    <main class="flex min-w-0 flex-1 flex-col px-3">
      <button type="button" class="self-start p-2 md:hidden" onclick={() => (drawer = !drawer)}>Threads</button>
      <p class="py-2 text-sm opacity-70">
        Find moments, select videos, edit and revise. Publish saves a Buffer draft for review.
      </p>
      {#if current?.selected.length}
        <div class="flex flex-wrap items-center gap-3 border-b py-2">
          <span>{current.selected.length} selected videos</span><button
            type="button"
            class="underline"
            disabled={busy}
            onclick={() => {
              const brief = prompt('Edit brief', 'A short reel of these moments');
              if (!brief) return;
              const length = prompt('Length in seconds (1–60)', '6');
              if (!length || !Number.isFinite(Number(length)) || Number(length) < 1 || Number(length) > 60) return;
              question = `Prepare an edit using the selected videos: ${brief}. Length ${length} seconds. Show the brief and ask for confirmation before starting.`;
              void send();
            }}>Start edit</button
          ><button
            type="button"
            class="underline"
            disabled={busy}
            onclick={() => {
              question = 'Yes';
              void send();
            }}>Confirm start edit</button
          >
        </div>
      {/if}
      <div
        bind:this={log}
        onscroll={() => {
          following = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
        }}
        role="log"
        aria-label="Chat transcript"
        class="min-h-0 flex-1 overflow-y-auto"
      >
        {#each messages as message, index (index)}
          <section
            aria-label={message.role === 'user' ? 'You' : 'hev media'}
            class="mb-4 rounded-2xl bg-immich-gray p-4 dark:bg-immich-dark-gray"
          >
            <p class="mb-2 font-semibold">{message.role === 'user' ? 'You' : 'hev media'}</p>
            <p class="whitespace-pre-wrap">{message.content || (busy ? 'Searching your library…' : '')}</p>
            {#if message.assets.length}
              <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {#each message.assets as asset (asset.id)}
                  <div>
                    <label class="block"
                      ><input
                        type="checkbox"
                        value={asset.id}
                        bind:group={selected}
                        aria-label={`Select ${asset.originalFileName ?? 'asset'}`}
                      /><img
                        class="aspect-square w-full rounded-lg object-cover"
                        src={getAssetMediaUrl({ id: asset.id })}
                        alt={asset.originalFileName ?? 'Search result'}
                        loading="lazy"
                      /></label
                    ><button type="button" class="text-sm underline" onclick={() => openPhoto(asset.id)}>Open</button>
                  </div>
                {/each}
              </div>
              <button
                type="button"
                class="mt-3 rounded-xl border p-2"
                disabled={selected.length === 0 || busy}
                onclick={useSelection}>Use in edit ({selected.length})</button
              >
            {/if}
            {#each message.jobs ?? [] as jobId (jobId)}
              {@const edit = edits.find((j) => j.id === jobId)}
              {#if edit}
                {@const revision = edit.revisions?.find((r) => r.revision === (revisions[edit.id] ?? edit.revision))}
                <article id={`edit-${edit.id}`} aria-label={`Edit ${edit.id}`} class="mt-3 rounded-xl border p-3">
                  <p>Reel · revision {edit.revision} · {edit.state}</p>
                  <p role="status">{edit.note}</p>
                  {#if edit.revisions?.length}<label
                      >Revision <select
                        value={revisions[edit.id] ?? edit.revision}
                        onchange={(e) => (revisions[edit.id] = Number(e.currentTarget.value))}
                        >{#each edit.revisions as r (r.revision)}<option value={r.revision}>{r.revision}</option
                          >{/each}</select
                      ></label
                    >{/if}
                  {#if revision?.preview || edit.preview}<video
                      controls
                      preload="metadata"
                      class="mt-2 max-h-80 rounded-lg"
                      src={revision?.preview ?? edit.preview}><track kind="captions" /></video
                    >{/if}
                  <button
                    type="button"
                    class="mr-3 underline"
                    disabled={busy || ['queued', 'editing', 'rendered'].includes(edit.state)}
                    onclick={() => revise(edit)}>Revise</button
                  >
                  {#if revision || edit.preview}
                    {@const libraryKey = edit.id + ':' + (revisions[edit.id] ?? edit.revision)}
                    {@const library = libraryBuilds[libraryKey]}
                    {#if library?.state !== 'ready'}<button
                        type="button"
                        class="underline"
                        disabled={libraryPending[libraryKey] ||
                          ['queued', 'waiting', 'building', 'ready'].includes(library?.state ?? '')}
                        onclick={() => imovie(edit)}>Open in iMovie</button
                      >{/if}
                    {#if library}
                      <p role="status" class="mt-2">{library.message}</p>
                      {#if library.state === 'ready' && library.command}
                        <a
                          class="mt-2 inline-block rounded-lg bg-primary p-2 text-on-primary"
                          href={`/hev-chat/edits/${edit.id}/imovie-library-download?revision=${revisions[edit.id] ?? edit.revision}`}
                          download>Download for iMovie</a
                        >
                        <p class="mt-2">Unzip, then double-click to open in iMovie.</p>
                        <details class="mt-2">
                          <summary>Copy laptop command</summary>
                          <p class="mt-2">Run on your laptop:</p>
                          <input
                            aria-label="iMovie laptop command"
                            readonly
                            value={library.command}
                            class="w-full rounded border p-2 font-mono"
                          />
                          <button
                            type="button"
                            class="underline"
                            onclick={() => navigator.clipboard.writeText(library.command!)}>Copy command</button
                          >
                        </details>
                      {/if}
                    {/if}
                    <a
                      class="ml-3 underline"
                      href={`/hev-chat/edits/${edit.id}/imovie-kit?revision=${revisions[edit.id] ?? edit.revision}`}
                      >Manual kit</a
                    >
                  {/if}
                  {#if revision?.bufferUrl}<a
                      class="underline"
                      href={revision.bufferUrl}
                      target="_blank"
                      rel="noreferrer">Open in Buffer</a
                    >{:else if revision}<button type="button" class="underline" onclick={() => publish(edit)}
                      >Publish</button
                    >{/if}
                </article>
              {/if}
            {/each}
          </section>
        {/each}
        {#if messages.length === 0}<p class="p-4">Start a thread by asking about your photos or videos.</p>{/if}
      </div>
      {#if !following}<button
          type="button"
          class="self-center rounded-xl border p-2"
          onclick={() => {
            following = true;
            void scrollLatest();
          }}>Jump to latest</button
        >{/if}
      {#if error}<p role="alert" class="text-red-600">{error}</p>{/if}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        class="flex shrink-0 gap-2 bg-immich-bg py-3 dark:bg-immich-dark-bg"
      >
        <label for="chat-question" class="sr-only">Ask about your photos</label>
        <input
          id="chat-question"
          bind:value={question}
          maxlength={8000}
          placeholder="Ask about your photos…"
          disabled={busy}
          class="min-w-0 flex-1 rounded-xl border bg-transparent p-3"
        />
        <button
          type="submit"
          disabled={busy || !question.trim()}
          class="rounded-xl bg-immich-primary px-4 text-white disabled:opacity-50">{busy ? 'Working…' : 'Send'}</button
        >
      </form>
    </main>
  </div>
</UserPageLayout>

{#if assetViewerManager.isViewing}
  {#await import('$lib/components/asset-viewer/AssetViewer.svelte') then { default: AssetViewer }}
    <Portal target="body">
      <AssetViewer {cursor} showNavigation={false} onClose={() => assetViewerManager.showAssetViewer(false)} />
    </Portal>
  {/await}
{/if}
