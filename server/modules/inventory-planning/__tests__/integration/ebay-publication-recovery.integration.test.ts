import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql, cutoverCompositionSeedSql, cutoverCompositionLegacyChannelSeedSql,
  installCutoverCompositionMigrations } from "../fixtures/inventory-cutover-composition-database.fixture";
import { PostgresQuantityPublicationAdmission, quantityPublicationScopeLockKey } from "../../infrastructure/quantity-publication-admission.repository";
import { PostgresEbayPublicationRecoveryRepository } from "../../infrastructure/ebay-publication-recovery.repository";
import { EbayPublicationRecoveryService } from "../../application/ebay-publication-recovery.service";
import { observeEbayQuantityRequest, recordQuantityProviderResponse } from "../../application/quantity-provider-request-evidence";
import type { QuantityPublicationScope } from "../../domain/quantity-publication-admission";

vi.mock("../../../../db",()=>({pool:{}}));
const dbDescribe=process.env.ECHELON_TEST_DATABASE_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE==="true" ? describe : describe.skip;
const clock=()=>new Date("2026-10-09T16:00:00Z");
dbDescribe.sequential("explicit eBay republication recovery on disposable PostgreSQL",()=>{
  let database:InventoryCutoverTestDatabase;let sequence=0;
  beforeAll(async()=>{
    database=await createInventoryCutoverTestDatabase(process.env.ECHELON_TEST_DATABASE_URL,true,cutoverCompositionBaseSql);
    await installCutoverCompositionMigrations(database.pool);
    for(const file of ["0709_walmart_quantity_admission.sql","0716_inventory_publication_reconciliation.sql",
      "0729_ebay_listing_sync_recovery.sql","0733_ebay_provider_response_finality.sql","0734_ebay_operator_republication_recovery.sql"]){
      await database.pool.query(readFileSync(resolve(process.cwd(),"migrations",file),"utf8"));
    }
    await database.pool.query(cutoverCompositionSeedSql);
    await database.pool.query(cutoverCompositionLegacyChannelSeedSql);
  },60000);
  afterAll(async()=>{await database?.close();});
  function scope():QuantityPublicationScope{return {destinationKind:"channel_connection",connectionId:1,providerKey:"ebay",providerScopeType:"account",
    externalScopeId:"test-ebay-account",externalInventoryItemId:`RECOVERY-${++sequence}`,productId:20,productVariantId:101};}
  function owner(pool:Pick<Pool,"connect">=database.pool){return new EbayPublicationRecoveryService(new PostgresEbayPublicationRecoveryRepository(pool),clock);}
  async function uncertain(target:QuantityPublicationScope, members:QuantityPublicationScope[]=[]){
    const admission=new PostgresQuantityPublicationAdmission(database.pool,clock);
    const work=()=>observeEbayQuantityRequest({method:"POST",path:"/sell/inventory/v1/bulk_update_price_quantity",
      body:{requests:[{sku:target.externalInventoryItemId,shipToLocationAvailability:{quantity:1116},offers:[]}]}},async()=>{
      // Exact historical shape: a retained 400 body hash, no parsed codes/finality.
      recordQuantityProviderResponse({outcome:"uncertain",httpStatus:400,providerRequestId:null,responseHash:"a".repeat(64),errorCodes:[],retryNotBefore:null,cooldownScope:null});
      throw new Error("historical unknown response");
    });
    await expect(members.length ? admission.runQuantityReducingLifecycle(target,work,members):admission.run(target,work)).rejects.toThrow("historical unknown");
    return (await database.pool.query<{id:string}>("SELECT id::text FROM inventory.quantity_publication_attempts WHERE scope_key=$1 ORDER BY id DESC LIMIT 1",[quantityPublicationScopeLockKey(target)])).rows[0]!.id;
  }
  async function confirmation(scopes:QuantityPublicationScope[]){const preview=await owner().preview(scopes);return {scopes,previewHash:preview.previewHash,idempotencyKey:`resume-${++sequence}`,actor:"operator-1",acknowledgeUnknownOutcome:true as const};}

  it("preserves the historical 400/unknown receipt, audits one decision, wakes current work, and replays without duplicate mutation",async()=>{
    const target=scope();const attemptId=await uncertain(target);
    const before=(await database.pool.query("SELECT to_jsonb(a)-'state' AS value FROM inventory.quantity_publication_attempts a WHERE id=$1",[attemptId])).rows[0].value;
    const preview=await owner().preview([target]);
    expect(preview).toMatchObject({canResume:true,blockReason:null,attempts:[{attemptId,requests:[{httpStatus:400,errorCodes:[],outcome:"uncertain",responseRecorded:true}]}]});
    const command=await confirmation([target]);
    expect(await owner().resume(command)).toEqual({attemptIds:[attemptId],replayed:false,providerWriteAttempted:false});
    expect(await owner().resume(command)).toEqual({attemptIds:[attemptId],replayed:true,providerWriteAttempted:false});
    const after=(await database.pool.query("SELECT state,to_jsonb(a)-'state' AS value FROM inventory.quantity_publication_attempts a WHERE id=$1",[attemptId])).rows[0];
    expect(after).toEqual({state:"superseded_unknown",value:before});
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.quantity_publication_operator_resume_attempts WHERE attempt_id=$1",[attemptId])).rows[0].count).toBe(1);
    const next=vi.fn(async()=>"fresh canonical plan");
    await expect(new PostgresQuantityPublicationAdmission(database.pool,clock).run(target,next)).resolves.toBe("fresh canonical plan");
    expect(next).toHaveBeenCalledOnce();
    expect((await owner().preview([target])).blockReason).toBe("no_pending_attempts");
    expect((await database.pool.query("SELECT request_terminated,http_status,error_codes FROM inventory.quantity_provider_request_results r JOIN inventory.quantity_provider_requests q ON q.id=r.request_id WHERE q.attempt_id=$1",[attemptId])).rows)
      .toEqual([{request_terminated:null,http_status:400,error_codes:[]}]);
  });
  it("requires explicit acknowledgement and rejects changed replay intent",async()=>{
    const target=scope();await uncertain(target);const command=await confirmation([target]);
    await expect(owner().resume({...command,acknowledgeUnknownOutcome:false as true})).rejects.toThrow();
    await owner().resume(command);
    await expect(owner().resume({...command,actor:"different-operator"})).rejects.toMatchObject({code:"EBAY_RECOVERY_REPLAY_CONFLICT"});
  });
  it("classifies concurrent reuse of one command across disjoint scopes and rolls back the losing recovery",async()=>{
    const targets=[scope(),scope()];
    const ids=[await uncertain(targets[0]!),await uncertain(targets[1]!)];
    const commands=[await confirmation([targets[0]!]),await confirmation([targets[1]!])];
    commands[1]!.idempotencyKey=commands[0]!.idempotencyKey;
    const beforeAttempts=(await database.pool.query<{id:string;record:unknown}>(
      "SELECT id::text,to_jsonb(a) AS record FROM inventory.quantity_publication_attempts a WHERE id=ANY($1::bigint[])",[ids])).rows;
    const scopeKeys=targets.map(quantityPublicationScopeLockKey);
    const beforeCatchup=(await database.pool.query<{scope_key:string;record:unknown}>(
      "SELECT scope_key,to_jsonb(c) AS record FROM inventory.quantity_publication_catchup c WHERE scope_key=ANY($1::text[])",[scopeKeys])).rows;
    let arrived=0;
    let releaseBarrier!:()=>void;
    const bothReady=new Promise<void>(resolve=>{releaseBarrier=resolve;});
    const concurrentPool={connect:async()=>{
      const client=await database.pool.connect();
      return new Proxy(client,{get(target,property){
        if(property==="query")return async(sql:string,args?:unknown[])=>{
          if(sql.startsWith("INSERT INTO inventory.quantity_publication_operator_resumes")){
            if(++arrived===2)releaseBarrier();
            await bothReady;
          }
          return client.query(sql,args);
        };
        const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;
      }});
    }};
    const outcomes=await Promise.allSettled(commands.map(command=>owner(concurrentPool).resume(command)));
    expect(outcomes.filter(outcome=>outcome.status==="fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome=>outcome.status==="rejected")).toHaveLength(1);
    const winnerIndex=outcomes.findIndex(outcome=>outcome.status==="fulfilled");
    const loserIndex=1-winnerIndex;
    const loser=outcomes[loserIndex]!;
    if(loser.status!=="rejected")throw new Error("Expected one rejected recovery");
    expect(loser.reason).toMatchObject({code:"EBAY_RECOVERY_REPLAY_CONFLICT"});
    expect((await database.pool.query("SELECT result_payload FROM inventory.quantity_publication_operator_resumes WHERE idempotency_key=$1",
      [commands[0]!.idempotencyKey])).rows).toEqual([{result_payload:{attemptIds:[ids[winnerIndex]],replayed:false,providerWriteAttempted:false}}]);
    expect((await database.pool.query("SELECT to_jsonb(a) AS record FROM inventory.quantity_publication_attempts a WHERE id=$1",[ids[loserIndex]])).rows[0]!.record)
      .toEqual(beforeAttempts.find(attempt=>attempt.id===ids[loserIndex])!.record);
    expect((await database.pool.query("SELECT scope_key,to_jsonb(c) AS record FROM inventory.quantity_publication_catchup c WHERE scope_key=$1",[scopeKeys[loserIndex]])).rows)
      .toEqual(beforeCatchup.filter(catchup=>catchup.scope_key===scopeKeys[loserIndex]));
    expect((await database.pool.query("SELECT attempt_id::text FROM inventory.quantity_publication_operator_resume_attempts WHERE attempt_id=ANY($1::bigint[])",[ids])).rows)
      .toEqual([{attempt_id:ids[winnerIndex]}]);
  });
  it("cannot supersede a live publisher or silently expand a listing scope",async()=>{
    const target=scope();const other=scope();await uncertain(target,[other]);
    expect((await owner().preview([target])).blockReason).toBe("broader_scope");
    const command=await confirmation([target,other]);
    const blocker=await database.pool.connect();
    try{
      await blocker.query("SELECT pg_advisory_lock(hashtextextended($1,918420))",[quantityPublicationScopeLockKey(other)]);
      expect((await owner().preview([target,other])).blockReason).toBe("active_request");
      await expect(owner().resume(command)).rejects.toMatchObject({code:"EBAY_RECOVERY_BUSY"});
    }finally{await blocker.query("SELECT pg_advisory_unlock_all()");blocker.release();}
    expect((await owner().resume(command)).attemptIds).toHaveLength(1);
  });
  it("rejects a changed preview and atomically rolls back every attempt on a persistence failure",async()=>{
    const first=scope();const second=scope();const ids=[await uncertain(first),await uncertain(second)];
    const command=await confirmation([first,second]);
    await database.pool.query("UPDATE inventory.quantity_publication_attempts SET error_code='UPDATED_DIAGNOSTIC' WHERE id=$1",[ids[0]]);
    await expect(owner().resume(command)).rejects.toMatchObject({code:"EBAY_RECOVERY_PREVIEW_CHANGED"});
    const current=await confirmation([first,second]);let transitions=0;
    const faulty={connect:async()=>{const client=await database.pool.connect();return new Proxy(client,{get(target,property){
      if(property==="query") return async(sql:string,args?:unknown[])=>{
        if(sql.startsWith("UPDATE inventory.quantity_publication_attempts SET state='superseded_unknown'") && ++transitions===2)throw new Error("simulated persistence failure");
        return client.query(sql,args);
      };
      const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;
    }});}};
    await expect(owner(faulty).resume(current)).rejects.toThrow("simulated persistence failure");
    expect((await database.pool.query("SELECT state FROM inventory.quantity_publication_attempts WHERE id=ANY($1::bigint[])",[ids])).rows).toEqual([{state:"uncertain"},{state:"uncertain"}]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.quantity_publication_operator_resumes WHERE idempotency_key=$1",[current.idempotencyKey])).rows[0].count).toBe(0);
    expect((await owner().resume(current)).attemptIds).toEqual(ids);
  });
  it("does not permit SQL bypass of receipts or modification of immutable recovery history",async()=>{
    const target=scope();const id=await uncertain(target);
    await expect(database.pool.query("UPDATE inventory.quantity_publication_attempts SET state='superseded_unknown' WHERE id=$1",[id])).rejects.toThrow();
    await owner().resume(await confirmation([target]));
    await expect(database.pool.query("DELETE FROM inventory.quantity_publication_operator_resume_attempts WHERE attempt_id=$1",[id])).rejects.toThrow();
    await expect(database.pool.query("UPDATE inventory.quantity_provider_request_results SET request_terminated=true WHERE request_id IN(SELECT id FROM inventory.quantity_provider_requests WHERE attempt_id=$1)",[id])).rejects.toThrow();
  });
});
