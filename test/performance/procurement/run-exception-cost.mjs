import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Explicit, bounded local experiment. The caller owns a new empty loopback
// database and removes it only after this child closes. No live configuration.
const load=file=>import(pathToFileURL(resolve(file)).href);
const output=process.argv[2];
const tiers=(process.argv[3]??'10,100').split(',').map(Number);
if(!output||!isAbsolute(output)||!output.endsWith('.json')
  ||!tiers.length||tiers.some((tier,index)=>![10,100].includes(tier)||(index>0&&tier<=tiers[index-1]))
  ||process.env.NODE_ENV!=='test'||process.env.DISABLE_SCHEDULERS!=='true'||!process.env.VITEST
  ||process.env.ECHELON_TEST_DATABASE_DISPOSABLE!=='true'||process.env.DATABASE_URL||process.env.EXTERNAL_DATABASE_URL){
  throw new Error('Use an absolute JSON report, ascending 10/100 tiers and an isolated disposable test environment');
}
if(readdirSync(process.cwd()).some(name=>/^\.env(?:\.|$)/.test(name)))throw new Error('Refusing environment-loading files');
const sourceFiles=['server/modules/procurement/shipment-cost-exception.repository.ts',
  'server/modules/inventory/infrastructure/cost-reconciliation.repository.ts',
  'server/modules/procurement/shipment-cost-review.repository.ts',
  'server/modules/procurement/shipment-tracking.service.ts',
  'test/performance/procurement/run-exception-cost.mjs',
  'test/performance/procurement/health-cost.fixture.ts','test/performance/procurement/query-measurement.ts'];
const source=()=>Object.fromEntries(sourceFiles.map(file=>[file,createHash('sha256').update(readFileSync(resolve(file))).digest('hex')]));
const report={version:1,profile:'shipment-exceptions',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  sourceBefore:source(),tiers,startedAt:new Date().toISOString(),samplesPerOwner:3,measurements:[],
  limitations:['Synthetic depleted lots with missing receipt origins; no live records or statistics.',
    'Selected actual schemas/constraints, not a complete release migration/bootstrap replay.',
    'All exceptions are unresolved; approved and stale decisions require separate correctness cases.',
    'Local timings and sampled RSS are diagnostics, not production SLOs or memory allocation profiles.']};
const save=()=>writeFileSync(output,JSON.stringify(report,null,2)+'\n');
const failure=error=>error instanceof Error?{name:error.name,message:error.message,stack:error.stack}:{message:String(error)};
save();
const {createProcurementPerformanceFixture}=await load('test/performance/procurement/health-cost.fixture.ts');
const {instrumentQueries}=await load('test/performance/procurement/query-measurement.ts');
const {readShipmentCostExceptions}=await load('server/modules/procurement/shipment-cost-exception.repository.ts');
const fixture=await createProcurementPerformanceFixture(process.env.ECHELON_TEST_DATABASE_URL).catch(error=>{
  report.status='fixture_failed';report.failure=failure(error);save();throw error;
});
const instrumentation=instrumentQueries(fixture.harness.pool);
let previousTier=0;
try{
  // The real allocator omits created_at and PostgreSQL supplies its default.
  // Allocation rows are immutable fingerprint inputs, so control this fixture
  // clock before inserts rather than stripping timestamps from compared DTOs.
  await fixture.harness.pool.query("ALTER TABLE procurement.inbound_freight_allocations ALTER COLUMN created_at SET DEFAULT TIMESTAMP '2026-09-10 12:00:00'");
  for(const tier of tiers){
    await fixture.seedTo(tier);
    const newLines=(await fixture.harness.pool.query(`SELECT id,inbound_shipment_id,purchase_order_line_id
      FROM procurement.inbound_shipment_lines WHERE inbound_shipment_id>$1 ORDER BY id`,[10000+previousTier])).rows;
    for(const line of newLines){
      await fixture.harness.pool.query(`INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,
        po_line_id,inbound_shipment_id,qty_received,qty_on_hand,unit_cost_mills,po_unit_cost_mills,packaging_cost_mills,
        landed_cost_mills,total_unit_cost_mills,cost_precision_version,cost_source,cost_provisional,received_at)
        VALUES($1,$2,201,99,$3,$4,100,0,10000,10000,0,0,10000,1,'po',1,'2026-09-10T12:00:00Z')`,
        [line.id,`PERF-EXCEPTION-${line.id}`,line.purchase_order_line_id,line.inbound_shipment_id]);
    }
    for(const id of [...new Set(newLines.map(line=>line.inbound_shipment_id))]){
      await fixture.harness.database.transaction(tx=>fixture.harness.shipment.updateCostsInTransaction(tx,id,{},'controlled-procurement-flow',new Date('2026-09-10T12:00:00Z')));
      const review=await fixture.harness.shipment.getCostReview(id);
      assert.equal(review.lines.length,5);
      assert.ok(review.lines.every(line=>line.exceptionReview?.kind==='missing_receipt_history'
        &&line.exceptionReview.state==='open'&&line.exceptionReview.reconciliation?.status==='unresolved'),
        'Each synthetic exception must come from the actual application owner');
    }
    previousTier=tier;
    await fixture.harness.pool.query('ANALYZE');
    report.identity=fixture.identity;report.schema=await fixture.metadata();
    await fixture.readOnly(true);
    const before=await fixture.fingerprint();
    const lineIds=(await fixture.harness.pool.query('SELECT id FROM procurement.inbound_shipment_lines ORDER BY id')).rows.map(row=>row.id);
    assert.equal(lineIds.length,tier*5);
    const owners=[
      ['exceptions',()=>fixture.harness.database.transaction(async tx=>[...await readShipmentCostExceptions(tx,lineIds)],
        {isolationLevel:'repeatable read',accessMode:'read only'})],
      ['landed-health',()=>fixture.harness.shipment.getLandedCostHealth({limit:250})],
      ['filtered-shipments',()=>fixture.harness.shipment.getShipmentPage({limit:50,costFilter:'critical'})],
    ];
    for(const [owner,operation] of owners){
      const samples=[];
      for(let repeat=0;repeat<3;repeat++){
        const sample=await instrumentation.measure(owner,operation);
        if(owner==='exceptions')assert.equal(sample.value.length,lineIds.length);
        if(owner==='landed-health')assert.equal(sample.value.scannedShipments,tier);
        if(owner==='filtered-shipments')assert.equal(sample.value.total,tier);
        if(samples.length)assert.deepEqual(sample.value,samples[0].value);
        assert.ok(sample.queryGroups.every(group=>group.failures===0));
        samples.push(sample);
        console.log(JSON.stringify({tier,owner,repeat,queries:sample.queries,elapsedMs:Math.round(sample.elapsedMs)}));
      }
      report.measurements.push({tier,owner,samples});save();
    }
    assert.deepEqual(await fixture.fingerprint(),before);
    (report.fingerprints??=[]).push({tier,unchanged:true,tables:before});
    await fixture.readOnly(false);
  }
  assert.deepEqual(source(),report.sourceBefore);
  report.status='passed';
}catch(error){report.status='failed';report.failure=failure(error);throw error;}
finally{
  instrumentation.restore();
  try{await fixture.dispose();report.disposed=true;}
  catch(error){report.status='cleanup_failed';report.cleanupFailure=failure(error);throw error;}
  finally{report.sourceAfter=source();report.finishedAt=new Date().toISOString();save();}
}
