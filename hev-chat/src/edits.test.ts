import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEditTool } from './edits.js';
const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const options = {
  baseUrl: 'http://immich/api',
  headers: { Authorization: 'Bearer own' },
};
const input = {
  assetIds: [id],
  brief: 'Dog reel',
  caption: 'Dogs',
  length: 12,
};
test('edit tools refuse nonadmins and require confirmation before resolving originals', async () => {
  let reads = 0;
  const api: any = {
    getMyUser: async () => ({ isAdmin: false }),
    getAssetInfo: async () => {
      reads++;
    },
  };
  await assert.rejects(
    runEditTool('start_edit', input, options, true, api),
    /administrators/,
  );
  api.getMyUser = async () => ({ isAdmin: true });
  await assert.rejects(
    runEditTool('start_edit', input, options, false, api),
    /confirm/,
  );
  assert.equal(reads, 0);
});
test('start resolves videos using caller identity and sends paths only to launcher', async () => {
  const api: any = {
    getMyUser: async () => ({ isAdmin: true }),
    getAssetInfo: async (args: any, opts: any) => {
      assert.equal(opts, options);
      assert.equal(args.id, id);
      return { id, type: 'VIDEO', originalPath: '/external/dog.mov' };
    },
  };
  const request: any = async (path: string, init: any) => {
    assert.equal(path, '/jobs');
    const body = JSON.parse(init.body);
    assert.equal(body.assets[0].originalPath, '/external/dog.mov');
    return Response.json({ id, state: 'queued' });
  };
  assert.equal(
    (await runEditTool('start_edit', input, options, true, api, request)).state,
    'queued',
  );
  api.getAssetInfo = async () => ({
    id,
    type: 'AUDIO',
    originalPath: '/external/x',
  });
  await assert.rejects(
    runEditTool('start_edit', input, options, true, api, request),
    /original photos or videos/,
  );
});
test('status and revisions validate IDs and request shape', async () => {
  const api: any = { getMyUser: async () => ({ isAdmin: true }) };
  const paths: string[] = [];
  const request: any = async (path: string) => {
    paths.push(path);
    return Response.json({ id });
  };
  await runEditTool('edit_status', { id }, options, false, api, request);
  await runEditTool(
    'revise_edit',
    { id, change: 'Shorter' },
    options,
    false,
    api,
    request,
  );
  assert.deepEqual(paths, ['/jobs/' + id, '/jobs/' + id + '/revise']);
  await assert.rejects(
    runEditTool(
      'edit_status',
      { id: '../secret' },
      options,
      false,
      api,
      request,
    ),
  );
  await assert.rejects(
    runEditTool(
      'start_edit',
      { ...input, length: 61 },
      options,
      true,
      api,
      request,
    ),
  );
});

test('status can discover existing job IDs for a later conversational revision', async () => {
  const api: any = { getMyUser: async () => ({ isAdmin: true }) };
  const request: any = async (path: string) => {
    assert.equal(path, '/jobs');
    return Response.json([{ id, state: 'drafted' }]);
  };
  assert.deepEqual(
    await runEditTool('edit_status', {}, options, false, api, request),
    [{ id, state: 'drafted' }],
  );
});

test('Resolve tool validates revision and returns the authenticated download link without publishing', async () => {
  const api: any = { getMyUser: async () => ({ isAdmin: true }) };
  const paths: string[] = [];
  const request: any = async (path: string) => {
    paths.push(path);
    return Response.json({ id, revisions: [{ revision: 2 }] });
  };
  const result = await runEditTool(
    'open_in_resolve',
    { id, revision: 2 },
    options,
    false,
    api,
    request,
  );
  assert.equal(
    result.download,
    `/hev-chat/edits/${id}/resolve-download?revision=2`,
  );
  assert.deepEqual(paths, [
    '/jobs/' + id,
    '/jobs/' + id + '/resolve?revision=2',
  ]);
  await assert.rejects(
    runEditTool(
      'open_in_resolve',
      { id, revision: 0 },
      options,
      false,
      api,
      request,
    ),
  );
  await assert.rejects(
    runEditTool(
      'open_in_resolve',
      { id, revision: 1 },
      options,
      false,
      api,
      request,
    ),
  );
  api.getMyUser = async () => ({ isAdmin: false });
  await assert.rejects(
    runEditTool(
      'open_in_resolve',
      { id, revision: 2 },
      options,
      false,
      api,
      request,
    ),
    /administrators/,
  );
});

test('browser and text Resolve requests share validated shortlist and theme extras', async () => {
  const { resolveCandidates } = await import('./edits.js');
  const calls: string[] = [];
  const api: any = {
    searchSmart: async () => ({
      assets: { items: [{ id: 'theme' }, { id: 'chosen' }] },
    }),
    getAssetInfo: async ({ id }: { id: string }) => {
      calls.push(id);
      return {
        id,
        type: 'VIDEO',
        originalPath: id === 'foreign' ? '/elsewhere/file' : '/external/' + id,
      };
    },
  };
  const result = await resolveCandidates(
    {
      selected: [
        { id: 'chosen', type: 'VIDEO' },
        { id: 'foreign', type: 'VIDEO' },
      ],
      messages: [{ assets: [{ id: 'chosen', type: 'VIDEO' }] }],
      smartQuery: 'beach',
    },
    options,
    api,
  );
  assert.deepEqual(
    result.map((a) => a.id),
    ['chosen', 'theme'],
  );
  assert.deepEqual(calls, ['chosen', 'foreign', 'theme']);
});

test('photo edits preserve chosen aspect, captions, titles and named licensed music', async () => {
  const api: any = {
    getMyUser: async () => ({ isAdmin: true }),
    getAssetInfo: async () => ({
      id,
      type: 'IMAGE',
      originalPath: '/external/photo.jpg',
    }),
  };
  await runEditTool(
    'start_edit',
    {
      ...input,
      aspectRatio: '1:1',
      captions: false,
      titles: 'Family',
      music: 'licensed.wav',
    },
    options,
    true,
    api,
    async (_path, init) => {
      const body = JSON.parse(init!.body as string);
      assert.equal(body.aspectRatio, '1:1');
      assert.equal(body.captions, false);
      assert.equal(body.titles, 'Family');
      assert.equal(body.music, 'licensed.wav');
      return Response.json({ id, state: 'queued' });
    },
  );
});
