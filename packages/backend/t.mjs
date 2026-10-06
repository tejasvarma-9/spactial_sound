import WebSocket from 'ws';
import * as Y from 'yjs';
import * as sync from 'y-protocols/sync.js';
import * as aw from 'y-protocols/awareness.js';
import { encoding, decoding } from 'lib0';
const N=4; const counts=Array(N).fill(0); const socks=[]; const docs=[];
for (let i=0;i<N;i++){ const d=new Y.Doc(); docs.push(d); const s=new WebSocket('ws://127.0.0.1:3999/ws/test'); s.binaryType='arraybuffer'; socks.push(s);
  s.on('message',(m)=>{counts[i]++; const dec=decoding.createDecoder(new Uint8Array(m)); if(decoding.readVarUint(dec)===0){const e=encoding.createEncoder(); encoding.writeVarUint(e,0); sync.readSyncMessage(dec,e,d,null); if(encoding.length(e)>1) s.send(encoding.toUint8Array(e));}});
  d.on('update',(u,o)=>{ if(o===null||o===undefined){const e=encoding.createEncoder(); encoding.writeVarUint(e,0); sync.writeUpdate(e,u); s.send(encoding.toUint8Array(e));}});
  await new Promise(r=>s.on('open',r)); }
await new Promise(r=>setTimeout(r,500)); const base=[...counts];
docs[0].getMap('nodes').set('a',1);
await new Promise(r=>setTimeout(r,500));
console.log('msgs per client for ONE update:', counts.map((c,i)=>c-base[i]));
console.log('converged:', docs.map(d=>d.getMap('nodes').get('a')));
// awareness
const a=new aw.Awareness(docs[0]); const b=counts.slice();
a.setLocalState({x:1}); const e=encoding.createEncoder(); encoding.writeVarUint(e,1); encoding.writeVarUint8Array(e,aw.encodeAwarenessUpdate(a,[docs[0].clientID])); socks[0].send(encoding.toUint8Array(e));
await new Promise(r=>setTimeout(r,500)); console.log('awareness msgs per client:', counts.map((c,i)=>c-b[i]));
socks[0].close(); await new Promise(r=>setTimeout(r,500)); console.log('after leave (reaped):', counts.map((c,i)=>c-b[i]));
process.exit(0);
