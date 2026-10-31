<script lang="ts">
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { getAssetInfo } from '@immich/sdk';
  import { onDestroy } from 'svelte';

  type Photo = { id: string; originalFileName?: string };
  type Message = { role: 'user' | 'assistant'; content: string; assets: Photo[] };
  let messages = $state<Message[]>([]);
  let question = $state('');
  let busy = $state(false);
  let error = $state('');
  let controller: AbortController | undefined;
  onDestroy(() => controller?.abort());

  async function send() {
    if (busy || !question.trim()) return;
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
        body: JSON.stringify({ messages: history }),
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
        if (chunk.done) break;
      }
      consume(pending);
      if (!done) throw new Error('The response ended early. Please try again.');
    } catch (error_) {
      error = error_ instanceof Error ? error_.message : 'Chat is unavailable.';
    } finally {
      busy = false;
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
  <div class="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 pb-8 dark:text-immich-dark-fg">
    <p>Find moments in your library. Try “photos with a dog” or ask about a place or date.</p>
    <p class="text-sm opacity-70">
      Your question and matching photo metadata are sent to Anthropic. Original photos stay in Immich.
    </p>
    <div role="log" aria-label="Chat transcript" class="flex flex-col gap-5">
      {#each messages as message, index (index)}
        <section
          aria-label={message.role === 'user' ? 'You' : 'hev media'}
          class="rounded-2xl bg-immich-gray p-4 dark:bg-immich-dark-gray"
        >
          <p class="mb-2 text-sm font-semibold">{message.role === 'user' ? 'You' : 'hev media'}</p>
          <p class="whitespace-pre-wrap">{message.content || (busy ? 'Searching your library…' : '')}</p>
          {#if message.assets.length}
            <div class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {#each message.assets as asset (asset.id)}
                <button
                  type="button"
                  class="overflow-hidden rounded-xl focus:outline-2 focus:outline-immich-primary"
                  onclick={() => openPhoto(asset.id)}
                  aria-label={`Open ${asset.originalFileName ?? 'photo'}`}
                >
                  <img
                    class="aspect-square w-full object-cover"
                    src={getAssetMediaUrl({ id: asset.id })}
                    alt={asset.originalFileName ?? 'Search result'}
                    loading="lazy"
                  />
                </button>
              {/each}
            </div>
          {/if}
        </section>
      {/each}
    </div>
    {#if error}<p role="alert" class="text-red-600 dark:text-red-300">{error}</p>{/if}
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      class="flex flex-wrap gap-2"
    >
      <label for="chat-question" class="sr-only">Ask about your photos</label>
      <input
        id="chat-question"
        bind:value={question}
        maxlength={8000}
        placeholder="Ask about your photos…"
        disabled={busy}
        class="min-w-0 flex-1 rounded-xl border border-immich-primary/30 bg-immich-bg p-3 dark:bg-immich-dark-bg"
      />
      <button
        type="submit"
        disabled={busy || !question.trim()}
        class="rounded-xl bg-immich-primary px-5 py-3 text-white disabled:opacity-50 dark:bg-immich-dark-primary dark:text-immich-dark-bg"
        >{busy ? 'Searching…' : 'Send'}</button
      >
    </form>
  </div>
</UserPageLayout>

{#if assetViewerManager.isViewing}
  {#await import('$lib/components/asset-viewer/AssetViewer.svelte') then { default: AssetViewer }}
    <Portal target="body">
      <AssetViewer {cursor} showNavigation={false} onClose={() => assetViewerManager.showAssetViewer(false)} />
    </Portal>
  {/await}
{/if}
