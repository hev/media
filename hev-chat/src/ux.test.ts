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

test('video titles describe the subject instead of the search action', async () => {
  const { videoTitle } = await import('./ux.js');
  assert.equal(
    videoTitle('Search for fall bike videos'),
    'Fall bike highlights',
  );
  assert.equal(
    videoTitle('Search for fall bike videos. Use bold text.'),
    'Fall bike highlights',
  );
  assert.equal(videoTitle('Fall bike highlights'), 'Fall bike highlights');
  assert.equal(
    videoTitle('/search family biking videos'),
    'Family biking highlights',
  );
});
test('confirmation is scoped to the latest pending setup and does not authorize later assent', async () => {
  const { pendingConfirmation } = await import('./ux.js');
  const thread = {
    setup: editSetup({ assetIds: ['a'] }),
    setupAfter: 2,
    messages: [{}, {}],
  };
  assert.equal(pendingConfirmation(thread, 'yes'), true);
  thread.messages.push({}, {});
  assert.equal(pendingConfirmation(thread, 'yes'), false);
  thread.setupAfter = 4;
  assert.equal(pendingConfirmation(thread, 'yes'), true);
  assert.equal(pendingConfirmation(thread, 'yes but find more'), false);
  assert.equal(
    pendingConfirmation({ setup: thread.setup, messages: [] }, 'yes'),
    false,
  );
});
test('search steps, worker history and manual titles survive reopening', async () => {
  const db = new Threads(':memory:');
  const thread = db.create('a');
  thread.messages.push({
    role: 'assistant',
    content: '',
    assets: [],
    steps: [
      {
        id: 's',
        name: 'smart',
        input: { query: 'biking', type: 'VIDEO' },
        state: 'done',
        startedAt: 10,
        elapsedMs: 20,
        before: 48,
        after: 6,
        shown: 6,
      },
    ],
  });
  thread.workers = { job: [{ stage: 'rendered', at: 100 }] };
  thread.autoTitle = false;
  thread.title = 'My own title';
  db.save('a', thread);
  db.recordWorkers('a', thread.id, { resolve: [{ stage: 'ready' }] });
  assert.equal(db.get('a', thread.id)?.title, 'My own title');
  thread.workers.resolve = [{ stage: 'ready' }];
  assert.deepEqual(db.get('a', thread.id)?.messages, thread.messages);
  assert.deepEqual(db.get('a', thread.id)?.workers, thread.workers);
  assert.equal(db.get('a', thread.id)?.autoTitle, false);
  db.db.close();
});

test('viewing legacy edits with no progress does not mutate the thread', () => {
  const db = new Threads(':memory:');
  const thread = db.create('owner', 'Existing title');
  const before = JSON.stringify(db.get('owner', thread.id));
  db.recordWorkers('owner', thread.id, { oldJob: [] });
  assert.equal(JSON.stringify(db.get('owner', thread.id)), before);
  db.db.close();
});

test('video titles strip Adam-style conversational lead-ins and retain temporal context', async () => {
  const { videoTitle } = await import('./ux.js');
  for (const [prompt, title] of [
    [
      'Lets make a family biking video highlight reel. search for videos',
      'Family biking highlights',
    ],
    [
      "Let's make a family biking video highlight reel",
      'Family biking highlights',
    ],
    [
      'Can you find skiing videos from last winter?',
      'Skiing highlights from last winter',
    ],
    ['I want a fall bike edit', 'Fall bike highlights'],
    ['Could you help me make a reel of the beach day?', 'Beach day highlights'],
    ['show me photos of grandma', 'Grandma highlights'],
    ["I'd like to create a fall bike reel", 'Fall bike highlights'],
    [
      'Could you please help me find family biking videos',
      'Family biking highlights',
    ],
    [
      'Please make a highlight reel of family skiing',
      'Family skiing highlights',
    ],
  ])
    assert.equal(videoTitle(prompt), title);
});
