import {readFile,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export const leaseFile=p=>`/tmp/hev-imovie-screen-release-${p.agent_pid}-${p.agent_started}.json`;
export function released(peer,lease,now=Date.now()) {
 return lease?.pid === peer.agent_pid && lease?.started === peer.agent_started && Number.isFinite(lease.until) && lease.until > now && lease.until <= now+31*60*1000;
}
export async function screenBusy(inventory,read=async p=>JSON.parse(await readFile(leaseFile(p),'utf8'))) {
 for(const peer of inventory.panes) {
  if(peer.you || peer.role === 'offline' || peer.state === 'idle') continue;
  let lease;try{lease=await read(peer);}catch{}
  if(!released(peer,lease)) return true;
 }
 return false;
}
export async function releaseScreen(reclaim=false) {
 const inventory=JSON.parse((await exec('peers',['ls','--json'])).stdout);
 const peer=inventory.panes.find(p=>p.you);
 if(!peer?.agent_pid || !peer?.agent_started) throw Error('Cannot establish current peer identity');
 const file=leaseFile(peer);
 if(reclaim) await rm(file,{force:true});
 else await writeFile(file,JSON.stringify({pid:peer.agent_pid,started:peer.agent_started,until:Date.now()+30*60*1000,note:'Coordinator is doing shell and headless browser work only; native builder may use the desktop.'}),{mode:0o600});
 return file;
}
