export const commands = [
  'search',
  'edit',
  'revise',
  'resolve',
  'publish',
] as const;
export function parseSlash(value: string) {
  const match = value.trim().match(/^\/(\w+)(?:\s+(.*))?$/s);
  if (!match) return undefined;
  if (!commands.includes(match[1] as any)) throw Error('Unknown command');
  return { name: match[1], argument: match[2]?.trim() ?? '' };
}
export function isConfirmation(value: string) {
  return /^(?:yes|confirm(?:ed)?|go ahead|give it a go|do it|start the edit|make the reel)[,.!\s]*$/i.test(
    value.trim(),
  );
}
export type EditSetup = {
  aspectRatio: string;
  length: number;
  captions: boolean;
  titles: string;
  music: string;
  brief: string;
  assetIds: string[];
};
export function editSetup(input: any): EditSetup {
  const value = {
    aspectRatio: '9:16',
    length: 30,
    captions: true,
    titles: '',
    music: '',
    brief: 'A highlight reel of these moments',
    ...input,
  };
  if (
    !['9:16', '1:1', '16:9', '4:5'].includes(value.aspectRatio) ||
    !Number.isFinite(value.length) ||
    value.length < 1 ||
    value.length > 60 ||
    typeof value.captions !== 'boolean' ||
    !Array.isArray(value.assetIds) ||
    value.assetIds.length > 20 ||
    value.assetIds.some((id: unknown) => typeof id !== 'string') ||
    ['titles', 'music', 'brief'].some(
      (k) => typeof value[k] !== 'string' || value[k].length > 2000,
    ) ||
    !value.brief.trim()
  )
    throw Error('Invalid edit setup');
  return value;
}
export function relevantAssets(assets: any[]) {
  // CLIP cosine distances: lower is better. Refuse missing scores rather than present raw top-N as relevant.
  const ranked = assets
    .filter((a) => Number.isFinite(a.distance))
    .sort((a, b) => a.distance - b.distance);
  if (!ranked.length) return [];
  let limit = Math.min(0.78, ranked[0].distance + 0.025);
  for (let i = 3; i < ranked.length; i++)
    if (ranked[i].distance - ranked[i - 1].distance > 0.035) {
      limit = Math.min(limit, ranked[i - 1].distance);
      break;
    }
  const days = new Map<string, number>();
  return ranked
    .filter((a) => {
      if (a.distance > limit) return false;
      const day = String(a.localDateTime ?? a.fileCreatedAt ?? a.id).slice(
        0,
        10,
      );
      const count = days.get(day) ?? 0;
      if (count >= 4) return false;
      days.set(day, count + 1);
      return true;
    })
    .slice(0, 24);
}
