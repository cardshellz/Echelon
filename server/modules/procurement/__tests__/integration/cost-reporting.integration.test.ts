import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it } from "vitest";
import * as schema from "@shared/schema";
import { costReportAcknowledgementSchema, costReportDeliveryListSchema } from "@shared/procurement/cost-report-delivery";
import { CostReportingRepository,type ClaimedCostReport } from "../../cost-reporting.repository";
import { CostReportingError,type ReportDestination } from "../../cost-reporting.domain";
import { recordCostRevision } from "../../cost-source-revision.repository";
import { recordReceiptCostOrigin } from "../../../inventory/infrastructure/cost-evidence.repository";
import { applyCostRevision } from "../../../inventory/application/apply-cost-revision";
import { fixtureTable,fixtureForeignKeys } from "./shipment-line-fixture";

const url=process.env.ECHELON_TEST_DATABASE_URL;
const enabled=!!url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const NOW=new Date("2026-09-07T12:00:00.000Z");
const tables=[schema.purchaseOrders,schema.purchaseOrderLines,schema.inboundShipmentLines,schema.receivingOrders,schema.receivingLines,schema.receiptReversals,schema.vendorInvoiceLines,schema.inventoryLots];
(enabled ? describe : describe.skip).sequential("durable reporting owner in PostgreSQL",() => {
  let pool:pg.Pool,repository:CostReportingRepository,destination:ReportDestination;
  const owned:string[]=[];
  beforeAll(async () => {
    if (!["127.0.0.1","localhost"].includes(new URL(url!).hostname) || [process.env.DATABASE_URL,process.env.EXTERNAL_DATABASE_URL].filter(Boolean).includes(url!)) throw new Error("Reporting requires a separate disposable local database");
    pool=new pg.Pool({connectionString:url,ssl:false,max:10,statement_timeout:15_000});repository=new CostReportingRepository(pool);
  });
  beforeEach(async () => {
    for (const name of ["procurement","inventory"]) {await pool.query(`CREATE SCHEMA ${name}`);owned.push(name);}
    for (const table of tables) await pool.query(fixtureTable(table));
    for (const statement of fixtureForeignKeys(tables)) await pool.query(statement);
    for (const name of ["222_procurement_cost_evidence.sql","230_procurement_cost_reporting_delivery.sql"]) await pool.query(readFileSync(resolve(process.cwd(),"migrations",name),"utf8"));
    await pool.query(`INSERT INTO procurement.purchase_orders(id,po_number,vendor_id) VALUES(10,'REPORT-FIXTURE',5);
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,sku,order_qty,unit_cost_cents,line_total_cents) VALUES(21,10,1,'REPORT',3,2,6);
      INSERT INTO procurement.receiving_orders(id,receipt_number,source_type,status) VALUES(40,'REPORT-RECEIPT','purchase_order','closed');
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,sku,product_variant_id,expected_qty,received_qty,units_per_variant_snapshot,cost_source_kind)
        VALUES(51,40,21,'REPORT',1,3,3,1,'purchase_order_line');
      INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,qty_received,qty_on_hand,po_line_id,receiving_order_id,po_unit_cost_mills,packaging_cost_mills,landed_cost_mills,total_unit_cost_mills,cost_source,received_at)
        VALUES(5,'REPORT-LOT',1,1,3,3,21,40,200,2,3,205,'po','2026-09-07T12:00:00Z');`);
    destination={id:randomUUID(),sourceSystemId:"synthetic-echelon",endpoint:"https://reports.example.com/api/integrations/procurement-cost-reports",enabled:true};
    const database=drizzle(pool);
    await database.transaction(async (tx) => {
      await recordReceiptCostOrigin(tx,{inventoryLotId:5,receivingLineId:51,purchaseOrderLineId:21,inboundShipmentLineId:null,unitsPerVariantSnapshot:1,receivedVariantQty:3},"synthetic-user",NOW);
      const revision=await recordCostRevision(tx,{contractVersion:1,component:"product",scope:{kind:"purchase_order_line",purchaseOrderId:10,purchaseOrderLineId:21},
        sources:[{kind:"purchase_order_line",documentId:10,lineId:21,version:"a".repeat(64)}],currency:"USD",totalMills:300,basePieces:3,evidence:"confirmed",packagingTreatment:"separate",issue:null,manualOverride:null},"synthetic-user",NOW);
      // Only the revaluation boundary is injected; the actual inventory owner
      // writes its source, application, exact lot snapshots and report event.
      const result=await applyCostRevision(tx,revision,{revalueComponent:async (lotId,_component,unitMills,_reason,client) => {
        await client.execute(sql`UPDATE inventory.inventory_lots SET po_unit_cost_mills=${unitMills},total_unit_cost_mills=${unitMills+5} WHERE id=${lotId}`);
        return {cogsRowsUpdated:1,totalCogsDeltaCents:-7};
      }},"synthetic-user",NOW);
      expect(result.status).toBe("applied");
    });
  });
  afterEach(async () => {for (const name of owned.splice(0).reverse()) await pool.query(`DROP SCHEMA ${name} CASCADE`);});
  afterAll(async () => {if(pool) await pool.end();});
  async function queued() {await repository.enqueue(destination,NOW,randomUUID);return (await pool.query("SELECT * FROM procurement.cost_report_deliveries")).rows[0];}
  async function claim(now=NOW) {const result=await repository.claim(destination,now,randomUUID);expect(result).toHaveLength(1);return result[0];}
  const ack=(work:ClaimedCostReport) => costReportAcknowledgementSchema.parse({contractVersion:1,disposition:"accepted_evidence_only",sourceSystemId:work.envelope.sourceSystemId,destinationId:work.envelope.destinationId,deliveryId:work.id,sourceEventId:work.envelope.sourceEventId,payloadHash:work.envelope.payloadHash,reportHash:work.envelope.reportHash,receiptId:randomUUID(),acceptedAt:NOW.toISOString()});
  async function failAudit(action:string,work:() => Promise<void>) {
    await pool.query(`CREATE FUNCTION procurement.reporting_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='${action}' THEN RAISE EXCEPTION 'injected reporting audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reporting_fail_audit BEFORE INSERT ON procurement.cost_report_delivery_audit FOR EACH ROW EXECUTE FUNCTION procurement.reporting_fail_audit()`);
    try {await work();} finally {await pool.query("DROP TRIGGER reporting_fail_audit ON procurement.cost_report_delivery_audit; DROP FUNCTION procurement.reporting_fail_audit()");}
  }
  it("delivers the actual owner's unchanged signed event once and retains an exact acknowledgement",async () => {
    const row=await queued();const source=(await pool.query("SELECT payload FROM inventory.cost_reporting_events")).rows[0].payload;
    expect(row.envelope.payload).toEqual(source);expect(source).toMatchObject({cogsDeltaCents:-7,changes:[{after:{allocatedMills:300,remainderMills:0}}]});
    expect(await repository.enqueue(destination,NOW,randomUUID)).toBe(0);
    const work=await claim();const receipt=ack(work);expect(await repository.finish(work,{acknowledgement:receipt},new Date(NOW.getTime()+1000))).toBe(true);
    expect(await repository.finish(work,{acknowledgement:receipt},new Date(NOW.getTime()+2000))).toBe(false);
    const status=costReportDeliveryListSchema.parse({purchaseOrderId:10,configuration:"enabled",...await repository.list(10,destination.id)});
    expect(status.deliveries[0]).toMatchObject({state:"acknowledged",attemptCount:1,acknowledgement:receipt});expect(status.unqueuedEventCount).toBe(0);
  });
  it("serializes simultaneous enqueues and claims without duplicate delivery",async () => {
    expect((await Promise.all([repository.enqueue(destination,NOW,randomUUID),repository.enqueue(destination,NOW,randomUUID)])).reduce((sum,n) => sum+n,0)).toBe(1);
    const work=(await Promise.all(Array.from({length:4},() => repository.claim(destination,NOW,randomUUID)))).flat();expect(work).toHaveLength(1);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM procurement.cost_report_deliveries")).rows[0].count).toBe(1);
  });
  it("reclaims an expired lease and fences the old worker's late acknowledgement",async () => {
    await queued();const old=await claim();const later=new Date(NOW.getTime()+61_000);const current=await claim(later);
    expect(current.attemptCount).toBe(2);expect(current.id).toBe(old.id);expect(current.envelope).toEqual(old.envelope);
    expect(await repository.finish(old,{acknowledgement:ack(old)},later)).toBe(false);
    expect(await repository.finish(current,{acknowledgement:ack(current)},new Date(later.getTime()+1000))).toBe(true);
  });
  it("backs off, dead letters permanent failures, and preserves reviewed retry identity",async () => {
    await queued();const first=await claim();await repository.finish(first,{error:new CostReportingError("TEMPORARY","Retry safely",true)},NOW);
    expect(await repository.claim(destination,new Date(NOW.getTime()+29_999),randomUUID)).toEqual([]);
    const second=await claim(new Date(NOW.getTime()+30_000));await repository.finish(second,{error:new CostReportingError("CONFLICT","Review receiver identity")},new Date(NOW.getTime()+30_000));
    const input={purchaseOrderId:10,deliveryId:first.id,key:randomUUID(),actor:"reviewer",command:{expectedAttemptCount:2,reason:"Verified receiver configuration"}};
    const retried=await repository.retry(input,destination,new Date(NOW.getTime()+31_000));expect(retried).toMatchObject({state:"queued",replayed:false});
    const replay=await repository.retry(input,null,new Date(NOW.getTime()+32_000));expect(replay).toMatchObject({state:"queued",replayed:true});
    await expect(repository.retry({...input,command:{...input.command,reason:"Different reason"}},destination,NOW)).rejects.toMatchObject({code:"COST_REPORT_RETRY_CONFLICT"});
    const third=await claim(new Date(NOW.getTime()+31_000));expect(third).toMatchObject({attemptCount:3,cycleAttemptCount:1});expect(third.envelope).toEqual(first.envelope);
    await expect(repository.retry({...input,key:randomUUID()},destination,NOW)).rejects.toMatchObject({code:"COST_REPORT_RETRY_STALE"});
  });
  it("exhausts eight crashed leases without running forever",async () => {
    await queued();for(let attempt=0;attempt<8;attempt++) await claim(new Date(NOW.getTime()+61_000*attempt));
    expect(await repository.claim(destination,new Date(NOW.getTime()+61_000*8),randomUUID)).toEqual([]);
    expect((await repository.list(10,destination.id)).deliveries[0]).toMatchObject({state:"dead_letter",attemptCount:8,lastErrorCode:"COST_REPORT_ATTEMPTS_EXHAUSTED"});
  });
  it("never treats a mismatched HTTP-success acknowledgement as delivery",async () => {
    await queued();const work=await claim();await expect(repository.finish(work,{acknowledgement:{...ack(work),reportHash:"b".repeat(64)}},NOW)).rejects.toMatchObject({code:"COST_REPORT_ACK_INVALID"});
    expect((await repository.list(10,destination.id)).deliveries[0].state).toBe("processing");
  });
  it("rolls back the queue, completion and retry if their immutable audit cannot be written",async () => {
    await failAudit("enqueued",async () => {await expect(queued()).rejects.toThrow("injected reporting audit failure");});
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM procurement.cost_report_deliveries")).rows[0].count).toBe(0);
    await queued();const work=await claim();await failAudit("acknowledged",async () => {await expect(repository.finish(work,{acknowledgement:ack(work)},NOW)).rejects.toThrow("injected reporting audit failure");});
    expect((await repository.list(10,destination.id)).deliveries[0].state).toBe("processing");
    await repository.finish(work,{error:new CostReportingError("REVIEW","Review receiver")},NOW);
    const input={purchaseOrderId:10,deliveryId:work.id,key:randomUUID(),actor:"reviewer",command:{expectedAttemptCount:1,reason:"Receiver reviewed"}};
    await failAudit("retry_requested",async () => {await expect(repository.retry(input,destination,NOW)).rejects.toThrow("injected reporting audit failure");});
    expect((await repository.list(10,destination.id)).deliveries[0].state).toBe("dead_letter");expect((await pool.query("SELECT COUNT(*)::int AS count FROM procurement.cost_report_retry_intents")).rows[0].count).toBe(0);
  });
  it("isolates conflicting historical event evidence instead of sending a fabricated amount",async () => {
    const original=(await pool.query("SELECT * FROM inventory.cost_reporting_events")).rows[0];
    const duplicate=(await pool.query(`INSERT INTO inventory.cost_applications(application_key,source_revision_id,status,evidence,recorded_by,recorded_at)
      SELECT $1,source_revision_id,status,evidence,recorded_by,recorded_at FROM inventory.cost_applications WHERE id=$2 RETURNING id`,["c".repeat(64),original.application_id])).rows[0];
    await pool.query(`INSERT INTO inventory.cost_application_lots(application_id,inventory_lot_id,before_state,after_state)
      SELECT $1,inventory_lot_id,before_state,after_state FROM inventory.cost_application_lots WHERE application_id=$2`,[duplicate.id,original.application_id]);
    await pool.query("INSERT INTO inventory.cost_reporting_events(application_id,contract_version,payload,recorded_at) VALUES($1,1,$2::jsonb,$3)",[duplicate.id,JSON.stringify({...original.payload,cogsDeltaCents:77}),NOW]);
    expect(await repository.enqueue(destination,NOW,randomUUID)).toBe(2);
    const review=(await pool.query("SELECT * FROM procurement.cost_report_deliveries WHERE state='dead_letter'")).rows[0];
    expect(review).toMatchObject({envelope:null,last_error_code:"COST_REPORT_SOURCE_CONFLICT",attempt_count:0});
    expect(await repository.claim(destination,NOW,randomUUID)).toHaveLength(1);
    await expect(repository.retry({purchaseOrderId:10,deliveryId:review.id,key:randomUUID(),actor:"reviewer",command:{expectedAttemptCount:0,reason:"Investigate source"}},destination,NOW)).rejects.toMatchObject({code:"COST_REPORT_RETRY_NOT_ALLOWED"});
    expect((await pool.query("SELECT payload FROM inventory.cost_reporting_events WHERE id=$1",[original.id])).rows[0].payload).toEqual(original.payload);
  });
  it("replays migration 230 without altering history and rejects retargeting or history mutation",async () => {
    const row=await queued();await pool.query(readFileSync(resolve(process.cwd(),"migrations/230_procurement_cost_reporting_delivery.sql"),"utf8"));
    expect((await pool.query("SELECT * FROM procurement.cost_report_deliveries")).rows[0]).toEqual(row);
    await expect(repository.enqueue({...destination,endpoint:"https://other.example.com"},NOW,randomUUID)).rejects.toMatchObject({code:"COST_REPORT_DESTINATION_CHANGED"});
    for(const query of ["UPDATE procurement.cost_report_deliveries SET envelope='{}'::jsonb","DELETE FROM procurement.cost_report_deliveries","TRUNCATE procurement.cost_report_deliveries CASCADE","UPDATE procurement.cost_reporting_destinations SET endpoint='https://other.example.com'","DELETE FROM procurement.cost_report_delivery_audit"])
      await expect(pool.query(query)).rejects.toMatchObject({code:"55000"});
  });
});
