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
    type: 'IMAGE',
    originalPath: '/external/x',
  });
  await assert.rejects(
    runEditTool('start_edit', input, options, true, api, request),
    /original videos/,
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

test('iMovie tool validates revision and returns the authenticated download link without publishing', async () => {
  const api: any = { getMyUser: async () => ({ isAdmin: true }) };
  const paths: string[] = [];
  const request: any = async (path: string) => {
    paths.push(path);
    return Response.json({ id, revisions: [{ revision: 2 }] });
  };
  const result = await runEditTool(
    'open_in_imovie',
    { id, revision: 2 },
    options,
    false,
    api,
    request,
  );
  assert.equal(result.download, `/hev-chat/edits/${id}/imovie-kit?revision=2`);
  assert.deepEqual(paths, ['/jobs/' + id]);
  await assert.rejects(
    runEditTool(
      'open_in_imovie',
      { id, revision: 0 },
      options,
      false,
      api,
      request,
    ),
  );
  await assert.rejects(
    runEditTool(
      'open_in_imovie',
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
      'open_in_imovie',
      { id, revision: 2 },
      options,
      false,
      api,
      request,
    ),
    /administrators/,
  );
});
