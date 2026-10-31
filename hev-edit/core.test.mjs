import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorized, originalPath, validate, transition, Queue, publicJob } from './core.mjs';
test('launcher requires exact nonempty shared secret',()=>{
 assert.equal(authorized(undefined,'x'),false);assert.equal(authorized('Bearer x',''),false);
 assert.equal(authorized('Bearer wrong','x'),false);assert.equal(authorized('Bearer x','x'),true);
});
test('mapping rejects non-external paths, traversal, and symlink escapes',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'hev-edit-'));
 try {
  await mkdir(path.join(root,'external'));await writeFile(path.join(root,'outside'),'x');
  await writeFile(path.join(root,'external','video'),'x');await symlink(path.join(root,'outside'),path.join(root,'external','escape'));
  assert.equal(await originalPath('/external/video',path.join(root,'external')),await realpath(path.join(root,'external','video')));
  for(const name of ['/upload/video','/external/../outside','/external/escape','/externality/video']) await assert.rejects(originalPath(name,path.join(root,'external')));
 } finally {await rm(root,{recursive:true,force:true});}
});
test('brief limits and unexpected properties rejected',()=>{
 const input={assets:[{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',originalPath:'/external/x'}],brief:'Reel',caption:'Dogs',length:30};
 assert.equal(validate(input),input);for(const change of [{length:61},{length:0},{assets:[]},{publish:true},{brief:''}]) assert.throws(()=>validate({...input,...change}));
});
test('state machine refuses skipped states and terminal transitions',()=>{
 const job={state:'queued'};assert.throws(()=>transition(job,'drafted','bad'));
 for(const state of ['editing','rendered','uploading','drafted']) transition(job,state,state);
 assert.throws(()=>transition(job,'editing','bad'));assert.equal(publicJob({...job,input:{secret:'hidden'}}).input,undefined);
});
test('queue serializes workers and records failure without dropping subsequent jobs',async()=>{
 let running=0,max=0;let finish;const done=new Promise(r=>finish=r);let count=0;
 const queue=new Queue(async(job,update)=>{
  running++;max=Math.max(max,running);await new Promise(r=>setTimeout(r,10));running--;count++;
  if(count===1) throw Error('worker failed');
  await update('rendered','ok');await update('uploading','ok');await update('drafted','ok');finish();
 });
 const first=await queue.add({});const second=await queue.add({});await done;
 assert.equal(max,1);assert.equal(first.state,'failed');assert.equal(second.state,'drafted');
});
