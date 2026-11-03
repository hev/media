import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editSetup, isConfirmation, parseSlash, relevantAssets } from './ux.js';
import { Threads } from './threads.js';
test('natural confirmations accept clear assent and reject negation or embedded assent', () => {
  for (const text of ['give it a go', 'Yes!', 'do it', 'confirm', 'go ahead.'])
    assert.ok(isConfirmation(text));
  for (const text of [
    'do not do it',
    'not yes',
    'maybe',
    'yes but change everything',
    '',
  ])
    assert.ok(!isConfirmation(text));
});
test('slash parsing keeps arguments and refuses unknown tools', () => {
  assert.deepEqual(parseSlash('/search kids at the beach'), {
    name: 'search',
    argument: 'kids at the beach',
  });
  assert.deepEqual(parseSlash('/edit'), { name: 'edit', argument: '' });
  assert.equal(parseSlash('a /search'), undefined);
  assert.throws(() => parseSlash('/delete'));
});
test('relevance removes weak matches, groups days, preserves rank and bounds result size', () => {
  const assets = Array.from({ length: 80 }, (_, i) => ({
    id: String(i),
    distance: i < 8 ? 0.65 + i * 0.002 : 0.85,
    localDateTime: '2025-08-' + String(7 + Math.floor(i / 4)).padStart(2, '0'),
  }));
  assert.deepEqual(
    relevantAssets(assets).map((a) => a.id),
    ['0', '1', '2', '3', '4', '5', '6', '7'],
  );
  assert.equal(relevantAssets([{ id: 'missing' }]).length, 0);
  assert.equal(
    relevantAssets(assets.map((a) => ({ ...a, localDateTime: '2025-08-07' })))
      .length,
    4,
  );
});
test('edit setup persists exact settings per owner and validates input', () => {
  const db = new Threads(':memory:');
  const thread = db.create('alice');
  thread.setup = editSetup({
    aspectRatio: '1:1',
    length: 12,
    captions: false,
    titles: 'Family',
    music: '',
    assetIds: ['a'],
  });
  db.save('alice', thread);
  assert.deepEqual(db.get('alice', thread.id)?.setup, thread.setup);
  assert.equal(db.get('bob', thread.id), undefined);
  for (const input of [
    { aspectRatio: '3:2' },
    { length: 0 },
    { captions: 'yes' },
    { assetIds: ['a', 1] },
  ])
    assert.throws(() => editSetup(input));
  db.db.close();
});
