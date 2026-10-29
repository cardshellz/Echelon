import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
if(!process.argv[2]||!isAbsolute(process.argv[2]))throw new Error('Pass the absolute directory containing the six raw reports and their wrappers. Run from the repository checkout.');
const root=resolve(process.argv[2]);
const read=name=>JSON.parse(readFileSync(join(root,name),'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const metrics=samples=>({queries:samples.map(s=>s.queries),driverRows:samples.map(s=>s.queryGroups.reduce((n,g)=>n+g.rows,0)),
  medianElapsedMs:median(samples.map(s=>s.elapsedMs)),elapsedMs:samples.map(s=>s.elapsedMs),peakSampledRssBytes:samples.map(s=>s.peakSampledRssBytes)});
const wrappers=readdirSync(root).filter(n=>n.endsWith('-wrapper.json')).map(read).filter(w=>['perf','depth'].includes(w.mode));
for(const wrapper of wrappers)assert.ok(Array.isArray(wrapper.args)&&wrapper.args.every(arg=>typeof arg==='string'),'A performance wrapper needs its explicit command arguments.');
const helpers=['test/performance/procurement/query-measurement.ts','test/performance/procurement/health-cost.fixture.ts','test/performance/procurement/run-health-cost.ts'];
const result={version:1,status:'passed',profiles:[],rows:[],limitations:[
  'Synthetic loopback PostgreSQL experiments; no production rows or statistics were read.',
  'Three serial samples per owner; elapsed time and sampled RSS are diagnostic, not production SLOs.',
  'Per-scope limits, complete header scans and financial decisions remain in their existing owners.',
  'No unbounded capacity claim for charge, exception, supplier-lineage or sales-history distributions.']};
for(const profile of ['unresolved','posted','depth']){
  const sides=['baseline','candidate'].map(side=>{
    const file=side+'-'+profile+'.json',data=read(file);
    const matching=wrappers.filter(w=>w.mode===(profile==='depth'?'depth':'perf')&&w.exitCode===0&&w.args.some(a=>a.replaceAll('\\','/').endsWith('/'+file)));
    assert.equal(matching.length,1,'Exactly one successful wrapper required for '+file);
    const wrapper=matching[0];
    assert.match(wrapper.sourceBefore?.head??'',/^[a-f0-9]{40}$/);
    assert.match(wrapper.sourceBefore?.sourceSha256??'',/^[a-f0-9]{64}$/);
    assert.equal(wrapper.sourceStable,true);assert.equal(wrapper.childClosed,true);assert.equal(wrapper.databaseRemoved,true);
    assert.deepEqual(wrapper.sourceBefore,wrapper.sourceAfter);
    assert.equal(data.status,'passed');assert.equal(data.disposed,true);
    assert.ok(data.fingerprintsUnchanged||data.fingerprints?.every(f=>f.unchanged));
    if(profile!=='depth')assert.deepEqual(data.sourceBefore,data.sourceAfter);
    return {side,file,data,wrapper};
  });
  const [before,after]=sides;
  assert.deepEqual(before.data.schema,after.data.schema,'The same table/index catalog is required');
  if(profile!=='depth')for(const helper of helpers)assert.equal(before.data.sourceBefore[helper],after.data.sourceBefore[helper],'Benchmark helper changed: '+helper);
  let depthRunnerGitBlob=null;
  if(profile==='depth'){
    // Depth uses the checked-in external runner. The working tree was stable
    // during each run; require the same committed runner in both source heads.
    const file='test/performance/procurement/run-lot-depth.mjs';
    const blobs=sides.map(({wrapper})=>{
      assert.match(wrapper.sourceBefore.head,/^[a-f0-9]{40}$/);
      return execFileSync('git',['rev-parse',wrapper.sourceBefore.head+':'+file],{encoding:'utf8',windowsHide:true}).trim();
    });
    assert.equal(blobs[0],blobs[1]);depthRunnerGitBlob=blobs[0];
  }
  assert.equal(before.data.measurements.length,after.data.measurements.length);
  for(const bm of before.data.measurements){
    const cm=after.data.measurements.find(m=>m.owner===bm.owner&&m.tier===bm.tier);assert.ok(cm);
    assert.equal(bm.samples.length,3);assert.equal(cm.samples.length,3);
    for(const samples of [bm.samples,cm.samples])assert.ok(samples.every(sample=>sample.queries===samples[0].queries),'Query counts changed for unchanged evidence.');
    for(const sample of [...bm.samples,...cm.samples]){
      assert.deepEqual(sample.value,bm.samples[0].value,profile+'/'+bm.owner+': complete public output changed');
      assert.ok(sample.queryGroups.every(g=>g.failures===0));
    }
    result.rows.push({profile,tier:bm.tier??before.data.shipments,owner:bm.owner,
      completeOutputSha256:hash(JSON.stringify(bm.samples[0].value)),baseline:metrics(bm.samples),candidate:metrics(cm.samples)});
  }
  result.profiles.push({profile,allCompleteOutputsEqual:true,readOnlyFingerprintsUnchanged:true,databasesRemoved:true,
    schemaSha256:hash(JSON.stringify(before.data.schema)),depthRunnerGitBlob,sources:sides.map(({side,file,data,wrapper})=>({side,
      head:wrapper.sourceBefore.head,sourceSha256:wrapper.sourceBefore.sourceSha256,measuredFiles:data.sourceBefore??null,
      databaseName:wrapper.databaseName,rawReportSha256:hash(readFileSync(join(root,file)))}))});
}
assert.equal(result.rows.length,30);
writeFileSync(join(root,'performance-comparison.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:result.status,completeOwnerTierComparisons:result.rows.length,
  largestUnresolved:result.rows.filter(r=>r.profile==='unresolved'&&r.tier===500).map(r=>({owner:r.owner,
    queries:[r.baseline.queries[0],r.candidate.queries[0]],medianMs:[Math.round(r.baseline.medianElapsedMs),Math.round(r.candidate.medianElapsedMs)]}))}));
