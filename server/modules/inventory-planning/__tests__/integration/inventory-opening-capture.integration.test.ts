import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { lockOpeningCaptureWorker, PostgresInventoryOpeningCaptureRepository } from "../../infrastructure/inventory-opening-capture.repository";
import { runOpeningCapture } from "../../application/inventory-opening-capture.worker";
import { openingSource } from "../fixtures/inventory-cutover-opening-interface.fixture";

vi.mock("../../../../db",()=>({pool:{}}));
const url=process.env.ECHELON_TEST_DATABASE_URL, disposable=process.env.ECHELON_TEST_DATABASE_DISPOSABLE==="true";
const dbDescribe=url&&disposable?describe:describe.skip;
dbDescribe.sequential("durable inventory opening capture jobs",()=>{
  let database:InventoryCutoverTestDatabase;
  let store:PostgresInventoryOpeningCaptureRepository;
  beforeEach(async()=>{
    database=await createInventoryCutoverTestDatabase(url,disposable,"CREATE SCHEMA inventory");
    await database.pool.query(readFileSync(resolve("migrations/245_inventory_opening_capture_jobs.sql"),"utf8"));
    store=new PostgresInventoryOpeningCaptureRepository(database.pool);
  });
  afterEach(async()=>{await database?.close();});
  it("refuses capture if the dedicated worker has not been started",async()=>{
    await expect(store.enqueue("alice",randomUUID())).rejects.toMatchObject({code:"CUTOVER_CAPTURE_WORKER_OFFLINE"});
    expect((await database.pool.query("SELECT count(*) FROM inventory.opening_capture_jobs")).rows[0].count).toBe("0");
  });
  it("serializes competing starts, replays exact requests, and isolates actors",async()=>{
    await store.heartbeat(); const key=randomUUID();
    const results=await Promise.allSettled([store.enqueue("alice",key),store.enqueue("bob",randomUUID())]);
    expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    const rows=(await database.pool.query("SELECT id,actor,request_key FROM inventory.opening_capture_jobs")).rows;
    expect(rows).toHaveLength(1); const job=rows[0];
    expect(await store.enqueue(job.actor,job.request_key)).toMatchObject({id:job.id,state:"queued"});
    expect(await store.enqueue(job.actor,randomUUID())).toMatchObject({id:job.id});
    await expect(store.status("other",job.id)).rejects.toMatchObject({status:404});
    await expect(store.chunk("other",job.id,0)).rejects.toMatchObject({status:404});
  });
  it("publishes a complete artifact only after all chunks and replays without new capture",async()=>{
    await store.heartbeat(); const key=randomUUID(), job=await store.enqueue("alice",key);
    await expect(store.chunk("alice",job.id,0)).rejects.toMatchObject({status:404});
    const source={capture:vi.fn().mockResolvedValue(openingSource())};
    expect(await runOpeningCapture(store,source,vi.fn())).toBe(true);
    const done=await store.status("alice",job.id); expect(done.state).toBe("complete");
    const parts=[];
    for(let i=0;i<done.chunkCount;i++) parts.push((await store.chunk("alice",job.id,i)).text);
    expect(JSON.parse(parts.join(""))).toEqual(openingSource());
    expect(await store.enqueue("alice",key)).toEqual(done);
    expect(await runOpeningCapture(store,source,vi.fn())).toBe(false);
    expect(source.capture).toHaveBeenCalledOnce();
  });
  it("excludes interrupted partial artifacts after a worker restart",async()=>{
    await store.heartbeat(); const job=await store.enqueue("alice",randomUUID()); await store.claim();
    await store.append(job.id,0,'{"partial":');
    await expect(store.complete(job.id,2)).rejects.toThrow("INCOMPLETE_ARTIFACT");
    await expect(store.chunk("alice",job.id,0)).rejects.toMatchObject({status:404});
    const lock=await database.pool.connect();
    try { expect(await lockOpeningCaptureWorker(lock)).toBe(true); await store.recoverInterrupted(); }
    finally { lock.release(true); }
    expect(await store.status("alice",job.id)).toMatchObject({state:"failed",errorCode:"CUTOVER_CAPTURE_INTERRUPTED"});
    expect((await database.pool.query("SELECT count(*) FROM inventory.opening_capture_chunks")).rows[0].count).toBe("0");
  });
  it("allows only one worker and releases ownership when its connection closes",async()=>{
    const first=await database.pool.connect(),second=await database.pool.connect();
    try { expect(await lockOpeningCaptureWorker(first)).toBe(true); expect(await lockOpeningCaptureWorker(second)).toBe(false); }
    finally {first.release(true);second.release(true);}
  });
  it("expires artifacts and never serves another actor's data",async()=>{
    await store.heartbeat(); const job=await store.enqueue("alice",randomUUID()); await store.claim();
    await store.append(job.id,0,"{}"); await store.complete(job.id,1);
    await expect(store.chunk("bob",job.id,0)).rejects.toMatchObject({status:404});
    await database.pool.query("UPDATE inventory.opening_capture_jobs SET created_at=clock_timestamp()-interval '25 hours' WHERE id=$1",[job.id]);
    await expect(store.status("alice",job.id)).rejects.toMatchObject({status:404});
    await expect(store.chunk("alice",job.id,0)).rejects.toMatchObject({status:404});
    await store.cleanupExpired();
    expect((await database.pool.query("SELECT count(*) FROM inventory.opening_capture_chunks")).rows[0].count).toBe("0");
  });
  it("discards expired queued jobs on restart instead of blocking a new capture",async()=>{
    await store.heartbeat(); const job=await store.enqueue("alice",randomUUID());
    await database.pool.query("UPDATE inventory.opening_capture_jobs SET created_at=clock_timestamp()-interval '25 hours' WHERE id=$1",[job.id]);
    await store.recoverInterrupted();
    expect(await store.claim()).toBeNull();
    expect((await store.enqueue("alice",randomUUID())).id).not.toBe(job.id);
  });
});
