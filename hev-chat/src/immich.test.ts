import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  requireSession,
  runTool,
  sessionOptions,
  summarizeResult,
  tools,
} from './immich.js';

test('missing and malformed sessions are rejected; cookie and bearer forward only the token', () => {
  assert.throws(() => sessionOptions({}, 'http://immich/api'));
  assert.throws(() =>
    sessionOptions({ cookie: 'immich_access_token=%XX' }, 'http://immich/api'),
  );
  assert.deepEqual(
    sessionOptions(
      { cookie: 'other=secret; immich_access_token=abc%3D' },
      'http://immich/api',
    ).headers,
    { Authorization: 'Bearer abc=' },
  );
  assert.equal(
    sessionOptions({ authorization: 'Bearer own-token' }, 'http://immich/api')
      .headers.Authorization,
    'Bearer own-token',
  );
});

test('session validation calls Immich and rejects expired tokens', async () => {
  const server = createServer((req, res) => {
    assert.equal(req.url, '/api/users/me');
    if (req.headers.authorization === 'Bearer valid')
      res.setHeader('Content-Type', 'application/json').end('{"id":"user"}');
    else res.writeHead(401).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  try {
    await requireSession(
      { authorization: 'Bearer valid' },
      `http://127.0.0.1:${address.port}/api`,
    );
    await assert.rejects(
      requireSession(
        { authorization: 'Bearer expired' },
        `http://127.0.0.1:${address.port}/api`,
      ),
    );
  } finally {
    server.close();
  }
});

test('all seven tools call only their SDK read operation with isolated caller options', async () => {
  const calls: any[] = [];
  const api = new Proxy(
    {},
    {
      get:
        (_, method) =>
        async (...args: any[]) => {
          calls.push([method, ...args]);
          return {};
        },
    },
  ) as any;
  const options = sessionOptions(
    { authorization: 'Bearer alice' },
    'http://immich/api',
  );
  const inputs = [
    { query: 'dogs' },
    { city: 'Denver' },
    { name: 'Adam' },
    { name: 'Denver' },
    { type: 'city' },
    {},
    { id: 'asset' },
  ];
  for (let i = 0; i < tools.length; i++)
    await runTool(tools[i].name, inputs[i], options, api);
  assert.deepEqual(
    calls.map((call) => call[0]),
    [
      'searchSmart',
      'searchAssets',
      'searchPerson',
      'searchPlaces',
      'getSearchSuggestions',
      'getAssetStatistics',
      'getAssetInfo',
    ],
  );
  assert.ok(calls.every((call) => call.at(-1) === options));
  assert.equal(calls[0][1].smartSearchDto.size, 40);
  const bob = sessionOptions(
    { authorization: 'Bearer bob' },
    'http://immich/api',
  );
  await runTool('statistics', {}, bob, api);
  assert.equal(calls.at(-1).at(-1).headers.Authorization, 'Bearer bob');
  assert.equal(options.headers.Authorization, 'Bearer alice');
});

test('mutation names and extra or mistyped arguments cannot reach the SDK', async () => {
  for (const [name, args] of [
    ['deleteAsset', {}],
    ['smart', { query: 'dogs', size: 100000 }],
    ['smart', {}],
    ['metadata', { personIds: [12] }],
    ['suggestions', { type: 'invalid' }],
  ] as const) {
    await assert.rejects(
      runTool(
        name,
        args,
        sessionOptions({ authorization: 'Bearer token' }, 'http://immich/api'),
      ),
    );
  }
  assert.deepEqual(
    summarizeResult('person', [
      { id: 'p', name: 'Adam', thumbnailPath: '/private' },
    ]),
    [{ id: 'p', name: 'Adam' }],
  );
  assert.deepEqual(
    summarizeResult('get_asset', {
      id: 'a',
      originalPath: '/private',
      exifInfo: { gps: 1 },
    }),
    {
      assets: [
        {
          id: 'a',
          originalFileName: undefined,
          localDateTime: undefined,
          type: undefined,
        },
      ],
    },
  );
});

test('statistics returns separate photo and video counts to the model with caller identity', async () => {
  const options = sessionOptions(
    { authorization: 'Bearer alice' },
    'http://immich/api',
  );
  const counts = { images: 4200, videos: 466, total: 4666 };
  const api = {
    getAssetStatistics: async (args: unknown, caller: unknown) => {
      assert.deepEqual(args, {});
      assert.equal(caller, options);
      return counts;
    },
  } as any;
  const result = await runTool('statistics', {}, options, api);
  assert.deepEqual(result, counts);
  assert.deepEqual(summarizeResult('statistics', result), counts);
  assert.match(
    tools.find((tool) => tool.name === 'statistics')!.description,
    /images.*videos.*total/,
  );
});
