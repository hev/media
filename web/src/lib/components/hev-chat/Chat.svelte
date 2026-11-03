<script lang="ts">
  import Markdown from './Markdown.svelte';
  import WorkerProgress, { type Progress } from './WorkerProgress.svelte';
  import {
    mdiPencil,
    mdiMovieEditOutline,
    mdiDelete,
    mdiClose,
    mdiMenu,
    mdiArrowLeft,
    mdiMovieOpenOutline,
    mdiEyeOutline,
    mdiContentCopy,
  } from '@mdi/js';
  import Portal from '$lib/elements/Portal.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getAssetMediaUrl, getAssetPlaybackUrl } from '$lib/utils';
  import { getAssetInfo } from '@immich/sdk';
  import { onDestroy, onMount, tick } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';

  type Revision = {
    revision: number;
    preview: string;
    bufferUrl?: string;
    duration?: number;
    timeline?: { id?: string; duration: number }[];
  };
  type Thread = { id: string; title: string; messages: Message[]; selected: Photo[]; jobs: string[]; setup?: Setup };
  type Setup = {
    aspectRatio: string;
    length: number;
    captions: boolean;
    titles: string;
    music: string;
    brief: string;
    assetIds: string[];
  };
  let setup = $state<Setup>();
  let status = $state('');
  let visible = $state<Record<number, number>>({});
  const commands = ['search', 'edit', 'revise', 'resolve', 'publish'];
  async function saveSetup() {
    if (!current || !setup) return;
    setup.assetIds = selected;
    current = await api('/threads/' + current.id + '/setup', 'POST', setup);
  }
  async function openSetup() {
    const creating = !current;
    const target = current ?? (await api('/threads', 'POST'));
    const value = target.setup ?? {
      aspectRatio: '9:16',
      length: 30,
      captions: true,
      titles: '',
      music: '',
      brief: 'A highlight reel of these moments',
      assetIds: selected,
    };
    // /chat and /chat/[id] mount separate pages. Persist before changing route.
    const updated = await api('/threads/' + target.id + '/setup', 'POST', value);
    current = updated;
    setup = updated.setup;
    if (creating) {
      messages = updated.messages;
      selected = updated.selected.map((a: Photo) => a.id);
      edits = [];
      await list();
      await goto('/chat/' + updated.id);
    }
  }
  async function command(name: string) {
    if (name === 'edit') {
      question = '';
      await openSetup();
      return;
    }
    if (!commands.includes(name)) {
      error = 'Unknown command.';
      return;
    }
    const edit = edits.at(-1);
    if (['revise', 'resolve', 'publish'].includes(name) && !edit) {
      error = 'Start an edit first with /edit.';
      question = '';
      return;
    }
    if (name === 'revise' && edit) {
      question = '';
      await revise(edit);
      return;
    }
    if (name === 'resolve' && edit) {
      question = '';
      await resolve(edit);
      return;
    }
    if (name === 'publish' && edit) {
      question = '';
      await publish(edit);
      return;
    }
    question = '/' + name + ' ';
  }
  let threads = $state<Thread[]>([]);
  let current = $state<Thread>();
  let drawer = $state(false);
  let editDrawer = $state(false);
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
    // Set the route's state before navigation so its effect cannot race setup/send.
    current = t;
    messages = t.messages;
    selected = [];
    setup = undefined;
    edits = [];
    await list();
    await goto('/chat/' + t.id);
  }
  async function load(id: string) {
    if (busy) return;
    current = await api('/threads/' + id);
    messages = current!.messages;
    setup = current!.setup;
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
      const updated = await api('/threads/' + t.id, 'PATCH', { title });
      if (current?.id === t.id) current = updated;
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
    await openSetup();
  }
  let drafts = $state<Record<string, Setup>>({});
  function settingsFor(edit: Edit): Setup {
    return (drafts[edit.id] ??= {
      aspectRatio: '9:16',
      length: 30,
      captions: true,
      titles: '',
      music: '',
      brief: '',
      assetIds: [],
      ...edit.setup,
    });
  }
  async function reviseSettings(edit: Edit) {
    const { aspectRatio, length, captions, titles, music, brief } = settingsFor(edit);
    await api('/edits/' + edit.id + '/revise', 'POST', {
      change: brief.trim() || 'Apply the selected edit settings',
      settings: { aspectRatio, length, captions, titles, music },
    });
    delete drafts[edit.id];
    await refreshEdits();
  }
  function pauseOthers(event: Event) {
    const active = event.currentTarget;
    document.querySelectorAll('video').forEach((video) => {
      if (video !== active) video.pause();
    });
  }
  async function revise(edit: Edit) {
    const change = prompt('What should change?');
    if (change) {
      await api('/edits/' + edit.id + '/revise', 'POST', { change });
      await refreshEdits();
    }
  }
  type LibraryBuild = { state: string; message: string; command?: string; progress?: Progress[] };
  let libraryBuilds = $state<Record<string, LibraryBuild>>({});
  let libraryPending = $state<Record<string, boolean>>({});
  async function resolve(edit: Edit) {
    const revision = revisions[edit.id] ?? edit.revision;
    const key = edit.id + ':' + revision;
    libraryPending[key] = true;
    try {
      libraryBuilds[key] = await api(`/edits/${edit.id}/resolve?revision=${revision}`, 'POST');
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
        const response = await fetch(`/hev-chat/edits/${edit.id}/resolve?revision=${revision}`);
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
    progress?: Progress[];
    assets?: Photo[];
    setup?: Setup;
    timeline?: { id?: string; duration: number }[];
    duration?: number;
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
  type Photo = { id: string; originalFileName?: string; type?: string; duration?: number | null };
  type ToolStep = {
    id: string;
    name: string;
    input: Record<string, unknown>;
    state: string;
    startedAt: number;
    elapsedMs?: number;
    before?: number;
    after?: number;
    shown?: number;
  };
  type Message = { role: 'user' | 'assistant'; content: string; assets: Photo[]; jobs?: string[]; steps?: ToolStep[] };
  let messages = $state<Message[]>([]);
  let question = $state('');
  let busy = $state(false);
  let error = $state('');
  let controller: AbortController | undefined;
  onDestroy(() => controller?.abort());

  async function send() {
    if (busy || !question.trim()) return;
    if (!current) {
      current = await api('/threads', 'POST');
      messages = [];
      selected = [];
      edits = [];
    }
    const slash = question.trim().match(/^\/(\w+)(?:\s+(.*))?$/s);
    if (slash && slash[1] !== 'search') {
      await command(slash[1]);
      return;
    }
    // Saving a setup is an explicit new pending question; sending an unrelated turn must not re-arm it.
    status = 'Sending request…';
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
          case 'status': {
            status = event.message;
            break;
          }
          case 'tool': {
            messages[index].steps ??= [];
            const steps = messages[index].steps!;
            const existing = steps.findIndex((s) => s.id === event.step.id);
            if (existing === -1) steps.push(event.step);
            else steps[existing] = event.step;
            break;
          }
          case 'setup': {
            setup = event.setup;
            break;
          }
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
      status = '';
      if (current) {
        current = await api('/threads/' + current.id);
        setup = current?.setup;
      }
      await list();
      if (current && page.params.threadId !== current.id) await goto('/chat/' + current.id);
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

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape') {
      drawer = false;
      editDrawer = false;
    }
  }}
