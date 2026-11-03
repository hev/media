import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Markdown from './Markdown.svelte';
import { inlineMarkdown, markdownBlocks, safeLink } from './markdown';

describe('chat Markdown allowlist', () => {
  it('formats bold, lists, code and links without producing HTML', () => {
    expect(inlineMarkdown('**confirm** `clip` [open](https://example.com)')).toContainEqual({
      kind: 'strong',
      text: 'confirm',
    });
    expect(markdownBlocks('- one\n2. two').every((b) => b.list)).toBe(true);
    expect(inlineMarkdown('<img src=x onerror=alert(1)>')[0].kind).toBe('text');
  });
  it('rejects active protocols and omits remote images', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', '//evil.com', 'java\nscript:alert(1)'])
      expect(safeLink(url)).toBeUndefined();
    expect(
      inlineMarkdown('![tracking](https://evil.com/a)')
        .map((t) => t.text)
        .join(''),
    ).toBe('');
    expect(inlineMarkdown('[unsafe](javascript:alert(1))').find((t) => t.kind === 'link')?.href).toBeUndefined();
  });
  it('does not flash unfinished formatting while streaming', () => {
    expect(
      inlineMarkdown('Ready **conf', true)
        .map((t) => t.text)
        .join(''),
    ).toBe('Ready conf');
    expect(
      inlineMarkdown('[open](https://exa', true)
        .map((t) => t.text)
        .join(''),
    ).toBe('open');
  });
});

it('renders untrusted markup as text and never creates executable HTML or image nodes', () => {
  const { container } = render(Markdown, {
    content:
      '**confirm** <script>alert(1)</script> <img src=x onerror=alert(1)> ![remote](https://evil.example/pixel) [bad](javascript:alert(1))',
  });
  expect(container.querySelector('strong')?.textContent).toBe('confirm');
  expect(container.querySelector('script, img, iframe, a')).toBeNull();
  expect(container.textContent).toContain('<script>');
});
