import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, build } from './imovie-project.mjs';

test('plan preserves repeated-source order and nonzero trims', () => {
  const clips = plan({ clips: [
    { src: 'same.mp4', in: 5, out: 8 },
    { src: 'same.mp4', in: 1, out: 3, audio: false },
  ] });
  assert.deepEqual(clips.map(c => [c.start, c.duration, c.sourceIn, c.audio]),
    [[0, 3, 5, true], [3, 2, 1, false]]);
  assert.notEqual(clips[0].asset, clips[1].asset);
});
test('plan rejects empty timelines and invalid trims', () => {
  for (const clips of [[], [{ src: 'x', in: -1, out: 2 }],
    [{ src: 'x', in: 2, out: 2 }], [{ src: 'x', in: 0, out: Infinity }]]) {
    assert.throws(() => plan({ clips }));
  }
});
test('build requires explicit experimental opt-in before reading media', async () => {
  await assert.rejects(build('nonexistent.json', '/tmp/test.iMovieMobile'), /Unverified format/);
});
