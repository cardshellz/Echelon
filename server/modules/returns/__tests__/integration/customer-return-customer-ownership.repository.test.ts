import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresCustomerReturnCustomerOwnershipReader } from "../../infrastructure/customer-return-customer-ownership.repository";
import { PostgresCustomerReturnSubmissionStore, RETURN_SUBMISSION_LEASE_MS } from "../../infrastructure/customer-return-submission.repository";
import { PostgresCustomerReturnIntakeStore } from "../../infrastructure/customer-return-intake.repository";
import { resolveReturnsTestDatabase } from "../support/disposable-database";
import {
  createIntakeTestSchema, seedIntakeTestSchema, seedPreCarrierSelectionIntake, preparedIntake, INTAKE_KEY, INTAKE_LEASE, INTAKE_NOW,
} from "../support/customer-return-intake-database";
import type { CustomerReturnSubmissionStore } from "../../application/customer-return-submission.service";

const connectionString = resolveReturnsTestDatabase(process.env, "intake");
const integration = connectionString ? describe.sequential : describe.skip;
const principal = { channelId: 36, externalCustomerId: "customer-a" };
const KEY = "00000000-0000-4000-8000-000000000010";
const SECOND_KEY = "00000000-0000-4000-8000-000000000011";
const SECOND_LEASE = "00000000-0000-4000-8000-000000000012";

