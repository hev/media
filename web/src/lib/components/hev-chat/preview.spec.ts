import { render } from '@testing-library/svelte';
import type { ComponentProps } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import ClipsCard from './ClipsCard.svelte';
import { mediaRatio, PREVIEW_MAX_HEIGHT, previewStyle, ratioOf } from './preview';

// $lib/utils pulls in the app's UI managers; the card only needs the playback URL.
vi.mock('$lib/utils', () => ({ getAssetPlaybackUrl: ({ id }: { id: string }) => `/api/assets/${id}/video/playback` }));

describe('chat preview sizing', () => {
  it('reads every edit aspect ratio setting', () => {
    expect(ratioOf('9:16')).toBeCloseTo(9 / 16);
    expect(ratioOf('1:1')).toBe(1);
    expect(ratioOf('16:9')).toBeCloseTo(16 / 9);
    expect(ratioOf('4:5')).toBeCloseTo(4 / 5);
    for (const bad of [undefined, null, '', 'tall', '0:1', '1:0', '16x9']) expect(ratioOf(bad)).toBeUndefined();
  });

  it('sizes the box from the ratio and a height cap, never from the surrounding column', () => {
    for (const [setting, ratio] of [
      ['9:16', 0.5625],
      ['1:1', 1],
      ['16:9', 1.77778],
      ['4:5', 0.8],
    ] as const) {
      const style = previewStyle(ratioOf(setting)!);
      expect(style).toContain(`aspect-ratio: ${ratio};`);
      expect(style).toContain(`width: min(100%, calc(${PREVIEW_MAX_HEIGHT} * ${ratio}));`);
      expect(style).toContain('height: auto');
    }
    expect(previewStyle(NaN)).toContain('aspect-ratio: 0.5625;');
  });

  it('prefers the natural size once a video has metadata', () => {
    expect(mediaRatio({ videoWidth: 1080, videoHeight: 1920 } as HTMLVideoElement)).toBeCloseTo(9 / 16);
    expect(mediaRatio({ videoWidth: 0, videoHeight: 0 } as HTMLVideoElement)).toBeUndefined();
  });

  it('gives the clips player an explicit ratio and leaves scrolling to the pinned pane', () => {
    const clips: ComponentProps<typeof ClipsCard>['clips'] = {
      assetId: 'asset',
      steer: '',
      count: 1,
      state: 'ready',
      message: '1 candidate',
      aspectRatio: '9:16',
      captions: true,
      candidates: [{ id: 'c1', start: 10, end: 40, title: 'One', quote: 'q', why: '', selected: true }],
    };
    const { container } = render(ClipsCard, {
      threadId: 't',
      clips,
      edits: [],
      busy: false,
      onMake: async () => {},
      onOpen: () => {},
    });
    const card = container.querySelector('section[aria-label="Clips"]')!;
    expect(card.className).not.toMatch(/max-h|overflow/);
    const player = container.querySelector<HTMLVideoElement>('video[aria-label="Clip preview"]')!;
    expect(player.getAttribute('style')).toContain('aspect-ratio: 1.77778');
    expect(player.className).toContain('hidden');
    expect(player.className).not.toMatch(/max-h-/);
  });
});
