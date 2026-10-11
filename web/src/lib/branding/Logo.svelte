<script lang="ts">
  interface Props {
    variant?: 'inline' | 'icon' | 'logo' | 'stacked' | 'stacked-futo';
    size?: 'tiny' | 'small' | 'medium' | 'large' | 'giant' | 'landing';
    class?: string;
  }

  let { variant = 'inline', size = 'medium', class: className = '' }: Props = $props();
  const sizes = { tiny: 32, small: 40, medium: 48, large: 64, giant: 96, landing: 256 };
</script>

<span
  class="hev-brand {className}"
  class:hev-brand-stacked={variant === 'stacked' || variant === 'stacked-futo'}
  style:--hev-logo-size="{sizes[size]}px"
  role="img"
  aria-label="hev media"
>
  <img src="/brand/hev-camera.png" alt="" width={sizes[size]} height={sizes[size]} draggable="false" />
  {#if variant !== 'icon' && variant !== 'logo'}
    <span class="hev-wordmark">hev <span class="hev-slash">/</span> media</span>
  {/if}
</span>

<style>
  .hev-brand {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    gap: 0.625rem;
    height: var(--hev-logo-size);
    color: var(--immich-ui-dark);
  }

  .hev-brand img {
    height: 100%;
    width: auto;
    aspect-ratio: 1;
    image-rendering: pixelated;
    border-radius: 2px;
  }

  .hev-wordmark {
    font-family: 'JetBrains Mono', monospace;
    font-size: 1.125rem;
    letter-spacing: -0.055em;
    white-space: nowrap;
  }

  .hev-slash {
    color: #e25822;
  }

  .hev-brand-stacked {
    height: auto;
    flex-direction: column;
  }

  .hev-brand-stacked img {
    height: var(--hev-logo-size);
  }
</style>
