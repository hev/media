import { test } from 'node:test';
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
    await request('A', '/threads/' + thread.id, 'DELETE');
    assert.equal((await request('A', '/threads/' + thread.id)).status, 404);
  } finally {
    child.kill();
    await closed;
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true });
  }
});

test('iMovie endpoint checks session, admin and owner before proxying ZIP bytes', async () => {
  const { Threads } = await import('./threads.js');
  const id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const dir = mkdtempSync(join(tmpdir(), 'kit-http-'));
  const db = new Threads(join(dir, 'threads.sqlite'));
  const thread = db.create('owner');
  db.claim('owner', thread, id);
  db.db.close();
  const upstream = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        id: req.headers.authorization?.slice(7),
        isAdmin: req.headers.authorization !== 'Bearer viewer',
      }),
    );
  });
  let builds = 0;
  const launcher = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer launcher-secret');
    if (req.url?.includes('/imovie-kit')) {
      builds++;
      assert.equal(req.method, 'POST');
      res
        .writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="kit.zip"',
        })
        .end('ZIP');
    } else if (req.url?.includes('/imovie-library-download')) {
      builds++;
      res
        .writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition':
            'attachment; filename="edit.imovielibrary.zip"',
        })
        .end('LIBRARY-ZIP');
    } else if (req.url?.includes('/imovie-library')) {
      builds++;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({ state: req.method === 'POST' ? 'queued' : 'idle' }),
      );
    } else res.end(JSON.stringify({ id }));
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
    const kit = `/edits/${id}/imovie-kit?revision=1`;
    assert.equal((await fetch(url + kit)).status, 401);
    const request = (user: string) =>
      fetch(url + kit, { headers: { Authorization: 'Bearer ' + user } });
    assert.equal((await request('viewer')).status, 403);
    assert.equal((await request('other-admin')).status, 404);
    assert.equal(builds, 0);
    const response = await request('owner');
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ZIP');
    assert.equal(
      response.headers.get('content-disposition'),
      'attachment; filename="kit.zip"',
    );
    assert.equal(builds, 1);
    const library = `/edits/${id}/imovie-library?revision=1`;
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
    assert.equal(builds, 1);
    assert.equal((await (await libRequest('owner')).json()).state, 'idle');
    assert.equal(
      (await (await libRequest('owner', 'POST')).json()).state,
      'queued',
    );
    assert.equal(builds, 3);
    const download = library.replace(
      '/imovie-library?',
      '/imovie-library-download?',
    );
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
    assert.equal(builds, 3);
    const archive = await fetch(url + download, {
      headers: { Authorization: 'Bearer owner' },
    });
    assert.equal(archive.status, 200);
    assert.equal(await archive.text(), 'LIBRARY-ZIP');
    assert.match(
      archive.headers.get('content-disposition')!,
      /imovielibrary.zip/,
    );
    assert.equal(builds, 4);
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
