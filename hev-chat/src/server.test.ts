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
