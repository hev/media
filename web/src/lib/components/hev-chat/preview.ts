// Sizing for reel and clip previews in chat.
//
// A preview gets an explicit aspect ratio and a width derived from a height cap, so its box always
// matches the media (9:16, 1:1, 16:9, 4:5, ...) and never depends on how much room the surrounding
// flex column happens to have. Before metadata loads, the ratio comes from the edit's settings; once
// the video reports its natural size, that wins.

/** Tallest a preview may be: a phone-sized reel on desktop, and well under half a short viewport. */
export const PREVIEW_MAX_HEIGHT = 'min(20rem, 40dvh)';

/** Parses an "W:H" aspect-ratio setting into width ÷ height, or undefined if it isn't one. */
export function ratioOf(setting?: string | null): number | undefined {
  if (!setting) return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(setting);
  const ratio = match ? Number(match[1]) / Number(match[2]) : NaN;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : undefined;
}

/** The natural ratio a loaded video reports, or undefined before metadata. */
export function mediaRatio(video: HTMLVideoElement): number | undefined {
  return video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : undefined;
}

/** Inline style for a preview box of the given width ÷ height ratio. */
export function previewStyle(ratio: number, maxHeight = PREVIEW_MAX_HEIGHT): string {
  const r = Number((Number.isFinite(ratio) && ratio > 0 ? ratio : 9 / 16).toFixed(5));
  return `aspect-ratio: ${r}; width: min(100%, calc(${maxHeight} * ${r})); height: auto; max-height: none`;
}
