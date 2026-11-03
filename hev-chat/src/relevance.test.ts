import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rerank } from './relevance.js';
test('local ML string vectors and authenticated thumbnails yield distance-filtered results', async () => {
  const original = globalThis.fetch;
  let image = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).endsWith('/predict')) {
      const form = init.body as FormData;
      return Response.json({
        clip: JSON.stringify(
          form.has('text') ? [1, 0] : ++image === 1 ? [0.8, 0.6] : [0, 1],
        ),
      });
    }
    assert.equal(init.headers.Authorization, 'Bearer alice');
    return new Response(new Blob(['thumbnail']));
  }) as typeof fetch;
  try {
    const result = await rerank(
      'biking',
      [{ id: 'score-a' }, { id: 'score-b' }],
      {
        baseUrl: 'http://immich/api',
        headers: { Authorization: 'Bearer alice' },
      },
    );
    assert.deepEqual(
      result.map((a) => a.id),
      ['score-a'],
    );
    assert.ok(Math.abs(result[0].distance - 0.2) < 1e-8);
  } finally {
    globalThis.fetch = original;
  }
});