/>

<div
  class="chat-shell fixed inset-0 z-30 flex flex-col bg-immich-bg text-immich-fg dark:bg-immich-dark-bg dark:text-immich-dark-fg"
>
  <header class="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
    <a href="/photos" title="Back to library" aria-label="Back to library" class="icon-action"
      ><svg viewBox="0 0 24 24"><path d={mdiArrowLeft} /></svg></a
    >
    <button
      type="button"
      class="icon-action md:hidden"
      aria-label="Show threads"
      title="Show threads"
      onclick={() => (drawer = !drawer)}><svg viewBox="0 0 24 24"><path d={mdiMenu} /></svg></button
    >
    <h1 class="min-w-0 flex-1 truncate font-semibold">{current?.title ?? 'hev media'}</h1>
    <button
      type="button"
      class="icon-action lg:hidden"
      aria-label="Show edit details"
      title="Show edit details"
      onclick={() => (editDrawer = !editDrawer)}><svg viewBox="0 0 24 24"><path d={mdiMovieOpenOutline} /></svg></button
    >
  </header>
  <div class="relative flex min-h-0 flex-1 dark:text-immich-dark-fg">
    <aside
      class={`${drawer ? 'block' : 'hidden'} w-56 shrink-0 overflow-y-auto border-r p-3 max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-20 max-md:bg-immich-bg md:block max-md:dark:bg-immich-dark-bg`}
      aria-label="Threads"
    >
      <button
        type="button"
        class="icon-action md:hidden"
        aria-label="Close threads"
        title="Close threads"
        onclick={() => (drawer = false)}><svg viewBox="0 0 24 24"><path d={mdiClose} /></svg></button
      >
      <button type="button" class="mb-4 rounded-xl border p-3" onclick={newThread} disabled={busy}>New thread</button>
      {#each threads as thread (thread.id)}
        <div
          class={`thread-row mb-3 rounded-xl p-2 ${current?.id === thread.id ? 'bg-immich-gray dark:bg-immich-dark-gray' : ''}`}
        >
          <a
            class="thread-title underline"
            href={`/chat/${thread.id}`}
            onclick={(e) => {
              if (busy) e.preventDefault();
            }}>{thread.title}</a
          >
          <button
            type="button"
            class="icon-action"
            aria-label={`Rename ${thread.title}`}
            title="Rename video"
            onclick={() => rename(thread)}><svg viewBox="0 0 24 24"><path d={mdiPencil} /></svg></button
          ><button
            type="button"
            class="icon-action"
            title="Delete thread"
            aria-label={`Delete ${thread.title}`}
            disabled={busy}
            onclick={() => remove(thread)}><svg viewBox="0 0 24 24"><path d={mdiDelete} /></svg></button
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
      <p class="py-2 text-sm opacity-70">
        Find moments, select photos and videos, edit and revise. Publish saves a Buffer draft for review.
      </p>
      {#if edits.length}<nav aria-label="Linked edits" class="flex flex-wrap gap-3 border-b py-2">
          {#each edits as edit (edit.id)}<a class="underline" href={`#edit-${edit.id}`}
              >Edit {edit.id.slice(0, 8)} · {edit.state} · revision {edit.revision}</a
            >{/each}
        </nav>{/if}
      <button type="button" class="self-start rounded-lg border p-2" disabled={busy} onclick={openSetup}
        >Edit setup · {selected.length} selected</button
      >
      {#if setup}
        <form
          aria-label="Edit setup"
          class="my-2 grid max-h-[45dvh] shrink-0 grid-cols-2 gap-2 overflow-y-auto rounded-xl border p-3"
          onsubmit={async (e) => {
            e.preventDefault();
            await saveSetup();
            question = 'give it a go';
            await send();
          }}
        >
          <label
            >Aspect ratio <select aria-label="Aspect ratio" bind:value={setup.aspectRatio} onchange={saveSetup}
              >{#each ['9:16', '1:1', '16:9', '4:5'] as ratio (ratio)}<option>{ratio}</option>{/each}</select
            ></label
          >
          <label
            >Length (seconds) <input
              class="w-20 bg-transparent"
              type="number"
              min="1"
              max="60"
              bind:value={setup.length}
              onchange={saveSetup}
            /></label
          >
          <label><input type="checkbox" bind:checked={setup.captions} onchange={saveSetup} /> Captions</label>
          <label
            >Titles <input
              class="w-full bg-transparent"
              bind:value={setup.titles}
              onchange={saveSetup}
              maxlength={2000}
            /></label
          >
          <label class="col-span-2"
            >Brief <input
              class="w-full bg-transparent"
              bind:value={setup.brief}
              onchange={saveSetup}
              maxlength={2000}
            /></label
          >
          <label class="col-span-2"
            >Licensed music file (optional) <input
              class="w-full bg-transparent"
              bind:value={setup.music}
              onchange={saveSetup}
              maxlength={2000}
              placeholder="Leave empty for no added music"
            /></label
          >
          <p class="col-span-2">
            Shortlist: {selected.length} selected. Choose clips below. Start edit confirms these settings; you can also say
            “give it a go”.
          </p>
          <button
            class="rounded-lg border p-2"
            type="submit"
            disabled={busy || selected.length === 0 || selected.length > 20}>Start edit</button
          >
        </form>
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
            class="message mb-4 rounded-2xl p-4"
            class:user-message={message.role === 'user'}
            class:assistant-message={message.role === 'assistant'}
          >
            <p class="mb-2 font-semibold">{message.role === 'user' ? 'You' : 'hev media'}</p>
            {#each message.steps ?? [] as step (step.id)}
              <details class="my-2 rounded-xl border p-3 text-sm">
                <summary
                  >{step.name} · {step.state}{#if step.before !== undefined}
                    · {step.before} → {step.after} matches{/if}{#if step.elapsedMs !== undefined}
                    · {(step.elapsedMs / 1000).toFixed(1)}s{/if}</summary
                >
                <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  {#each Object.entries(step.input) as [key, value] (key)}<dt class="opacity-70">{key}</dt>
                    <dd class="wrap-anywhere">{typeof value === 'string' ? value : JSON.stringify(value)}</dd>{/each}
                </dl>
                {#if step.shown !== undefined}<p class="mt-2">
                    {step.shown} shown after deduplication and thread limit
                  </p>{/if}
              </details>
            {/each}
            {#if message.role === 'assistant'}<Markdown
                content={message.content}
                streaming={busy && index === messages.length - 1}
              />{:else}<p class="whitespace-pre-wrap">{message.content}</p>{/if}
            {#if message.assets.length}
              <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {#each message.assets.slice(0, visible[index] ?? 12) as asset (asset.id)}
                  <div>
                    <label class="block"
                      ><input
                        type="checkbox"
                        value={asset.id}
                        bind:group={selected}
                        aria-label={`Select ${asset.originalFileName ?? 'asset'}`}
                      />{#if asset.type === 'VIDEO'}<video
                          controls
                          muted
                          playsinline
                          preload="none"
                          onplay={pauseOthers}
                          class="aspect-square w-full rounded-lg object-contain"
                          poster={getAssetMediaUrl({ id: asset.id })}
                          src={getAssetPlaybackUrl({ id: asset.id })}><track kind="captions" /></video
                        >
                      {:else}<img
                          class="aspect-square w-full rounded-lg object-cover"
                          src={getAssetMediaUrl({ id: asset.id })}
                          alt={asset.originalFileName ?? 'Search result'}
                          loading="lazy"
                        />{/if}</label
                    ><button
                      type="button"
                      class="icon-action"
                      title="Open asset"
                      aria-label="Open asset"
                      onclick={() => openPhoto(asset.id)}
                      ><svg viewBox="0 0 24 24"><path d={mdiEyeOutline} /></svg></button
                    >
                  </div>
                {/each}
              </div>
              <p class="text-sm">
                {Math.min(visible[index] ?? 12, message.assets.length)} of {message.assets.length} matches · up to four per
                day
              </p>
              {#if message.assets.length > (visible[index] ?? 12)}<button
                  type="button"
                  class="p-2 underline"
                  onclick={() => (visible[index] = (visible[index] ?? 12) + 12)}>Show more</button
                >{/if}
              <button
                type="button"
                class="mt-3 rounded-xl border p-2"
                disabled={selected.length === 0 || selected.length > 20 || busy}
                onclick={useSelection}>Use in edit ({selected.length})</button
              >
            {/if}
            {#each message.jobs ?? [] as jobId (jobId)}
              {@const edit = edits.find((j) => j.id === jobId)}
              {#if edit}
                {@const revision = edit.revisions?.find((r) => r.revision === (revisions[edit.id] ?? edit.revision))}
                <article
                  id={`edit-${edit.id}`}
                  aria-label={`Edit ${edit.id}`}
                  class="mt-3 max-w-full min-w-0 overflow-hidden rounded-xl border p-3"
                >
                  <p>Reel · revision {edit.revision} · {edit.state}</p>
                  <p role="status">{edit.note}</p>
                  <WorkerProgress steps={edit.progress} state={edit.state} />
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
                      muted
                      playsinline
                      onplay={pauseOthers}
                      preload="metadata"
                      class="mt-2 max-h-80 rounded-lg"
                      src={revision?.preview ?? edit.preview}><track kind="captions" /></video
                    >{/if}
                  <button
                    type="button"
                    class="icon-action"
                    title="Revise edit"
                    aria-label="Revise edit"
                    disabled={busy || ['queued', 'editing'].includes(edit.state)}
                    onclick={() => revise(edit)}><svg viewBox="0 0 24 24"><path d={mdiMovieEditOutline} /></svg></button
                  >
                  {#if revision || edit.preview}
                    {@const libraryKey = edit.id + ':' + (revisions[edit.id] ?? edit.revision)}
                    {@const library = libraryBuilds[libraryKey]}
                    {#if library?.state !== 'ready'}<button
                        type="button"
                        class="underline"
                        disabled={libraryPending[libraryKey] ||
                          ['queued', 'waiting', 'building', 'ready'].includes(library?.state ?? '')}
                        onclick={() => resolve(edit)}
                        >{library?.state === 'failed' ? 'Retry Resolve build' : 'Build Resolve project'}</button
                      >{/if}
                    {#if library}
                      <p role="status" class="mt-2">{library.message}</p>
                      <WorkerProgress steps={library.progress} state={library.state} />
                      {#if library.state === 'ready' && library.command}
                        <a
                          class="text-on-primary mt-2 inline-block rounded-lg bg-primary p-2"
                          href={`hevmedia://resolve/${edit.id}/${revisions[edit.id] ?? edit.revision}`}
                          >Open in Resolve</a
                        >
                        <a
                          class="ml-2 underline"
                          href={`/hev-chat/edits/${edit.id}/resolve-download?revision=${revisions[edit.id] ?? edit.revision}`}
                          download>Download ZIP</a
                        >
                        <p class="mt-2">
                          Files land in ~/Movies/hev-video/&lt;project-name&gt;/. Install the laptop handler once to
                          open directly. Import captions.srt as subtitles.
                        </p>
                        <details class="mt-2">
                          <summary>Copy laptop command</summary>
                          <p class="mt-2">Run on your laptop:</p>
                          <input
                            aria-label="Resolve laptop command"
                            readonly
                            value={library.command}
                            class="w-full max-w-full min-w-0 rounded-sm border p-2 font-mono"
                          />
                          <button
                            type="button"
                            class="icon-action"
                            title="Copy command"
                            aria-label="Copy command"
                            onclick={() => navigator.clipboard.writeText(library.command!)}
                            ><svg viewBox="0 0 24 24"><path d={mdiContentCopy} /></svg></button
                          >
                        </details>
                      {/if}
                    {/if}
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
      {#if busy}<p role="status" class="py-2 text-sm">{status}</p>{/if}
      {#if question.startsWith('/')}<div aria-label="Slash commands" class="flex flex-wrap gap-2">
          {#each commands.filter((c) => c.startsWith(question.slice(1).split(' ', 1)[0])) as name (name)}<button
              type="button"
              class="rounded-sm border p-2"
              onclick={() => command(name)}>/{name}</button
            >{/each}
        </div>{/if}
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
    <aside
      aria-label="Edit details"
      class={`${editDrawer ? 'block' : 'hidden'} edit-sidebar w-72 shrink-0 overflow-y-auto border-l bg-immich-bg p-3 max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-20 max-lg:w-[min(340px,100%)] lg:block dark:bg-immich-dark-bg`}
    >
      <button
        type="button"
        class="icon-action lg:hidden"
        title="Close edit details"
        aria-label="Close edit details"
        onclick={() => (editDrawer = false)}><svg viewBox="0 0 24 24"><path d={mdiClose} /></svg></button
      >
      <h2 class="mb-3 font-semibold">Your edit</h2>
      {#if edits.length === 0 && !setup}<p class="text-sm opacity-70">
          Select moments from the conversation, then choose Edit setup to begin.
        </p>{/if}
      {#each edits as edit (edit.id)}
        {@const settings = settingsFor(edit)}
        {@const clips = edit.assets ?? []}
        {@const chosen = edit.revisions?.find((r) => r.revision === (revisions[edit.id] ?? edit.revision))}
        {@const timeline = chosen?.timeline ?? edit.timeline}
        {@const duration = chosen?.duration ?? edit.duration}
        {@const library = libraryBuilds[edit.id + ':' + (revisions[edit.id] ?? edit.revision)]}
        <section class="mb-5" aria-label="Edit summary">
          <p class="font-semibold">
            {clips.filter((c) => messages.flatMap((m) => m.assets).find((a) => a.id === c.id)?.type !== 'IMAGE').length} clips
            · {clips.filter((c) => messages.flatMap((m) => m.assets).find((a) => a.id === c.id)?.type === 'IMAGE')
              .length} photos · revision {edit.revision}
          </p>
          <p class="my-2 text-sm">
            {duration === undefined ? '' : `${duration.toFixed(1)}s total / `}{edit.state} · {settings?.aspectRatio ??
              '9:16'} · target {settings?.length ?? 30}s
          </p>
          <p class="text-sm">
            Captions {settings?.captions ? 'on' : 'off'}{settings?.titles ? ` · ${settings.titles}` : ''}
          </p>
          <fieldset class="my-3 grid gap-2" disabled={['queued', 'editing'].includes(edit.state)}>
            <legend>Edit settings</legend>
            <label
              >Aspect ratio <select aria-label="Sidebar aspect ratio" bind:value={settings.aspectRatio}>
                {#each ['9:16', '1:1', '4:5', '16:9'] as ratio (ratio)}<option>{ratio}</option>{/each}
              </select></label
            >
            <label
              >Target length (seconds) <input
                aria-label="Sidebar target length"
                type="number"
                min="1"
                max="60"
                bind:value={settings.length}
              /></label
            >
            <label><input type="checkbox" bind:checked={settings.captions} /> Captions</label>
            <label>Title text <input aria-label="Sidebar title text" bind:value={settings.titles} /></label>
            <label
              >Licensed music file only <input aria-label="Sidebar licensed music" bind:value={settings.music} /></label
            >
            <label
              >Revision notes / pacing <textarea aria-label="Sidebar revision notes" bind:value={settings.brief}
              ></textarea></label
            >
            <button type="button" class="rounded-lg border p-2" onclick={() => reviseSettings(edit)}
              >Revise with these settings</button
            >
          </fieldset>
          <WorkerProgress steps={edit.progress} state={edit.state} />
          {#if edit.revisions?.length}<label class="text-sm"
              >Revision <select
                aria-label="Sidebar revision"
                value={revisions[edit.id] ?? edit.revision}
                onchange={(e) => (revisions[edit.id] = Number(e.currentTarget.value))}
                >{#each edit.revisions as r (r.revision)}<option value={r.revision}>{r.revision}</option>{/each}</select
              ></label
            >{/if}
          <button
            type="button"
            class="icon-action"
            title="Revise edit"
            aria-label="Revise edit from sidebar"
            disabled={['queued', 'editing'].includes(edit.state)}
            onclick={() => revise(edit)}><svg viewBox="0 0 24 24"><path d={mdiMovieEditOutline} /></svg></button
          >
          <ol class="my-3 space-y-2">
            {#each clips as clip (clip.id)}
              {@const info = messages.flatMap((m) => m.assets).find((a) => a.id === clip.id)}
              <li class="flex items-center gap-2">
                <img
                  class="h-12 w-16 rounded-sm object-cover"
                  src={getAssetMediaUrl({ id: clip.id })}
                  alt="Edit source"
                /><span class="min-w-0 text-sm"
                  ><span class="block truncate">{info?.originalFileName ?? 'Selected moment'}</span>{info?.type ===
                  'IMAGE'
                    ? 'Photo'
                    : info?.duration
                      ? `${(info.duration / 1000).toFixed(1)}s source`
                      : 'Video'}{#if timeline?.some((c) => c.id === clip.id)}
                    · {timeline
                      .filter((c) => c.id === clip.id)
                      .reduce((sum, c) => sum + c.duration, 0)
                      .toFixed(1)}s in edit{/if}</span
                >
              </li>
            {/each}
          </ol>
          <button
            type="button"
            class="rounded-lg border p-2 text-sm"
            disabled={['queued', 'editing'].includes(edit.state) ||
              ['queued', 'building', 'ready'].includes(library?.state ?? '')}
            onclick={() => resolve(edit)}
            >{library?.state === 'failed' ? 'Retry Resolve build' : 'Build Resolve project'}</button
          >
          {#if library?.state === 'ready'}<a
              class="my-2 block underline"
              href={`hevmedia://resolve/${edit.id}/${revisions[edit.id] ?? edit.revision}`}>Open in Resolve</a
            >
            <p class="text-sm">Files land in ~/Movies/hev-video/&lt;project-name&gt;/.</p>
            <a
              class="my-2 block underline"
              href={`/hev-chat/edits/${edit.id}/resolve-download?revision=${revisions[edit.id] ?? edit.revision}`}
              download>Download ZIP</a
            >{/if}
          {#if library}<WorkerProgress steps={library.progress} state={library.state} />
            <p class="text-sm">{library.message}</p>{/if}
        </section>
      {/each}
      {#if setup}<p class="text-sm">
          Setup: {selected.length} selected · {setup.aspectRatio} · {setup.length}s · captions {setup.captions
            ? 'on'
            : 'off'}
        </p>{/if}
    </aside>
  </div>
</div>

{#if assetViewerManager.isViewing}
  {#await import('$lib/components/asset-viewer/AssetViewer.svelte') then { default: AssetViewer }}
    <Portal target="body">
      <AssetViewer {cursor} showNavigation={false} onClose={() => assetViewerManager.showAssetViewer(false)} />
    </Portal>
  {/await}
{/if}

<style>
  .thread-row {
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .thread-title {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .thread-row .icon-action {
    flex-shrink: 0;
  }
  fieldset input:not([type='checkbox']),
  fieldset textarea,
  fieldset select {
    max-width: 100%;
    width: 100%;
    border: 1px solid #8886;
    border-radius: 0.4rem;
    padding: 0.3rem;
  }

  @layer components {
    .icon-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.5rem;
      height: 2.5rem;
      border-radius: 0.65rem;
    }
  }
  .icon-action:hover {
    background: #8882;
  }
  .icon-action svg {
    width: 1.2rem;
    height: 1.2rem;
    fill: currentColor;
  }
  .icon-action:focus-visible,
  button:focus-visible,
  a:focus-visible {
    outline: 2px solid var(--hev-signal, #e25822);
    outline-offset: 2px;
  }
  .user-message {
    margin-left: 12%;
    background: #f6e5d7;
    border-right: 3px solid #c2451b;
  }
  .assistant-message {
    margin-right: 4%;
    background: #f4f0e6;
    border-left: 3px solid #8885;
  }
  :global(.dark) .user-message {
    background: #431f16;
    border-right-color: #eaa276;
  }
  :global(.dark) .assistant-message {
    background: #242421;
  }
  .message {
    min-width: 0;
    overflow-wrap: anywhere;
  }
</style>
