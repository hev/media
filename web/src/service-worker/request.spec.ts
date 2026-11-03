import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleFetch } from './request';

describe('original video requests', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches each byte range independently, preserving the range header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('first', { status: 206 }))
      .mockResolvedValueOnce(new Response('last', { status: 206 }));
    vi.stubGlobal('fetch', fetchMock);
    const first = new Request('https://media.test/api/assets/video/original', { headers: { Range: 'bytes=0-4' } });
    const last = new Request(first.url, { headers: { Range: 'bytes=100-103' } });

    const responses = await Promise.all([handleFetch(first), handleFetch(last)]);

    expect(fetchMock).toHaveBeenNthCalledWith(1, first);
    expect(fetchMock).toHaveBeenNthCalledWith(2, last);
    expect(await responses[0].text()).toBe('first');
    expect(await responses[1].text()).toBe('last');
  });

  it('does not retain a full video response for later requests', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('full'))
      .mockResolvedValueOnce(new Response('new stream'));
    vi.stubGlobal('fetch', fetchMock);
    const request = new Request('https://media.test/api/assets/video/original');
    Object.defineProperty(request, 'destination', { value: 'video' });

    const first = await handleFetch(request);
    const next = await handleFetch(request);
    expect(await first.text()).toBe('full');
    expect(await next.text()).toBe('new stream');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
