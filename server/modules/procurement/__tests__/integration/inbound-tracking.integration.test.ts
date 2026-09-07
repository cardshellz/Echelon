import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InboundTrackingRepository } from "../../inbound-tracking.repository";
import { InboundTrackingService } from "../../inbound-tracking.service";
import { InboundTrackingProviderError, parseSeaRatesTracking, TRACKING_LEASE_MS, TRACKING_MINIMUM_REFRESH_MS, TRACKING_SUCCESS_INTERVAL_MS } from "../../inbound-tracking.domain";
import { oceanConfig, oceanPayload } from "../unit/inbound-tracking.fixtures";
import type { InboundTrackingConfig, SaveInboundTracking } from "@shared/procurement/inbound-tracking";
const url = process.env.ECHELON_TEST_DATABASE_URL;
const suite = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
suite.sequential("inbound tracking PostgreSQL owner", () => {
  let pool: pg.Pool; let lease: pg.PoolClient | undefined; let ownsSchema = false;
  let repository: InboundTrackingRepository; let shipmentId = 0;
  const now = new Date("2026-09-07T12:00:00Z");
  const later = (milliseconds: number) => new Date(now.getTime() + milliseconds);
  const snapshot = () => parseSeaRatesTracking(oceanPayload(), oceanConfig.identity);
  const command = (config: InboundTrackingConfig = oceanConfig): SaveInboundTracking => ({ requestKey: randomUUID(), referenceId: null, expectedRevision: 0, config: structuredClone(config) });
  beforeAll(async () => {
    if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname) || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(url)) throw new Error("Tracking integration tests require a separate local disposable database");
    pool = new pg.Pool({ connectionString: url, max: 8, statement_timeout: 10_000 });
    lease = await pool.connect();
    const acquired = await lease.query("SELECT pg_try_advisory_lock(hashtext('echelon.procurement.cost-audit-fixture')) AS acquired");
    if (!acquired.rows[0].acquired) throw new Error("Another procurement fixture owns the schema lease");
    await pool.query("CREATE SCHEMA procurement"); ownsSchema = true;
    await pool.query("CREATE TABLE procurement.inbound_shipments(id integer PRIMARY KEY, status text NOT NULL)");
    const migration = readFileSync(resolve(process.cwd(), "migrations/229_procurement_inbound_tracking.sql"), "utf8");
    await pool.query(migration); await pool.query(migration);
    repository = new InboundTrackingRepository(pool);
  });
  beforeEach(async () => {
    await pool.query("UPDATE procurement.inbound_tracking_references SET enabled=false, lease_until=NULL");
    shipmentId++; await pool.query("INSERT INTO procurement.inbound_shipments VALUES($1,'in_transit')", [shipmentId]);
  });
  afterAll(async () => {
    try { if (ownsSchema) await pool.query("DROP SCHEMA procurement CASCADE"); }
    finally { lease?.release(); await pool?.end(); }
  });
  it("records immutable actor/before/after evidence and replays the same command without creating another reference", async () => {
    const request = command(); const saved = await repository.save(shipmentId, request, "tracking-operator", now);
    expect(await repository.save(shipmentId, request, "tracking-operator", later(1_000))).toEqual(saved);
    const refs = await repository.read(shipmentId); expect(refs).toHaveLength(1); expect(refs[0]).toMatchObject({ revision: 1, config: oceanConfig, current: null });
    const history = await repository.history(shipmentId, saved.referenceId, null);
    expect(history.changes).toEqual([{ revision: 1, actorId: "tracking-operator", recordedAt: now.toISOString(), before: null, after: oceanConfig }]);
    await expect(repository.save(shipmentId, { ...request, config: { ...oceanConfig, enabled: false } }, "tracking-operator", now)).rejects.toMatchObject({ code: "TRACKING_IDEMPOTENCY_CONFLICT" });
  });
  it("serializes duplicate concurrent creates and rejects duplicate identities without depending on request keys", async () => {
    const request = command(); const [a,b] = await Promise.all([repository.save(shipmentId,request,"operator",now),repository.save(shipmentId,request,"operator",now)]);
    expect(a).toEqual(b); expect(await repository.read(shipmentId)).toHaveLength(1);
    await expect(repository.save(shipmentId,command(),"operator",now)).rejects.toMatchObject({ code: "TRACKING_REFERENCE_EXISTS" });
  });
  it("allows exactly one concurrent expected-revision editor and preserves the original identity", async () => {
    const original = await repository.save(shipmentId, command(), "operator", now);
    const outcomes = await Promise.allSettled([false,true].map((includeVesselPosition) => repository.save(shipmentId,{ ...command(),referenceId:original.referenceId,expectedRevision:1,config:{...oceanConfig,includeVesselPosition}},"operator",now)));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({reason:{code:"TRACKING_REVISION_CONFLICT"}});
    await expect(repository.save(shipmentId,{ ...command(),referenceId:original.referenceId,expectedRevision:2,config:{...oceanConfig,identity:{...oceanConfig.identity,reference:"TEST7654321"}}},"operator",now)).rejects.toMatchObject({code:"TRACKING_IDENTITY_IMMUTABLE"});
  });
  it("rolls back configuration when its immutable command write fails", async () => {
    await pool.query("CREATE FUNCTION procurement.tracking_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture command failure'; END $$");
    await pool.query("CREATE TRIGGER tracking_test_failure BEFORE INSERT ON procurement.inbound_tracking_commands FOR EACH ROW EXECUTE FUNCTION procurement.tracking_test_failure()");
    try { await expect(repository.save(shipmentId, command(), "operator", now)).rejects.toThrow("fixture command failure"); expect(await repository.read(shipmentId)).toEqual([]); }
    finally { await pool.query("DROP TRIGGER tracking_test_failure ON procurement.inbound_tracking_commands"); await pool.query("DROP FUNCTION procurement.tracking_test_failure()"); }
  });
  it("claims work once across concurrent workers and applies an idempotent completion", async () => {
    await repository.save(shipmentId, command(), "operator", now);
    const claims = await Promise.all([repository.claim(now,["searates"]),repository.claim(now,["searates"])]);
    expect(claims.filter(Boolean)).toHaveLength(1); const claim = claims.find(Boolean)!;
    expect(await Promise.all([repository.complete(claim,later(500),{snapshot:snapshot()}),repository.complete(claim,later(500),{snapshot:snapshot()})])).toEqual(["applied","applied"]);
    const reference = (await repository.read(shipmentId))[0]; expect(reference.current?.status).toBe("IN_TRANSIT"); expect(reference.lastSuccessAt).toBe(later(500).toISOString());
    expect((await repository.history(shipmentId,reference.id,null)).attempts).toHaveLength(1);
  });
  it("rolls back a partially applied observation when writing the attempt fails, then safely retries", async () => {
    await repository.save(shipmentId,command(),"operator",now); const claim=(await repository.claim(now,["searates"]))!;
    await pool.query("CREATE FUNCTION procurement.tracking_attempt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture attempt failure'; END $$");
    await pool.query("CREATE TRIGGER tracking_attempt_failure BEFORE INSERT ON procurement.inbound_tracking_attempts FOR EACH ROW EXECUTE FUNCTION procurement.tracking_attempt_failure()");
    try {
      await expect(repository.complete(claim,later(1),{snapshot:snapshot()})).rejects.toThrow("fixture attempt failure");
      expect((await repository.read(shipmentId))[0].current).toBeNull();
      expect((await repository.history(shipmentId,claim.referenceId,null)).observations).toHaveLength(0);
    } finally { await pool.query("DROP TRIGGER tracking_attempt_failure ON procurement.inbound_tracking_attempts"); await pool.query("DROP FUNCTION procurement.tracking_attempt_failure()"); }
    expect(await repository.complete(claim,later(2),{snapshot:snapshot()})).toBe("applied");
  });
  it("reclaims expired leases and records late results without promoting them", async () => {
    await repository.save(shipmentId, command(), "operator", now);
    const first = (await repository.claim(now,["searates"]))!;
    const second = (await repository.claim(later(TRACKING_LEASE_MS+1),["searates"]))!;
    expect(second.version).toBe(first.version+1);
    const newer = { ...snapshot(), status:"CORRECTED", sourceUpdatedAt:"2026-09-07T11:00:00.000Z" };
    expect(await repository.complete(second,later(TRACKING_LEASE_MS+2),{snapshot:newer})).toBe("applied");
    expect(await repository.complete(first,later(TRACKING_LEASE_MS+3),{snapshot:snapshot()})).toBe("superseded_lease");
    expect((await repository.read(shipmentId))[0].current?.status).toBe("CORRECTED");
    expect((await repository.history(shipmentId,first.referenceId,null)).observations).toHaveLength(2);
  });
  it("retains stale cached observations without regressing a newer carrier revision", async () => {
    await repository.save(shipmentId,command(),"operator",now);
    const first=(await repository.claim(now,["searates"]))!; await repository.complete(first,later(100),{snapshot:snapshot()});
    const second=(await repository.claim(later(TRACKING_SUCCESS_INTERVAL_MS+101),["searates"]))!;
    const older={...snapshot(),status:"OLDER",sourceUpdatedAt:"2026-09-06T10:00:00.000Z"};
    expect(await repository.complete(second,later(TRACKING_SUCCESS_INTERVAL_MS+102),{snapshot:older})).toBe("stale_source");
    const reference=(await repository.read(shipmentId))[0]; expect(reference.current?.status).toBe("IN_TRANSIT"); expect(reference.lastErrorCode).toBe("TRACKING_STALE_SOURCE");
    expect((await repository.history(shipmentId,reference.id,null)).observations).toHaveLength(2);
  });
  it("deduplicates unchanged observations across polls while retaining every attempt", async () => {
    await repository.save(shipmentId,command(),"operator",now);
    const first=(await repository.claim(now,["searates"]))!; await repository.complete(first,later(100),{snapshot:snapshot()});
    const second=(await repository.claim(later(TRACKING_SUCCESS_INTERVAL_MS+101),["searates"]))!;
    expect(await repository.complete(second,later(TRACKING_SUCCESS_INTERVAL_MS+102),{snapshot:snapshot()})).toBe("duplicate");
    const history=await repository.history(shipmentId,first.referenceId,null); expect(history.observations).toHaveLength(1); expect(history.attempts).toHaveLength(2);
  });
  it("pausing tracking invalidates in-flight work without deleting its evidence", async () => {
    const saved=await repository.save(shipmentId,command(),"operator",now); const claim=(await repository.claim(now,["searates"]))!;
    await repository.save(shipmentId,{...command(),referenceId:saved.referenceId,expectedRevision:1,config:{...oceanConfig,enabled:false}},"operator",later(1));
    expect(await repository.complete(claim,later(2),{snapshot:snapshot()})).toBe("superseded_lease");
    const reference=(await repository.read(shipmentId))[0]; expect(reference.current).toBeNull(); expect(reference.config.enabled).toBe(false); expect(await repository.claim(later(100_000),["searates"])).toBeNull();
  });
  it("stores retry state and immutable failures, then resumes using the same reference", async () => {
    await repository.save(shipmentId,command(),"operator",now); const claim=(await repository.claim(now,["searates"]))!;
    expect(await repository.complete(claim,later(1),{failure:{code:"SEARATES_HTTP_429",message:"Provider rate limit",retryable:true,retryAfterMs:3_600_000}})).toBe("retry");
    const reference=(await repository.read(shipmentId))[0]; expect(reference).toMatchObject({failureCount:1,lastSuccessAt:null,lastErrorCode:"SEARATES_HTTP_429",reviewRequired:false,nextPollAt:later(3_600_001).toISOString()});
    expect(await repository.claim(later(3_600_000),["searates"])).toBeNull(); expect(await repository.claim(later(3_600_001),["searates"])).not.toBeNull();
  });
  it("stops permanent failures until explicit operator refresh and rate-limits refresh commands", async () => {
    const saved=await repository.save(shipmentId,command(),"operator",now); const claim=(await repository.claim(now,["searates"]))!;
    await repository.complete(claim,later(1),{failure:{code:"REFERENCE_MISMATCH",message:"Provider identity mismatch",retryable:false,retryAfterMs:null}});
    expect(await repository.claim(later(86_400_000),["searates"])).toBeNull();
    await expect(repository.requestRefresh(shipmentId,saved.referenceId,randomUUID(),"operator",later(2))).rejects.toMatchObject({code:"TRACKING_REFRESH_COOLDOWN"});
    const key=randomUUID(); const refreshed=await repository.requestRefresh(shipmentId,saved.referenceId,key,"operator",later(TRACKING_MINIMUM_REFRESH_MS));
    expect(await repository.requestRefresh(shipmentId,saved.referenceId,key,"operator",later(TRACKING_MINIMUM_REFRESH_MS+1))).toEqual(refreshed);
    expect((await repository.read(shipmentId))[0].reviewRequired).toBe(false);
  });
  it("never changes manual shipment status or creates warehouse stock from carrier delivery", async () => {
    await repository.save(shipmentId,command(),"operator",now); const claim=(await repository.claim(now,["searates"]))!;
    await repository.complete(claim,later(1),{snapshot:{...snapshot(),status:"DELIVERED"}});
    expect((await pool.query("SELECT status FROM procurement.inbound_shipments WHERE id=$1",[shipmentId])).rows[0].status).toBe("in_transit");
    expect((await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='procurement' ORDER BY table_name")).rows.map((row)=>row.table_name)).toEqual(["inbound_shipments","inbound_tracking_attempts","inbound_tracking_commands","inbound_tracking_observations","inbound_tracking_references"]);
  });
  it("prevents history deletion and shipment deletion after tracking evidence is attached", async () => {
    const saved=await repository.save(shipmentId,command(),"operator",now); const claim=(await repository.claim(now,["searates"]))!; await repository.complete(claim,later(1),{snapshot:snapshot()});
    for (const table of ["inbound_tracking_observations","inbound_tracking_attempts","inbound_tracking_commands"]) {
      await expect(pool.query(`DELETE FROM procurement.${table} WHERE reference_id=$1`,[saved.referenceId])).rejects.toThrow("immutable");
    }
    await expect(pool.query("UPDATE procurement.inbound_tracking_references SET reference='TEST7654321' WHERE id=$1",[saved.referenceId])).rejects.toThrow("identity is immutable");
    await expect(pool.query("DELETE FROM procurement.inbound_shipments WHERE id=$1",[shipmentId])).rejects.toMatchObject({code:"23503"});
  });
  it("does not poll closed/cancelled shipments or providers without configured credentials", async () => {
    await repository.save(shipmentId,command(),"operator",now);
    expect(await repository.claim(now,["shipstation"])).toBeNull();
    await pool.query("UPDATE procurement.inbound_shipments SET status='closed' WHERE id=$1",[shipmentId]);
    expect(await repository.claim(now,["searates"])).toBeNull();
    await expect(repository.save(shipmentId,command(),"operator",now)).rejects.toMatchObject({code:"TRACKING_SHIPMENT_INACTIVE"});
  });
  it("runs the application provider-to-storage path and records classified provider failures", async () => {
    await repository.save(shipmentId,command(),"operator",now);
    const fetch=vi.fn(async()=>{throw new InboundTrackingProviderError("SEARATES_TIMEOUT","SeaRates tracking request timed out.",true);});
    const logger={info:vi.fn(),error:vi.fn()};
    const service=new InboundTrackingService(repository,{searates:{configured:()=>true,fetch},shipstation:{configured:()=>false,fetch:vi.fn()}},true,()=>now,logger);
    expect(await service.poll()).toEqual({claimed:1,failed:1});
    expect((await service.read(shipmentId)).references[0].lastErrorCode).toBe("SEARATES_TIMEOUT");
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({event:"procurement.inbound_tracking.poll_completed",outcome:"retry"}));
    const disabled=new InboundTrackingService(repository,{searates:{configured:()=>true,fetch},shipstation:{configured:()=>false,fetch:vi.fn()}},false,()=>now,logger);
    expect(await disabled.poll()).toEqual({claimed:0,failed:0});
    await expect(disabled.refresh(shipmentId,1,{requestKey:randomUUID()},"operator")).rejects.toMatchObject({code:"TRACKING_POLLING_DISABLED"});
  });
  it("paginates retained observations without losing older evidence", async () => {
    const saved=await repository.save(shipmentId,command(),"operator",now);
    for(let index=0;index<26;index++) {
      const start=later(index*(TRACKING_SUCCESS_INTERVAL_MS+2)); const claim=(await repository.claim(start,["searates"]))!;
      await repository.complete(claim,new Date(start.getTime()+1),{snapshot:{...snapshot(),status:`OBSERVATION_${index}`}});
    }
    const latest=await repository.history(shipmentId,saved.referenceId,null); expect(latest.observations).toHaveLength(25); expect(latest.nextObservationCursor).not.toBeNull();
    const older=await repository.history(shipmentId,saved.referenceId,latest.nextObservationCursor); expect(older.observations).toHaveLength(1); expect(older.observations[0].snapshot.status).toBe("OBSERVATION_0"); expect(older.nextObservationCursor).toBeNull();
  });
  it("enforces the explicit per-shipment reference bound without partial writes", async () => {
    for(let index=0;index<20;index++) await repository.save(shipmentId,command({...oceanConfig,identity:{...oceanConfig.identity,reference:`TEST${String(index).padStart(7,"0")}`}}),"operator",now);
    await expect(repository.save(shipmentId,command(),"operator",now)).rejects.toMatchObject({code:"TRACKING_REFERENCE_LIMIT"});
    expect(await repository.read(shipmentId)).toHaveLength(20);
  });
  it("validates inputs and actors before any side effects", async () => {
    const provider={configured:()=>false,fetch:vi.fn()};
    const service=new InboundTrackingService(repository,{searates:provider,shipstation:provider},false,()=>now,{info:vi.fn(),error:vi.fn()});
    await expect(service.save(shipmentId,command(),null)).rejects.toThrow();
    await expect(service.save(shipmentId,{...command(),unsafe:true},"operator")).rejects.toThrow();
    expect(await repository.read(shipmentId)).toEqual([]);
    await expect(service.history(shipmentId,1,"9223372036854775808")).rejects.toThrow();
  });
});