integration("customer return canonical ownership and immutable command binding on PostgreSQL", () => {
  let pool: Pool;
  let ownership: PostgresCustomerReturnCustomerOwnershipReader;
  let commands: PostgresCustomerReturnSubmissionStore;
  let intake: PostgresCustomerReturnIntakeStore;
  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
    await createIntakeTestSchema(pool);
    ownership = new PostgresCustomerReturnCustomerOwnershipReader(pool);
    commands = new PostgresCustomerReturnSubmissionStore(pool);
    intake = new PostgresCustomerReturnIntakeStore(drizzle(pool, { schema }), () => new Date(INTAKE_NOW));
  });
  beforeEach(async () => {
    await seedIntakeTestSchema(pool);
    await pool.query(`UPDATE oms.oms_orders SET external_customer_id='customer-a';
      INSERT INTO oms.oms_orders(id,channel_id,external_order_id,external_order_number,external_customer_id,ordered_at,ship_to_country)
      OVERRIDING SYSTEM VALUE VALUES
        (101,36,'1001','#TEST-1','customer-b','2026-09-01','US'),
        (102,36,'1002','#TEST-1','customer-a','2026-09-01','US');`);
  });
  afterAll(async () => { await pool?.end(); });

  async function acquireInput(omsOrderId: number, key = KEY): Promise<Parameters<CustomerReturnSubmissionStore["acquire"]>[0]> {
    const original = (await commands.read(36, INTAKE_KEY))!;
    return { channelId: 36, key, omsOrderId, request: { ...original.request, idempotencyKey: key }, hash: "a".repeat(64),
      actor: "admin:test", token: INTAKE_LEASE, now: new Date(INTAKE_NOW) };
  }
  async function accept() {
    await commands.acquire(await acquireInput(100));
    return intake.persist({ ...preparedIntake(), idempotencyKey: KEY });
  }

  it("requires both channel and customer for commands, regardless of duplicated display numbers", async () => {
    await commands.acquire(await acquireInput(100));
    expect(await ownership.readOwnedCommand(principal, KEY)).toEqual({ omsOrderId: 100, authorizationId: null });
    expect(await ownership.readOwnedCommand({ ...principal, externalCustomerId: "customer-b" }, KEY)).toBeNull();
    expect(await ownership.readOwnedCommand({ ...principal, channelId: 37 }, KEY)).toBeNull();
    expect(await ownership.readOwnedCommand({ ...principal, externalCustomerId: "customer-a'OR'1'='1" }, KEY)).toBeNull();
  });
  it("never grants customer access to unbound historical/staff commands", async () => {
    expect((await commands.read(36, INTAKE_KEY))!.omsOrderId).toBeNull();
    expect(await ownership.readOwnedCommand(principal, INTAKE_KEY)).toBeNull();
    await expect(commands.acquire({ ...await acquireInput(100, INTAKE_KEY), request: undefined, hash: undefined }))
      .rejects.toMatchObject({ code: "RETURN_LABEL_COMMAND_CONFLICT" });
  });
  it("fences cross-order retries before changing the command lease", async () => {
    await commands.acquire(await acquireInput(100));
    await expect(commands.acquire({ ...await acquireInput(102), request: undefined, hash: undefined, token: SECOND_LEASE,
      now: new Date(INTAKE_NOW.getTime() + RETURN_SUBMISSION_LEASE_MS + 1) })).rejects.toMatchObject({ code: "RETURN_LABEL_COMMAND_CONFLICT" });
    const saved = await commands.read(36, KEY);
    expect(saved).toMatchObject({ omsOrderId: 100, leaseToken: INTAKE_LEASE });
    await commands.acquire({ ...await acquireInput(100), request: undefined, hash: undefined, token: SECOND_LEASE,
      now: new Date(INTAKE_NOW.getTime() + RETURN_SUBMISSION_LEASE_MS + 1) });
    expect(await commands.read(36, KEY)).toMatchObject({ omsOrderId: 100, leaseToken: SECOND_LEASE });
  });
  it("allows only one canonical order to win concurrent acquisition of the same key", async () => {
    const inputs = await Promise.all([acquireInput(100), acquireInput(102)]);
    const outcomes = await Promise.allSettled(inputs.map(input => commands.acquire(input)));
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failed = outcomes.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: "RETURN_LABEL_COMMAND_CONFLICT" });
    expect((await pool.query("SELECT count(*)::int AS count FROM returns.customer_return_submission_commands WHERE idempotency_key=$1", [KEY])).rows[0].count).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM returns.customer_return_submission_events WHERE idempotency_key=$1", [KEY])).rows[0].count).toBe(1);
  });
  it("enforces immutable order binding and channel ownership in database constraints", async () => {
    await commands.acquire(await acquireInput(100));
    await expect(pool.query("UPDATE returns.customer_return_submission_commands SET oms_order_id=102 WHERE idempotency_key=$1", [KEY]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(commands.acquire(await acquireInput(200, SECOND_KEY))).rejects.toMatchObject({ code: "23514" });
    expect(await commands.read(36, SECOND_KEY)).toBeNull();
  });
  it("does not authorize a different order if preparation drifts after acquisition", async () => {
    await commands.acquire(await acquireInput(102));
    await expect(intake.persist({ ...preparedIntake(), idempotencyKey: KEY })).rejects.toMatchObject({ code: "RETURN_LABEL_SUBMISSION_LEASE_CHANGED" });
    expect((await pool.query("SELECT count(*)::int AS count FROM returns.customer_return_authorizations")).rows[0].count).toBe(0);
    expect(await commands.read(36, KEY)).toMatchObject({ omsOrderId: 102, status: "preparing" });
  });
  it("rejects an accepted command whose canonical binding differs from its authorization", async () => {
    const request = (await commands.read(36, INTAKE_KEY))!.request;
    await pool.query("TRUNCATE returns.customer_return_submission_commands CASCADE");
    await seedPreCarrierSelectionIntake(pool);
    const insert = (omsOrderId: number) => pool.query(`INSERT INTO returns.customer_return_submission_commands
      (channel_id,idempotency_key,request_hash,request_snapshot,status,actor,lease_token,lease_until,authorization_id,created_at,updated_at,oms_order_id)
      VALUES(36,$1,$2,$3,'accepted','admin:test',$4,$5,1,$5,$5,$6)`,
    [INTAKE_KEY, "a".repeat(64), JSON.stringify(request), INTAKE_LEASE, INTAKE_NOW, omsOrderId]);
    await expect(insert(102)).rejects.toMatchObject({ code: "23514" });
    await insert(100);
    expect(await ownership.readOwnedCommand(principal, INTAKE_KEY)).toEqual({ omsOrderId: 100, authorizationId: 1 });
  });
  it("joins accepted RMAs to their original canonical order before exposing labels", async () => {
    const result = await accept();
    expect(await ownership.readOwnedAuthorization(principal, result.authorizationId)).toEqual({ authorizationId: result.authorizationId, omsOrderId: 100 });
    expect(await ownership.readOwnedAuthorization({ ...principal, externalCustomerId: "customer-b" }, result.authorizationId)).toBeNull();
    expect(await ownership.readOwnedAuthorization({ ...principal, channelId: 37 }, result.authorizationId)).toBeNull();
    expect(await ownership.readOwnedCommand(principal, KEY)).toEqual({ authorizationId: result.authorizationId, omsOrderId: 100 });
  });
  it("keeps accepted history visible when current policy is retired and new labels are paused", async () => {
    const result = await accept();
    await pool.query("UPDATE returns.return_policies SET status='retired',retired_by='test',retired_at=$1 WHERE id=1", [INTAKE_NOW]);
    await pool.query("UPDATE returns.customer_return_label_controls SET paused=true,version=2,updated_by='test',updated_at=$1 WHERE channel_id=36", [INTAKE_NOW]);
    const history = await ownership.listReturns(principal, { pageSize: 10 });
    expect(history).toEqual([{ authorizationId: result.authorizationId, authorizationNumber: result.authorizationNumber,
      omsOrderId: 100, orderReference: "#TEST-1", createdAt: INTAKE_NOW.toISOString() }]);
    expect(await ownership.listReturns({ ...principal, externalCustomerId: "customer-b" }, { pageSize: 10 })).toEqual([]);
    expect(await ownership.listReturns({ ...principal, channelId: 37 }, { pageSize: 10 })).toEqual([]);
    expect(await ownership.listReturns(principal, { pageSize: 10, beforeAuthorizationId: result.authorizationId })).toEqual([]);
  });
  it("checks current owner on each read instead of treating a prior lookup as a grant", async () => {
    const result = await accept();
    expect(await ownership.readOwnedAuthorization(principal, result.authorizationId)).not.toBeNull();
    await pool.query("UPDATE oms.oms_orders SET external_customer_id='customer-b' WHERE id=100");
    expect(await ownership.readOwnedAuthorization(principal, result.authorizationId)).toBeNull();
    expect(await ownership.readOwnedCommand(principal, KEY)).toBeNull();
    expect(await ownership.listReturns(principal, { pageSize: 10 })).toEqual([]);
  });
  it("sanitizes database failures rather than reporting a missing owned resource", async () => {
    await pool.query("ALTER TABLE oms.oms_orders RENAME TO hidden_orders");
    try {
      await expect(ownership.readOwnedCommand(principal, KEY)).rejects.toMatchObject({ code: "CUSTOMER_RETURN_ACCESS_UNAVAILABLE", status: 503 });
    } finally { await pool.query("ALTER TABLE oms.hidden_orders RENAME TO oms_orders"); }
  });
});
