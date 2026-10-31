import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Shortlists } from './shortlist.js';
test('detail reads preserve the previous displayed shortlist and its metadata', () => {
  const lists = new Shortlists();
  lists.remember('alice', [
    { id: 'one', type: 'VIDEO' },
    { id: 'two', type: 'VIDEO' },
  ]);
  const shown = lists.get('alice');
  lists.remember('alice', [{ id: 'two', originalFileName: 'dog.mov' }]);
  assert.equal(lists.get('alice').length, 2);
  assert.equal(lists.get('alice')[1].originalFileName, 'dog.mov');
  assert.equal(
    lists.consume('alice', shown, ['one', 'two'], 'Yes', true),
    true,
  );
  assert.equal(lists.consume('alice', shown, ['one'], 'Yes', true), false);
});
test('confirmation cannot approve a new search, another session, or a negated confirmation', () => {
  const lists = new Shortlists();
  lists.remember('alice', [{ id: 'one' }]);
  const shown = lists.get('alice');
  lists.remember('alice', [{ id: 'new' }]);
  assert.equal(lists.consume('alice', shown, ['new'], 'Yes', true), false);
  assert.equal(lists.consume('bob', shown, ['one'], 'Yes', true), false);
  assert.equal(lists.consume('alice', shown, ['one'], 'not yes', true), false);
  assert.equal(lists.consume('alice', shown, ['one'], 'Yes', false), false);
});
