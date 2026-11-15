import { test } from 'node:test';
import { editSetup } from './ux.js';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const listen = (s: Server) =>
  new Promise<number>((resolve) =>
    s.listen(0, '127.0.0.1', () => resolve((s.address() as any).port)),
  );
test('HTTP threads authenticate and isolate owners for reads, changes, deletion and jobs', async () => {
  const upstream = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.startsWith('/assets/')) {
      res.end(
        JSON.stringify({
          id: req.url.split('/')[2],
          ownerId: req.url.includes('bbbbbbbb') ? 'B' : 'A',
          type: 'IMAGE',
          originalFileName: 'user-added.jpg',
        }),
      );
      return;
    }

    res.end(
      JSON.stringify({
        id: req.headers.authorization?.slice(7),
        isAdmin: false,
      }),
    );
  });
  const upstreamPort = await listen(upstream);
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise<void>((r) => reservation.close(() => r()));
  const dir = mkdtempSync(join(tmpdir(), 'threads-http-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      IMMICH_URL: `http://127.0.0.1:${upstreamPort}`,
      ANTHROPIC_API_KEY: 'test-only',
      HEV_CHAT_DATA: dir,
    },
    stdio: 'ignore',
  });
  const closed = new Promise((r) => child.on('close', r));
  const url = `http://127.0.0.1:${port}`;
  const request = (
    owner: string,
    path: string,
    method = 'GET',
    body?: object,
  ) =>
    fetch(url + path, {
      method,
      headers: {
        Authorization: `Bearer ${owner}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    const until = Date.now() + 10000;
    while (true) {
      try {
        if ((await fetch(url + '/health')).ok) break;
      } catch {}
      if (Date.now() > until) throw Error('Server did not become ready');
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal((await fetch(url + '/threads')).status, 401);
    const created = await request('A', '/threads', 'POST');
    assert.equal(created.status, 200);
    const thread = (await created.json()) as any;
    assert.equal((await request('B', '/threads/' + thread.id)).status, 404);
    assert.equal(
      (
        await request('B', '/threads/' + thread.id, 'PATCH', {
          title: 'stolen',
        })
      ).status,
      404,
    );
    assert.equal(
      (await request('B', '/threads/' + thread.id, 'DELETE')).status,
      404,
    );
    assert.equal(
      (await request('B', '/threads/' + thread.id + '/edits')).status,
      404,
    );
    assert.deepEqual(await (await request('B', '/threads')).json(), []);
    assert.equal(
      (
        await request('A', '/threads/' + thread.id, 'PATCH', {
          title: 'Renamed',
        })
      ).status,
      200,
    );
    assert.equal(
      ((await (await request('A', '/threads/' + thread.id)).json()) as any)
        .title,
      'Renamed',
    );
    assert.equal(
      (
        await request('A', '/threads/' + thread.id + '/selection', 'POST', {
          ids: ['foreign'],
        })
      ).status,
      400,
    );
    const own = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      foreign = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    assert.equal(
      (
        await request('B', '/threads/' + thread.id + '/assets', 'POST', {
          ids: [own],
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await request('A', '/threads/' + thread.id + '/assets', 'POST', {
          ids: [own, foreign],
        })
      ).status,
      403,
    );
    assert.equal(
      ((await (await request('A', '/threads/' + thread.id)).json()) as any)
        .messages.length,
      0,
    );
    assert.equal(
      (
        await request('A', '/threads/' + thread.id + '/assets', 'POST', {
          ids: [own],
        })
      ).status,
      200,
    );
    const added = (await (
      await request('A', '/threads/' + thread.id)
    ).json()) as any;
    assert.equal(added.messages[0].content, 'Added from library');
    assert.equal(added.messages[0].assets[0].id, own);
    await request('A', '/threads/' + thread.id, 'DELETE');
    assert.equal((await request('A', '/threads/' + thread.id)).status, 404);
  } finally {
    child.kill();
    await closed;
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true });
  }
});

test('/open ready, building and no edit; downloads enforce admin and ownership including Range; setup starts exactly once', async () => {
  const { Threads } = await import('./threads.js');
  const id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const dir = mkdtempSync(join(tmpdir(), 'kit-http-'));
  const db = new Threads(join(dir, 'threads.sqlite'));
  const thread = db.create('owner');
  db.claim('owner', thread, id);
  thread.messages.push({
    role: 'user',
    content: 'make a vertical video no text 18 seconds',
    assets: [{ id, type: 'VIDEO' }],
  });
  thread.setup = editSetup({ assetIds: [] }); // Recover legacy empty saved cards.
  db.save('owner', thread);
  db.db.close();
  const upstream = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.startsWith('/assets/')) {
      res.end(
        JSON.stringify({
          id,
          type: 'VIDEO',
          originalPath: '/external/test.mov',
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        id: req.headers.authorization?.slice(7),
        isAdmin: req.headers.authorization !== 'Bearer viewer',
      }),
    );
  });
  let builds = 0;
  let starts = 0;
  let libraryState = 'queued';
  const launcher = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer launcher-secret');
    if (req.url === '/jobs' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      assert.equal(input.aspectRatio, '1:1');
      assert.equal(input.length, 12);
      assert.equal(input.captions, false);
      assert.equal(input.ownerId, 'owner');
      assert.equal(input.threadId, thread.id);
      starts++;
      res.end(JSON.stringify({ id, state: 'queued' }));
      return;
    }
    if (req.url?.includes('/resolve-download')) {
      builds++;
      res
        .writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="edit.resolve.zip"',
        })
        .end('LIBRARY-ZIP');
    } else if (req.url?.includes('/resolve')) {
      builds++;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          state: req.method === 'POST' ? libraryState : 'idle',
        }),
      );
    } else if (req.url === '/jobs')
      res.end(
        JSON.stringify([
          { id, revisions: [{ revision: 1, preview: '/preview' }] },
        ]),
      );
    else res.end(JSON.stringify({ id }));
  });
  const upstreamPort = await listen(upstream),
    launcherPort = await listen(launcher);
  const reserve = createServer();
  const port = await listen(reserve);
  await new Promise<void>((r) => reserve.close(() => r()));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      IMMICH_URL: `http://127.0.0.1:${upstreamPort}`,
      ANTHROPIC_API_KEY: 'test',
      HEV_CHAT_DATA: dir,
      HEV_EDIT_URL: `http://127.0.0.1:${launcherPort}`,
      HEV_EDIT_SECRET: 'launcher-secret',
    },
    stdio: 'ignore',
  });
  const closed = new Promise((r) => child.on('close', r));
  const url = `http://127.0.0.1:${port}`;
  try {
    const until = Date.now() + 10000;
    while (true) {
      try {
        if ((await fetch(url + '/health')).ok) break;
      } catch {}
      if (Date.now() > until) throw Error('Server did not start');
      await new Promise((r) => setTimeout(r, 25));
    }
    const library = `/edits/${id}/resolve?revision=1`;
    const libRequest = (user: string, method = 'GET') =>
      fetch(url + library, {
        method,
        headers: {
          Authorization: 'Bearer ' + user,
          'Content-Type': 'application/json',
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
    assert.equal((await fetch(url + library)).status, 401);
    assert.equal((await libRequest('viewer', 'POST')).status, 403);
    assert.equal((await libRequest('other-admin', 'POST')).status, 404);
    assert.equal(builds, 0);
    assert.equal((await (await libRequest('owner')).json()).state, 'idle');
    assert.equal(
      (await (await libRequest('owner', 'POST')).json()).state,
      'queued',
    );
    assert.equal(builds, 2);
    const download = library.replace('/resolve?', '/resolve-download?');
    assert.equal((await fetch(url + download)).status, 401);
    assert.equal(
      (
        await fetch(url + download, {
          headers: { Authorization: 'Bearer viewer' },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url + download, {
          headers: { Authorization: 'Bearer other-admin' },
        })
      ).status,
      404,
    );
    assert.equal(builds, 2);
    const archive = await fetch(url + download, {
      headers: { Authorization: 'Bearer owner' },
    });
    assert.equal(archive.status, 200);
    assert.equal(await archive.text(), 'LIBRARY-ZIP');
    assert.match(archive.headers.get('content-disposition')!, /resolve.zip/);
    assert.equal(builds, 3);
    for (const user of ['viewer', 'other-admin']) {
      const denied = await fetch(url + download, {
        headers: { Authorization: 'Bearer ' + user, Range: 'bytes=0-3' },
      });
      assert.equal(denied.status, user === 'viewer' ? 403 : 404);
    }
    for (const state of ['queued', 'ready']) {
      libraryState = state;
      const response = await fetch(url + '/chat', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          threadId: thread.id,
          messages: [{ role: 'user', content: '/open' }],
        }),
      });
      const events = await response.text();
      assert.equal(response.status, 200);
      assert.match(
        events,
        state === 'ready'
          ? /Your edit is ready/
          : /Preparing your edit download/,
      );
      assert.match(events, /"type":"edit"/);
    }
    const emptyThread = (await (
      await fetch(url + '/threads', {
        method: 'POST',
        headers: { Authorization: 'Bearer owner' },
      })
    ).json()) as any;
    const noEdit = await fetch(url + '/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        threadId: emptyThread.id,
        messages: [{ role: 'user', content: '/open' }],
      }),
    });
    assert.match(await noEdit.text(), /No rendered edit available.*\/edit/);
    const request = (user: string, path: string, body: object) =>
      fetch(url + path, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + user,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    const defaults = await (
      await fetch(url + '/threads/' + thread.id + '/setup', {
        headers: { Authorization: 'Bearer owner' },
      })
    ).json();
    assert.deepEqual(defaults.assetIds, [id]);
    assert.equal(defaults.captions, false);
    assert.equal(defaults.length, 18);
    const empty = await request('owner', '/threads/' + thread.id + '/setup', {
      assetIds: [],
    });
    assert.equal(empty.status, 400);
    assert.match((await empty.json()).message, /Select at least one clip/);
    assert.equal(starts, 0);
    const setup = {
      assetIds: [id],
      aspectRatio: '1:1',
      length: 12,
      captions: false,
    };
    assert.equal(
      (await request('other-admin', '/threads/' + thread.id + '/setup', setup))
        .status,
      404,
    );
    assert.equal(
      (
        await request('owner', '/threads/' + thread.id + '/setup', {
          ...setup,
          assetIds: ['foreign'],
        })
      ).status,
      400,
    );
    assert.equal(
      (await request('owner', '/threads/' + thread.id + '/setup', setup))
        .status,
      200,
    );
    const saved = await (
      await fetch(url + '/threads/' + thread.id, {
        headers: { Authorization: 'Bearer owner' },
      })
    ).json();
    assert.equal(saved.setup.aspectRatio, '1:1');
    const confirmed = await request('owner', '/chat', {
      threadId: thread.id,
      messages: [{ role: 'user', content: 'give it a go' }],
    });
    const events = (await confirmed.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(events[0].type, 'status');
    assert.ok(events.some((e) => e.type === 'edit'));
    assert.equal(events.at(-1).type, 'done');
    assert.equal(starts, 1);
    const after = await (
      await fetch(url + '/threads/' + thread.id, {
        headers: { Authorization: 'Bearer owner' },
      })
    ).json();
    assert.equal(after.setup, undefined);
  } finally {
    child.kill();
    await closed;
    await Promise.all([
      new Promise<void>((r) => upstream.close(() => r())),
      new Promise<void>((r) => launcher.close(() => r())),
    ]);
    rmSync(dir, { recursive: true, force: true });
  }
});
