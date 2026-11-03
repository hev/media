// A small allowlist renderer: content is always Svelte text, never HTML.
export type Inline = { kind: 'text' | 'strong' | 'code' | 'link'; text: string; href?: string };
export function safeLink(value: string) {
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
export function inlineMarkdown(value: string, streaming = false): Inline[] {
  // Remote images are omitted, including their request-producing URL.
  value = value.replaceAll(/!\[[^\]]*\]\([^)]*\)/g, '').replaceAll(/!\[[^\]]*\]\([^)]*$/g, '');
  const tokens: Inline[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let start = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index! > start) tokens.push({ kind: 'text', text: value.slice(start, match.index) });
    if (match[1]) tokens.push({ kind: 'strong', text: match[1] });
    else if (match[2]) tokens.push({ kind: 'code', text: match[2] });
    else tokens.push({ kind: 'link', text: match[3], href: safeLink(match[4]) });
    start = match.index! + match[0].length;
  }
  let tail = value.slice(start);
  if (streaming)
    tail = tail
      .replace(/\*\*([^*]*)$/, '$1')
      .replace(/`([^`]*)$/, '$1')
      .replace(/\[([^\]]*)\]?(?:\([^)]*)?$/, '$1')
      .replace(/\*$/, '');
  tokens.push({ kind: 'text', text: tail });
  return tokens;
}
export function markdownBlocks(value: string) {
  return value.split('\n').map((line) => {
    const list = line.match(/^\s*(?:[-*+] |\d+\. )(.*)$/);
    return { list: !!list, text: list?.[1] ?? line.replace(/^#{1,6}\s+/, '') };
  });
}
