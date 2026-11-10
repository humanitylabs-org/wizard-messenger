// A tapped file attachment shows it is downloading and never starts a second download of the same file (issue 157).
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fileDownloads,readProgress,downloadLabel}=require('../static/unified.js');
const fmt=b=>!b?'':b<1048576?Math.max(1,Math.round(b/1024))+' KB':(b/1048576).toFixed(1)+' MB';
test('repeat taps while a file downloads start nothing; the state is visible at once',async()=>{
  const d=fileDownloads(),seen=[];let runs=0,finish;d.watch(k=>seen.push([k,d.state(k)?.phase||null]));
  const first=d.start('m1',()=>{runs++;return new Promise(r=>{finish=r;});});
  assert.ok(first);assert.equal(d.state('m1').phase,'loading','loading the moment it is tapped');
  for(let i=0;i<4;i++)assert.equal(d.start('m1',()=>{runs++;}),null);
  await Promise.resolve();assert.equal(runs,1);
  assert.ok(d.start('m2',async()=>{runs++;}),'another file still downloads');
  finish();await first;assert.equal(d.state('m1'),null);
  assert.ok(d.start('m1',async()=>{}),'after it finished, a new tap downloads again');
  assert.deepEqual(seen[0],['m1','loading']);
});
test('a failed download frees the file for another try',async()=>{
  const d=fileDownloads();await assert.rejects(d.start('m',async()=>{throw new Error('boom');}),/boom/);
  assert.equal(d.state('m'),null);assert.ok(d.start('m',async()=>{}));
});
test('readProgress reports bytes and returns the whole file',async()=>{
  const chunks=[new Uint8Array(300),new Uint8Array(700)],reports=[];
  const response={headers:{get:k=>k==='Content-Length'?'1000':k==='Content-Type'?'application/pdf':null},body:{getReader:()=>({read:async()=>chunks.length?{done:false,value:chunks.shift()}:{done:true}})}};
  const blob=await readProgress(response,p=>reports.push({...p}));
  assert.equal(blob.size,1000);assert.equal(blob.type,'application/pdf');
  assert.deepEqual(reports.map(r=>r.loaded),[0,300,1000]);assert.ok(reports.every(r=>r.total===1000));
});
test('the attachment label says what is happening',()=>{
  assert.equal(downloadLabel(null,2*1048576,fmt),'2.0 MB');
  assert.equal(downloadLabel({phase:'loading',loaded:0,total:0},2*1048576,fmt),'Downloading… · 2.0 MB');
  assert.equal(downloadLabel({phase:'loading',loaded:1048576,total:2*1048576},0,fmt),'Downloading 50% · 1.0 MB of 2.0 MB');
  assert.equal(downloadLabel({phase:'handed'},0,fmt),'Saving to Downloads');
  assert.equal(downloadLabel({phase:'saved'},0,fmt),'Downloaded');
});
test('the file bubble is wired to the one-at-a-time download, also from the message menu',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../static/unified.js'),'utf8');
  assert.match(src,/m\.msgtype === 'm\.file'\) b\.append\(fileLink\(m\)\)/);
  assert.match(src,/if \(m\.msgtype === 'm\.file' && !m\.photos\) return saveFile\(m\)/);
  assert.match(src,/e\.preventDefault\(\); e\.stopPropagation\(\); saveFile\(m\)/);
});
