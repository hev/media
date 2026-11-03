<script lang="ts">
  import { inlineMarkdown, markdownBlocks } from './markdown';
  let { content, streaming = false }: { content: string; streaming?: boolean } = $props();
</script>

<div class="markdown">
  {#each markdownBlocks(content) as block, index (index)}
    <div class:list={block.list} class="line">
      {#if block.list}<span aria-hidden="true">• </span>{/if}
      <span
        >{#each inlineMarkdown(block.text, streaming) as token, i (i)}{#if token.kind === 'strong'}<strong
              >{token.text}</strong
            >{:else if token.kind === 'code'}<code>{token.text}</code>{:else if token.kind === 'link' && token.href}<a
              href={token.href}
              target="_blank"
              rel="noopener noreferrer">{token.text}</a
            >{:else}{token.text}{/if}{/each}</span
      >
    </div>
  {/each}
</div>

<style>
  .markdown {
    overflow-wrap: anywhere;
    line-height: 1.6;
  }
  .line {
    min-height: 0.65em;
    white-space: pre-wrap;
  }
  .list {
    display: flex;
    gap: 0.35rem;
    padding-left: 0.75rem;
  }
  a {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  code {
    background: #8882;
    border-radius: 0.25rem;
    padding: 0.1rem 0.3rem;
    font-size: 0.9em;
  }
</style>
