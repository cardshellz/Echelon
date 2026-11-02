import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { resolveReturnsTestDatabase } from "../support/disposable-database";
import { PostgresCustomerReturnGuestStore } from "../../infrastructure/customer-return-guest.repository";
import { CustomerReturnGuestService } from "../../application/customer-return-guest.service";
import { returnOwnerPredicate } from "../../infrastructure/customer-return-owner-predicate";
import { PostgresCustomerReturnWorkflowStore } from "../../infrastructure/customer-return-workflow.repository";
import { PostgresCustomerReturnCustomerOwnershipReader } from "../../infrastructure/customer-return-customer-ownership.repository";
import { PostgresCustomerReturnOrderAccessRepository } from "../../infrastructure/customer-return-order-access.repository";
import { CustomerReturnOrderAccessService } from "../../application/customer-return-order-access.service";
import { CustomerReturnCustomerOperationsService } from "../../application/customer-return-customer-operations.service";
import { CustomerReturnWorkflowWorker } from "../../application/customer-return-workflow.worker";
import { labelPreparationFixture } from "../support/label-fixtures";
import type { CustomerReturnLabelStatus } from "@shared/returns/customer-return-label.contract";

const url=resolveReturnsTestDatabase(process.env,"access");
const integration=url?describe.sequential:describe.skip;
integration("guest verification PostgreSQL retries and isolation",()=>{
  let pool:Pool,store:PostgresCustomerReturnGuestStore;
  const now=new Date("2026-11-01T12:00:00Z");
  const base={channelId:1,browserHash:"b".repeat(43),inputHash:"i".repeat(43),emailHash:"e".repeat(43),
    purchase:{channelId:1,shopDomain:"test.myshopify.com",omsOrderId:10,externalOrderId:"1001",externalCustomerId:null,email:"guest@example.test",verifiedPurchase:{email:"guest@example.test",customerId:null}},
    expiresAt:new Date(now.getTime()+600_000),verifiedAt:null,now};
  beforeAll(async()=>{
    pool=new Pool({connectionString:url!,max:12,connectionTimeoutMillis:5000,statement_timeout:10000});
    await pool.query("CREATE SCHEMA IF NOT EXISTS returns; CREATE SCHEMA IF NOT EXISTS channels; CREATE SCHEMA IF NOT EXISTS oms");
    await pool.query("CREATE TABLE IF NOT EXISTS channels.channels(id bigint PRIMARY KEY)");
    await pool.query("INSERT INTO channels.channels(id) VALUES(1) ON CONFLICT DO NOTHING");
    await pool.query("DROP TABLE IF EXISTS returns.customer_return_guest_events; DROP TABLE IF EXISTS returns.customer_return_guest_challenges");
    await pool.query(`CREATE TABLE IF NOT EXISTS oms.oms_orders(id bigint PRIMARY KEY,channel_id integer NOT NULL,
      external_order_id text NOT NULL,external_customer_id text,external_order_number text NOT NULL,cancelled_at timestamp);
      DROP FUNCTION IF EXISTS returns.guard_customer_return_guest_identity()`);
    const evidence=readFileSync("migrations/0699_customer_return_authorizations.sql","utf8").match(/CREATE FUNCTION returns\.reject_customer_return_authorization_evidence_mutation[\s\S]*?\$\$;/)?.[0];
    if(!evidence) throw new Error("Immutable evidence function missing");
    await pool.query(evidence.replace("CREATE FUNCTION","CREATE OR REPLACE FUNCTION"));
    await pool.query(readFileSync("server/modules/returns/infrastructure/customer-return-guest-schema.sql","utf8"));
    await pool.query(`CREATE TABLE IF NOT EXISTS oms.oms_orders(id bigint PRIMARY KEY,channel_id integer NOT NULL,
      external_order_id text NOT NULL,external_customer_id text,external_order_number text NOT NULL,cancelled_at timestamp);
      CREATE TABLE IF NOT EXISTS returns.customer_return_authorizations(id bigint PRIMARY KEY,channel_id integer NOT NULL,
      oms_order_id bigint NOT NULL,authorization_number text NOT NULL,created_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS returns.customer_return_submission_commands(channel_id integer NOT NULL,idempotency_key uuid NOT NULL,
      oms_order_id bigint NOT NULL,authorization_id bigint,status text,request_hash text,request_snapshot jsonb,created_at timestamptz,
      PRIMARY KEY(channel_id,idempotency_key))`);
    const exists=await pool.query("SELECT to_regclass('returns.customer_return_workflows') AS relation");
    if(!exists.rows[0].relation) await pool.query(readFileSync("migrations/900000043000019600002_customer_return_workflow.sql","utf8"));
    store=new PostgresCustomerReturnGuestStore(pool,"s".repeat(64));
  });
  beforeEach(async()=>{await pool.query(`TRUNCATE returns.customer_return_guest_events,returns.customer_return_guest_challenges,
    returns.customer_return_workflow_events,returns.customer_return_workflows,returns.customer_return_submission_commands,returns.customer_return_authorizations,oms.oms_orders`);
    await pool.query("INSERT INTO oms.oms_orders(id,channel_id,external_order_id,external_order_number) VALUES(10,1,'1001','#1001')");});
  afterAll(async()=>{await pool?.end();});
  it("serializes duplicate lookup, delivery and code verification without extending expiry",async()=>{
    const input={...base,id:randomUUID()};
    const rows=await Promise.all(Array.from({length:8},()=>store.reserve(input)));
    expect(rows.every(row=>row.expiresAt.getTime()===input.expiresAt.getTime())).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS count FROM returns.customer_return_guest_challenges")).rows[0].count).toBe(1);
    const deliveries=await Promise.all(Array.from({length:8},()=>store.claimDelivery(input.id,input.browserHash,randomUUID(),now)));
    expect(deliveries.filter(Boolean)).toHaveLength(1);
    const verified=await Promise.all(Array.from({length:8},()=>store.verify(input.id,input.browserHash,true,now)));
    expect(verified.every(row=>row?.verifiedAt?.getTime()===now.getTime())).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS count FROM returns.customer_return_guest_events WHERE action='verified'")).rows[0].count).toBe(1);
  });
  it("commits wrong-code attempts, caps concurrent brute force and preserves the cap on lookup replay",async()=>{
    const input={...base,id:randomUUID()};await store.reserve(input);
    await Promise.all(Array.from({length:12},()=>store.verify(input.id,input.browserHash,false,now)));
    expect((await pool.query("SELECT attempts FROM returns.customer_return_guest_challenges")).rows[0].attempts).toBe(5);
    await store.reserve({...input,now:new Date(now.getTime()+1000)});
    expect(await store.verify(input.id,input.browserHash,true,now)).toBeNull();
  });
  it("does not allow unlimited wrong-code attempts after a successful verification",async()=>{
    const input={...base,id:randomUUID()};await store.reserve(input);await store.verify(input.id,input.browserHash,true,now);
    await Promise.all(Array.from({length:10},()=>store.verify(input.id,input.browserHash,false,now)));
    expect((await pool.query("SELECT attempts FROM returns.customer_return_guest_challenges")).rows[0].attempts).toBe(5);
    expect(await store.verify(input.id,input.browserHash,true,now)).toBeNull();
    expect((await store.read(input.id,input.browserHash))?.verifiedAt).toEqual(now);
  });
  it("limits destination and browser rates transactionally even across different challenge IDs",async()=>{
    const results=await Promise.allSettled(Array.from({length:12},()=>store.reserve({...base,id:randomUUID()})));
    expect(results.filter(row=>row.status==="fulfilled")).toHaveLength(5);
    expect(results.filter(row=>row.status==="rejected")).toHaveLength(7);
  });
  it("retries uncertain SMTP delivery using the original code, and retries lost verification with the same grant",async()=>{
    let at=now;const outbox:string[]=[];let fail=true;
    const service=new CustomerReturnGuestService({secret:"s".repeat(64),store,now:()=>at,randomId:randomUUID,
      purchases:{find:async()=>base.purchase,current:async()=>true,account:async()=>({kind:"register",url:"https://store.test/account/register"})},
      email:{send:async input=>{outbox.push(input.code);if(fail){fail=false;throw new Error("SMTP reply lost");}}}});
    const lookup={requestKey:randomUUID(),browserKey:"a".repeat(43),orderReference:"1001",email:base.purchase.email};
    await expect(service.lookup(1,base.purchase.shopDomain,lookup)).rejects.toMatchObject({code:"RETURN_GUEST_EMAIL_UNAVAILABLE"});
    at=new Date(now.getTime()+60_000);await service.lookup(1,base.purchase.shopDomain,lookup);
    expect(outbox).toHaveLength(2);expect(outbox[1]).toBe(outbox[0]);
    const verification={challengeId:lookup.requestKey,browserKey:lookup.browserKey,code:outbox[0]};
    const [one,two]=await Promise.all([service.verify(1,verification),service.verify(1,verification)]);expect(two).toEqual(one);
    await service.logout(1,{challengeId:one.challengeId,browserKey:one.browserKey,grant:one.grant});
    await expect(service.authorize(1,{challengeId:one.challengeId,browserKey:one.browserKey,grant:one.grant})).rejects.toMatchObject({status:401});
  });
  it("serializes activation retries and encrypts the reusable activation URL at rest",async()=>{
    const input={...base,id:randomUUID()};await store.reserve(input);await store.verify(input.id,input.browserHash,true,now);
    const generate=vi.fn(async()=>({kind:"activate" as const,url:"https://store.test/account/activate/9001/private-token"}));
    const build:Parameters<typeof store.account>[3]=async previous=>previous??generate();
    const result=await Promise.all(Array.from({length:8},()=>store.account(input.id,input.browserHash,now,build)));
    expect(generate).toHaveBeenCalledTimes(1);expect(result.every(row=>row.url===result[0].url)).toBe(true);
    expect((await pool.query("SELECT account_result FROM returns.customer_return_guest_challenges")).rows[0].account_result).not.toContain("private-token");
  });
  it("protects identity, order linkage, expiry and append-only verification evidence in PostgreSQL",async()=>{
    const input={...base,id:randomUUID()};await store.reserve(input);
    await expect(pool.query("UPDATE returns.customer_return_guest_challenges SET browser_hash=$2 WHERE id=$1",[input.id,"x".repeat(43)])).rejects.toMatchObject({code:"23514"});
    await expect(pool.query("UPDATE returns.customer_return_guest_events SET action='verified' WHERE challenge_id=$1",[input.id])).rejects.toMatchObject({code:"55000"});
    await expect(store.reserve({...base,id:randomUUID(),purchase:{...base.purchase,omsOrderId:999}})).rejects.toMatchObject({code:"23503"});
    await expect(store.reserve({...base,id:randomUUID(),expiresAt:new Date(now.getTime()+600_001)})).rejects.toMatchObject({code:"23514"});
  });
  it("never treats all null-customer orders as one owner",async()=>{
    const owner=returnOwnerPredicate({channelId:1,externalCustomerId:null,orderScope:{omsOrderId:10,externalOrderId:"1001"}},1);
    const result=await pool.query(`SELECT o.id FROM (VALUES (10::bigint,NULL::text,'1001'),(11,NULL,'1002'),(12,'9001','1001')) AS o(id,external_customer_id,external_order_id)
      WHERE ${owner.sql}`,owner.values);
    expect(result.rows).toEqual([{id:"10"}]);
  });
  it("runs the existing durable workflow for a verified guest, restores after lost replies and excludes other orders' labels",async()=>{
    await pool.query(`INSERT INTO oms.oms_orders(id,channel_id,external_order_id,external_customer_id,external_order_number)
      VALUES(10,1,'1001',NULL,'#1001'),(11,1,'1002',NULL,'#1002') ON CONFLICT DO NOTHING`);
    const access=new CustomerReturnOrderAccessService({channelId:1,
      principalReader:{getVerifiedPrincipal:async()=>({kind:"order",channelId:1,omsOrderId:10,externalOrderId:"1001"})},
      repository:new PostgresCustomerReturnOrderAccessRepository(pool)});
    const workflows=new PostgresCustomerReturnWorkflowStore(pool),ownership=new PostgresCustomerReturnCustomerOwnershipReader(pool);
    const scope={channelId:1,omsOrderId:10,externalOrderId:"1001",externalCustomerId:null,verifiedPurchase:base.purchase.verifiedPurchase};
    const principal={channelId:1,externalCustomerId:null,verifiedPurchase:scope.verifiedPurchase,orderScope:{omsOrderId:10,externalOrderId:"1001"}};
    const {input:prepared}=await labelPreparationFixture();
    const {channelId:_channel,orderReference:_reference,...input}={...prepared,idempotencyKey:randomUUID()};
    let purchased=false;
    const status=():CustomerReturnLabelStatus=>({channelId:1,authorizationId:20,authorizationNumber:"RMA-20",canProgress:!purchased,
      parcels:input.parcels.map((_,index)=>({parcelId:30+index,number:index+1,status:purchased?"ready":"pending",trackingNumber:purchased?`SYNTHETIC-${index}`:null,
        downloadPath:purchased?`/api/returns/admin/portal-preview/live/labels/1/20/parcels/${30+index}/download`:null}))});
    const submit=vi.fn(async()=>{
      await pool.query("INSERT INTO returns.customer_return_authorizations VALUES(20,1,10,'RMA-20',$1) ON CONFLICT DO NOTHING",[now]);
      return status();
    });
    const progress=vi.fn(async()=>{purchased=true;return status();});
    const labels={status:async()=>status(),progress,artifact:vi.fn(async()=>({downloadUrl:"https://labels.test/synthetic.pdf",
      createdAt:now.toISOString(),currency:"USD" as const,amountCents:100,trackingNumber:"SYNTHETIC-0",serviceCode:"synthetic",shipmentId:"synthetic-shipment",
      carrierId:"synthetic-carrier",externalShipmentId:"return-20",labelId:"synthetic-label",labelFormat:"pdf" as const})),retryRejected:async()=>status()};
    const operations=new CustomerReturnCustomerOperationsService({principal,orderAccess:access,ownership,workflows,now:()=>now,
      submissions:{submitForOrder:submit,resumeForOrder:submit,status:async()=>status()},labels});
    const [one,two]=await Promise.all([operations.queueLabels(10,input),operations.queueLabels(10,input)]);
    expect(two).toEqual(one);expect(one.phase).toBe("queued");
    const worker=new CustomerReturnWorkflowWorker({store:workflows,submissions:{submitForOrder:submit},labels,now:()=>now,newToken:randomUUID,report:vi.fn()});
    await worker.run();await worker.run();
    expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({idempotencyKey:input.idempotencyKey}),"guest-order:1:10",scope);
    expect(progress).toHaveBeenCalledTimes(1);
    const restored=await operations.workflowStatus(input.idempotencyKey);expect(restored.phase).toBe("ready");
    expect((await operations.retryWorkflow(input.idempotencyKey)).phase).toBe("ready");await worker.run();expect(progress).toHaveBeenCalledTimes(1);
    expect(await operations.artifact(20,30)).toMatchObject({downloadUrl:"https://labels.test/synthetic.pdf"});
    await pool.query("INSERT INTO returns.customer_return_authorizations VALUES(21,1,11,'RMA-21',$1)",[now]);
    await expect(operations.labelStatus(21)).rejects.toMatchObject({status:404});
    await expect(operations.artifact(21,31)).rejects.toMatchObject({status:404});
    await expect(operations.queueLabels(11,{...input,idempotencyKey:randomUUID()})).rejects.toMatchObject({status:404});
    expect((await operations.listReturns()).returns.map(row=>row.authorizationId)).toEqual([20]);
    const source=await pool.query("SELECT external_customer_id FROM oms.oms_orders ORDER BY id");expect(source.rows).toEqual([{external_customer_id:null},{external_customer_id:null}]);
  });
});
