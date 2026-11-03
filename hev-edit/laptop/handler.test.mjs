import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const binary = process.env.HEV_HANDLER_BINARY;
test('URL handler accepts only canonical job and positive revision without shell syntax', { skip: !binary }, () => {
 const good='hevmedia://resolve/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/1';
 assert.equal(spawnSync(binary,['--validate',good]).status,0);
 for(const url of [good+'?x=1',good+'#fragment',good.replace('/1','/0'),good.replace('/1','/01'),good.replace('/1','/1;touch /tmp/no'),good.replace('aaaaaaaa-','--------a-'),good.replace('/1','/%31'),good.replace('resolve/','resolve@evil/'),good.replace('/1','/9999999')])
  assert.equal(spawnSync(binary,['--validate',url]).status,2,url);
});
