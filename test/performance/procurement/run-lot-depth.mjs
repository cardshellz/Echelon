import assert from 'node:assert/strict';
import {readdirSync,writeFileSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Run from the selected clean checkout so the same external runner can measure
// both revisions. The wrapper separately verifies exact Git/module identities.
const load = file => import(pathToFileURL(resolve(file)).href);
const output = process.argv[2];
if (!output || !isAbsolute(output) || !output.endsWith('.json')
  || process.env.NODE_ENV !== 'test' || process.env.DISABLE_SCHEDULERS !== 'true' || !process.env.VITEST
  || process.env.ECHELON_TEST_DATABASE_DISPOSABLE !== 'true'
  || process.env.DATABASE_URL || process.env.EXTERNAL_DATABASE_URL) {
  throw new Error('An absolute report path and explicitly isolated disposable test environment are required');
}
if (readdirSync(process.cwd()).some(name=>/^\.env(?:\.|$)/.test(name))) throw new Error('Remove environment-loading files from the selected clean test checkout');
const {createProcurementPerformanceFixture,PERFORMANCE_AS_OF,PERFORMANCE_ID_BASE} = await load('test/performance/procurement/health-cost.fixture.ts');
const {instrumentQueries} = await load('test/performance/procurement/query-measurement.ts');
const LOT_COUNT = 100_000, LOT_ID_BASE = 2_000_000;
const report = {version:1,profile:'untraced-lot-depth',provisionalLots:LOT_COUNT,shipments:10,samplesPerOwner:3,
  nodeVersion:process.version,limitations:[
    'Synthetic depleted untraced lots; no production records or statistics.',
    'Local diagnostic timings and sampled RSS are not production SLOs or an allocation profile.',
    'This does not establish unbounded capacity for shipment lines, charge allocations or supplier lineage graphs.',
  ],measurements:[]};
const save = () => writeFileSync(output,JSON.stringify(report,null,2)+'\n');
const failure = error => error instanceof Error ? {name:error.name,message:error.message,stack:error.stack} : {message:String(error)};
save();
const fixture = await createProcurementPerformanceFixture(process.env.ECHELON_TEST_DATABASE_URL,'unresolved').catch(error=>{
  report.status='fixture_failed';report.failure=failure(error);save();throw error;
});
const instrumentation = instrumentQueries(fixture.harness.pool);
try {
  await fixture.seedTo(10);
  await fixture.harness.pool.query(`INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,inbound_shipment_id,
    qty_received,qty_on_hand,cost_provisional,received_at)
    SELECT $1::int+n,'PERF-UNTRACED-'||n,201,99,$2,0,0,1,'2026-09-10T12:00:00Z' FROM generate_series(1,$3::int) n`,
    [LOT_ID_BASE,PERFORMANCE_ID_BASE+1,LOT_COUNT]);
  await fixture.harness.pool.query('ANALYZE inventory.inventory_lots');
  report.identity=fixture.identity;report.schema=await fixture.metadata();
  await fixture.readOnly(true);
  const before=await fixture.fingerprint();
  const {loadProcurementHealthSummary}=await load('server/modules/procurement/procurement-health-summary.service.ts');
  const {inventoryStorage}=await load('server/modules/inventory/index.ts');
  const owners=[
    ['landed-health',()=>fixture.harness.shipment.getLandedCostHealth({limit:250})],
    ['unfiltered-shipments',()=>fixture.harness.shipment.getShipmentPage({limit:50})],
    ['filtered-shipments',()=>fixture.harness.shipment.getShipmentPage({limit:50,costFilter:'critical'})],
    ['purchasing-health',()=>loadProcurementHealthSummary({shipmentTracking:fixture.harness.shipment,limit:50,
      db:fixture.harness.database,storage:{...fixture.harness.storage,getVelocityLookbackDays:()=>inventoryStorage.getVelocityLookbackDays()},asOf:PERFORMANCE_AS_OF})],
  ];
  for (const [owner,operation] of owners) {
    const samples=[];
    for (let repeat=0;repeat<3;repeat++) {
      const sample=await instrumentation.measure(owner,operation);
      samples.push(sample);
      console.log(JSON.stringify({owner,repeat,elapsedMs:Math.round(sample.elapsedMs),queries:sample.queries,
        driverRows:sample.queryGroups.reduce((sum,group)=>sum+group.rows,0)}));
    }
    assert.deepEqual(samples[1].value,samples[0].value);assert.deepEqual(samples[2].value,samples[0].value);
    report.measurements.push({owner,samples});save();
  }
  assert.deepEqual(await fixture.fingerprint(),before);
  report.fingerprintsUnchanged=true;report.fingerprints=before;report.status='passed';
} catch (error) {
  report.status='failed';report.failure=failure(error);throw error;
} finally {
  instrumentation.restore();
  try {await fixture.dispose();report.disposed=true;}
  catch(error){report.status='cleanup_failed';report.cleanupFailure=failure(error);throw error;}
  finally {save();}
}
