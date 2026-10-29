import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';

const directory=process.argv[2];
if(!directory||!isAbsolute(directory))throw new Error('Provide the absolute directory containing baseline-exceptions.json and candidate-exceptions.json');
const read=name=>JSON.parse(readFileSync(resolve(directory,name),'utf8'));
const baseline=read('baseline-exceptions.json'),candidate=read('candidate-exceptions.json');
const wrappers=readdirSync(directory).filter(name=>name.endsWith('-wrapper.json')).map(read);
const helperFiles=['test/performance/procurement/run-exception-cost.mjs','test/performance/procurement/health-cost.fixture.ts',
  'test/performance/procurement/query-measurement.ts'];
const median=samples=>[...samples].sort((a,b)=>a-b)[Math.floor(samples.length/2)];
for(const [name,report] of [['baseline-exceptions.json',baseline],['candidate-exceptions.json',candidate]]){
  assert.equal(report.status,'passed');assert.equal(report.disposed,true);assert.equal(report.profile,'shipment-exceptions');
  assert.deepEqual(report.sourceAfter,report.sourceBefore);
  const matches=wrappers.filter(wrapper=>wrapper.args?.some(arg=>typeof arg==='string'&&resolve(arg)===resolve(directory,name)));
  assert.equal(matches.length,1,`One successful owned-database wrapper is required for ${name}`);
  const wrapper=matches[0];
  assert.equal(wrapper.exitCode,0);assert.equal(wrapper.childClosed,true);assert.equal(wrapper.databaseRemoved,true);assert.equal(wrapper.sourceStable,true);
  assert.deepEqual(wrapper.sourceAfter,wrapper.sourceBefore);assert.equal(wrapper.sourceBefore.head,report.head);
  assert.match(wrapper.databaseName,/^procurement_performance_s_[0-9a-f]{32}$/);
  assert.equal(report.identity.database,wrapper.databaseName);assert.equal(report.identity.address,'127.0.0.1');
  assert.equal(report.measurements.length,report.tiers.length*3);assert.equal(report.fingerprints.length,report.tiers.length);
  assert.ok(report.fingerprints.every(value=>value.unchanged===true));
  for(const file of helperFiles){
    const digest=createHash('sha256').update(readFileSync(resolve(file))).digest('hex');
    assert.equal(report.sourceBefore[file],digest,`Measured helper must match ${file}`);
  }
}
assert.deepEqual(baseline.tiers,candidate.tiers);assert.deepEqual(baseline.schema,candidate.schema);
assert.notEqual(baseline.identity.database,candidate.identity.database);
assert.deepEqual(baseline.fingerprints.map(value=>value.tables.map(({table,rows})=>({table,rows}))),
  candidate.fingerprints.map(value=>value.tables.map(({table,rows})=>({table,rows}))));
const compared=[];
for(let index=0;index<baseline.measurements.length;index++){
  const before=baseline.measurements[index],after=candidate.measurements[index];
  assert.equal(before.owner,after.owner);assert.equal(before.tier,after.tier);
  assert.equal(before.samples.length,3);assert.equal(after.samples.length,3);
  for(const sample of [...before.samples,...after.samples]){
    // Compare the complete public value. No timestamp, amount, warning,
    // source identity or destination field is stripped or normalized.
    assert.deepEqual(sample.value,before.samples[0].value);
    assert.ok(sample.queryGroups.every(group=>group.failures===0));
  }
  compared.push({tier:before.tier,owner:before.owner,completeOutputsEqual:true,
    beforeQueries:before.samples.map(sample=>sample.queries),afterQueries:after.samples.map(sample=>sample.queries),
    medianMsBefore:median(before.samples.map(sample=>sample.elapsedMs)),medianMsAfter:median(after.samples.map(sample=>sample.elapsedMs))});
}
console.log(JSON.stringify({status:'passed',comparisons:compared.length,compared,
  limitations:['Local timings are diagnostic, not production SLOs.','Unresolved historical-gap profile; approved and stale cases are separate correctness tests.']},null,2));
