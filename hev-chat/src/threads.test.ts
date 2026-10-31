import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Threads } from './threads.js';
test('threads persist ordered transcript, selections and job ownership across sessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'threads-'));
  try {
    const a = new Threads(join(dir, 'db'));
    const first = a.create('A');
    const second = a.create('A');
    const other = a.create('B');
    first.messages = [
      { role: 'user', content: 'first', assets: [] },
      { role: 'assistant', content: 'second', assets: [], jobs: ['job'] },
      { role: 'user', content: 'third', assets: [] },
    ];
    first.selected = [{ id: 'asset' }];
    a.save('A', first);
    a.claim('A', first, 'job');
    assert.equal(a.get('B', first.id), undefined);
    assert.equal(a.get('A', other.id), undefined);
    assert.throws(() => a.save('B', first));
    assert.throws(() => a.claim('B', other, 'job'));
    a.delete('B', first.id);
    const reopened = new Threads(join(dir, 'db'));
    assert.deepEqual(
      reopened.get('A', first.id)?.messages.map((m) => m.content),
      ['first', 'second', 'third'],
    );
    assert.deepEqual(reopened.get('A', first.id)?.selected, [{ id: 'asset' }]);
    assert.equal(reopened.owns('A', first.id, 'job'), true);
    assert.equal(reopened.owns('A', second.id, 'job'), false);
    assert.equal(reopened.list('B').length, 1);
    reopened.db.close();
    a.db.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
