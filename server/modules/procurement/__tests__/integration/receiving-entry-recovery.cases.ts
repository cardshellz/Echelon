import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { receivingEntryCommandResultSchema } from "@shared/procurement/receiving-entry-command";
import { createDrizzleFinancialCommandRepository } from "../../../../platform/commands/command-results.repository";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";
import type { QuantityLedgerTestContext } from "../../../inventory/__tests__/fixtures/quantity-ledger-database";
import { createReceivingEntryCommands, hashReceivingEntryCommandIdentity, receivingEntryCommandScope, RECEIVING_ENTRY_COMMAND_PRINCIPAL } from "../../receiving-entry.commands";
import type { ReceivingService } from "../../receiving.service";

/** Registered by the existing active-ledger receipt suite: all owners, authority,
 * command storage, row locks, stock journals and audit writes use PostgreSQL. */
export function registerReceivingEntryRecoveryCases(harness: {
  context(): QuantityLedgerTestContext; service(): ReceivingService; actorId: string; now: Date;
}): void {
  const intent = { action: "add-line", targetId: 50, payload: { sku: "P5", productName: "Synthetic five-piece case",
    productId: 20, productVariantId: 101, expectedUnitsPerVariant: 5, expectedQty: 5, receivedQty: 5,
    putawayLocationId: 100, unitCost: 2, unitCostMills: 200 } } as const;
  const pool = () => harness.context().pool;
  function execute(name: string, command: unknown = intent, actorId = harness.actorId, owner: Parameters<typeof createReceivingEntryCommands>[0] = harness.service()) {
    const descriptor: FinancialCommandDescriptor = { ...receivingEntryCommandScope(), actorType: "service", actorId: RECEIVING_ENTRY_COMMAND_PRINCIPAL,
      idempotencyKey: `receiving-entry:${name}`, requestHash: hashReceivingEntryCommandIdentity(command, actorId), contractVersion: 1 };
    return createReceivingEntryCommands(owner, createDrizzleFinancialCommandRepository(drizzle(pool(), { schema }))).execute(command, actorId, descriptor);
  }
  async function emptyReceipt() { await pool().query("DELETE FROM procurement.receiving_lines WHERE receiving_order_id=50"); }
  async function counts() {
    return (await pool().query(`SELECT
      (SELECT count(*)::int FROM procurement.receiving_lines WHERE receiving_order_id=50) AS lines,
      (SELECT received_total_units FROM procurement.receiving_orders WHERE id=50) AS total,
      (SELECT count(*)::int FROM public.audit_events WHERE action LIKE 'procurement.receiving.entry.%') AS audits,
      (SELECT count(*)::int FROM inventory.inventory_transactions WHERE receiving_order_id=50 AND transaction_type='receipt') AS stock_receipts,
      (SELECT variant_qty FROM inventory.inventory_levels WHERE product_variant_id=101 AND warehouse_location_id=100) AS on_hand`)).rows[0];
  }
  async function waitFor(name: string, condition: "claimed" | "due") {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await pool().query("SELECT status,next_attempt_at <= clock_timestamp() AS due FROM public.financial_command_results WHERE actor_id=$1 AND idempotency_key=$2",
        [RECEIVING_ENTRY_COMMAND_PRINCIPAL, `receiving-entry:${name}`]);
      if (condition === "claimed" ? result.rows[0]?.status === "claimed" : result.rows[0]?.due === true) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Receiving command did not become ${condition}`);
  }

  describe("receiving entry durable recovery", () => {
    it("serializes concurrent receipt entries after 999 and preserves the captured creation time on replay", async () => {
      const prefix = `RCV-${harness.now.toISOString().slice(0, 10).replaceAll("-", "")}-`;
      await pool().query(`INSERT INTO procurement.receiving_orders(receipt_number,source_type,status)
        VALUES($1,'blind','draft'),($2,'blind','cancelled'),($3,'blind','draft')`, [`${prefix}999`, `${prefix}1000`, `${prefix}9999x`]);
      const command = { action: "create", targetId: null, payload: { sourceType: "blind", warehouseId: 1 } };
      const results = await Promise.all([execute("number-one", command), execute("number-two", command), execute("number-three", command)]);
      const receipts = results.map(result => receivingEntryCommandResultSchema.parse(result.body));
      expect(receipts.map(receipt => receipt.receiptNumber).sort()).toEqual([`${prefix}1001`, `${prefix}1002`, `${prefix}1003`]);
      expect(await execute("number-one", command)).toMatchObject({ replayed: true, body: results[0].body });
      const persisted = await pool().query("SELECT created_at,updated_at FROM procurement.receiving_orders WHERE id=ANY($1::integer[])", [receipts.map(receipt => receipt.id)]);
      expect(persisted.rows).toEqual(Array.from({ length: 3 }, () => ({ created_at: harness.now, updated_at: harness.now })));
    });

    it("rejects exhausted receipt numbering durably without inserting custody or stock", async () => {
      const prefix = `RCV-${harness.now.toISOString().slice(0, 10).replaceAll("-", "")}-`;
      await pool().query("INSERT INTO procurement.receiving_orders(receipt_number,source_type,status) VALUES($1,'blind','draft')", [prefix + "9".repeat(50 - prefix.length)]);
      const before = await counts();
      const headerCount = (await pool().query("SELECT count(*)::int AS count FROM procurement.receiving_orders")).rows[0].count;
      const command = { action: "create", targetId: null, payload: { sourceType: "blind", warehouseId: 1 } };
      const first = await execute("number-exhausted", command);
      expect(first).toMatchObject({ terminalState: "rejected", httpStatus: 409, body: { code: "DOCUMENT_NUMBER_EXHAUSTED" } });
      expect(await execute("number-exhausted", command)).toMatchObject({ replayed: true, body: first.body });
      expect(await counts()).toEqual(before);
      expect((await pool().query("SELECT count(*)::int AS count FROM procurement.receiving_orders")).rows[0].count).toBe(headerCount);
    });

    it("recovers a lost Add Line response and closes exactly one five-case batch", async () => {
      await emptyReceipt();
      const first = await execute("lost-line-response"); // Simulate committed response lost before reaching the operator.
      const replay = await execute("lost-line-response");
      expect(replay).toMatchObject({ replayed: true, body: first.body });
      expect(await counts()).toEqual({ lines: 1, total: 5, audits: 1, stock_receipts: 0, on_hand: 20 });
      const auditBefore = (await pool().query("SELECT * FROM public.audit_events WHERE action='procurement.receiving.entry.add-line'")).rows;
      await expect(pool().query("UPDATE public.audit_events SET changes='{}' WHERE action='procurement.receiving.entry.add-line'"))
        .rejects.toMatchObject({ code: "23514" });
      expect((await pool().query("SELECT * FROM public.audit_events WHERE action='procurement.receiving.entry.add-line'")).rows).toEqual(auditBefore);
      await harness.service().close(50, harness.actorId);
      expect(await counts()).toMatchObject({ lines: 1, total: 5, stock_receipts: 1, on_hand: 25 });
      expect((await pool().query("SELECT sum(received_qty * units_per_variant_snapshot)::int AS pieces FROM procurement.receiving_lines WHERE receiving_order_id=50")).rows[0].pieces).toBe(25);
      const closed = await counts();
      expect(await execute("lost-line-response")).toMatchObject({ replayed: true, body: first.body });
      await harness.service().close(50, harness.actorId);
      expect(await counts()).toEqual(closed);
      expect(await execute("fresh-after-close")).toMatchObject({ terminalState: "rejected", httpStatus: 409 });
      expect(await counts()).toEqual(closed);
    });

    it("keeps legitimate identical physical batches separate when each has its own intent key", async () => {
      await emptyReceipt();
      const first = receivingEntryCommandResultSchema.parse((await execute("physical-batch-one")).body);
      const second = receivingEntryCommandResultSchema.parse((await execute("physical-batch-two")).body);
      expect(first.entryCommand.receivingLineId).not.toBe(second.entryCommand.receivingLineId);
      await harness.service().close(50, harness.actorId);
      expect(await counts()).toMatchObject({ lines: 2, total: 10, audits: 2, stock_receipts: 2, on_hand: 30 });
    });

    it("recovers manual creation after its response is lost, even after the resulting header changes", async () => {
      const command = { action: "create", targetId: null, payload: { sourceType: "blind", warehouseId: 1, notes: "Reviewed manual receipt" } };
      const first = await execute("lost-create-response", command);
      const result = receivingEntryCommandResultSchema.parse(first.body);
      await harness.service().updateOrderDetails(result.id, { notes: "Later saved note" }, harness.actorId);
      expect(await execute("lost-create-response", command)).toMatchObject({ replayed: true, body: first.body });
      expect((await pool().query("SELECT count(*)::int AS count FROM procurement.receiving_orders WHERE created_by=$1", [harness.actorId])).rows[0].count).toBe(1);
      expect((await pool().query("SELECT notes FROM procurement.receiving_orders WHERE id=$1", [result.id])).rows[0].notes).toBe("Later saved note");
      expect((await pool().query("SELECT actor,timestamp,changes,context FROM public.audit_events WHERE action='procurement.receiving.entry.create'")).rows)
        .toEqual([expect.objectContaining({ actor: harness.actorId, timestamp: harness.now,
          changes: expect.objectContaining({ before: null, after: expect.objectContaining({ id: result.id, createdBy: harness.actorId }) }),
          context: { receivingOrderId: result.id, commandKey: "receiving-entry:lost-create-response" } })]);
    });

    it.each([
      { ...intent, targetId: 51 }, { ...intent, payload: { ...intent.payload, receivedQty: 6 } },
      { action: "create", targetId: null, payload: {} },
    ])("refuses to reuse a committed command key for another action, target or quantity %j", async changed => {
      await emptyReceipt();
      await execute("changed-identity");
      const before = await counts();
      await expect(execute("changed-identity", changed)).rejects.toMatchObject({ statusCode: 422, code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" });
      expect(await counts()).toEqual(before);
    });

    it("refuses the original key from another currently authorized operator", async () => {
      await emptyReceipt();
      await execute("actor-bound");
      await expect(execute("actor-bound", intent, "another-receiver")).rejects.toMatchObject({ statusCode: 422, code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" });
      expect(await counts()).toMatchObject({ lines: 1, audits: 1 });
    });

    it("keeps a concurrent same-key attempt pending until the owner commits, then replays once", async () => {
      await emptyReceipt();
      const blocker = await pool().connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM procurement.receiving_orders WHERE id=50 FOR UPDATE");
      const first = execute("concurrent");
      try {
        await waitFor("concurrent", "claimed");
        await expect(execute("concurrent")).rejects.toMatchObject({ statusCode: 409, code: "FINANCIAL_COMMAND_IN_PROGRESS" });
      } finally { await blocker.query("ROLLBACK"); blocker.release(); }
      const committed = await first;
      expect(await execute("concurrent")).toMatchObject({ replayed: true, body: committed.body });
      expect(await counts()).toMatchObject({ lines: 1, total: 5, audits: 1 });
    });

    it.each(["audit", "result"] as const)("rolls back the line, totals and audit when %s persistence fails, then safely retries", async failure => {
      await emptyReceipt();
      const before = await counts();
      const table = failure === "audit" ? "public.audit_events" : "public.financial_command_results";
      const operation = failure === "audit" ? "INSERT" : "UPDATE";
      const condition = failure === "audit" ? "NEW.action LIKE 'procurement.receiving.entry.%'" : "NEW.actor_id='procurement.receiving-entry' AND NEW.status='succeeded'";
      await pool().query(`CREATE FUNCTION public.reject_receiving_entry_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF ${condition} THEN RAISE EXCEPTION 'receiving entry injected ${failure} failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_receiving_entry_test BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION public.reject_receiving_entry_test()`);
      await expect(execute(`rollback-${failure}`)).rejects.toThrow();
      expect(await counts()).toEqual(before);
      await pool().query(`DROP TRIGGER reject_receiving_entry_test ON ${table}; DROP FUNCTION public.reject_receiving_entry_test()`);
      await waitFor(`rollback-${failure}`, "due");
      expect(await execute(`rollback-${failure}`)).toMatchObject({ terminalState: "succeeded", replayed: false });
      expect(await counts()).toMatchObject({ lines: 1, total: 5, audits: 1 });
    });

    it("rolls back a malformed owner result and preserves the same retry intent", async () => {
      await emptyReceipt();
      const service = harness.service();
      const badOwner = { assertEntryAuthority: service.assertEntryAuthority.bind(service),
        async executeEntryInTransaction(...args: Parameters<ReceivingService["executeEntryInTransaction"]>) {
          const actual = await service.executeEntryInTransaction(...args);
          return { ...actual, receivingLineId: -1 };
        } };
      const before = await counts();
      await expect(execute("malformed-result", intent, harness.actorId, badOwner)).rejects.toMatchObject({ code: "RECEIVING_ENTRY_RESULT_INVALID" });
      expect(await counts()).toEqual(before);
      await waitFor("malformed-result", "due");
      expect(await execute("malformed-result")).toMatchObject({ terminalState: "succeeded" });
      expect(await counts()).toMatchObject({ lines: 1, audits: 1 });
    });

    it.each(["audit", "result"] as const)("rolls back manual creation when %s persistence fails and recovers exactly one draft", async failure => {
      const command = { action: "create", targetId: null, payload: { sourceType: "blind", warehouseId: 1 } };
      const table = failure === "audit" ? "public.audit_events" : "public.financial_command_results";
      const operation = failure === "audit" ? "INSERT" : "UPDATE";
      const condition = failure === "audit" ? "NEW.action='procurement.receiving.entry.create'" : "NEW.actor_id='procurement.receiving-entry' AND NEW.status='succeeded'";
      await pool().query(`CREATE FUNCTION public.reject_receiving_creation_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF ${condition} THEN RAISE EXCEPTION 'receiving creation injected ${failure} failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_receiving_creation_test BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION public.reject_receiving_creation_test()`);
      await expect(execute(`create-rollback-${failure}`, command)).rejects.toThrow();
      expect((await pool().query("SELECT count(*)::int AS count FROM procurement.receiving_orders WHERE created_by=$1", [harness.actorId])).rows[0].count).toBe(0);
      expect((await pool().query("SELECT count(*)::int AS count FROM public.audit_events WHERE action='procurement.receiving.entry.create'")).rows[0].count).toBe(0);
      await pool().query(`DROP TRIGGER reject_receiving_creation_test ON ${table}; DROP FUNCTION public.reject_receiving_creation_test()`);
      await waitFor(`create-rollback-${failure}`, "due");
      const committed = await execute(`create-rollback-${failure}`, command);
      expect(committed).toMatchObject({ terminalState: "succeeded" });
      expect(await execute(`create-rollback-${failure}`, command)).toMatchObject({ replayed: true, body: committed.body });
      expect((await pool().query("SELECT count(*)::int AS count FROM procurement.receiving_orders WHERE created_by=$1", [harness.actorId])).rows[0].count).toBe(1);
      expect((await pool().query("SELECT count(*)::int AS count FROM public.audit_events WHERE action='procurement.receiving.entry.create'")).rows[0].count).toBe(1);
    });

    it("rechecks authority under the mutation transaction after admission permission changes", async () => {
      await emptyReceipt();
      const service = harness.service();
      const changedAfterAdmission = {
        async assertEntryAuthority(actorId: string) {
          await service.assertEntryAuthority(actorId);
          await pool().query("DELETE FROM identity.auth_role_permissions WHERE permission_id=1");
        },
        executeEntryInTransaction: service.executeEntryInTransaction.bind(service),
      };
      const before = await counts();
      const rejected = await execute("changed-authority", intent, harness.actorId, changedAfterAdmission);
      expect(rejected).toMatchObject({ terminalState: "rejected", httpStatus: 403,
        body: { code: "RECEIVING_ENTRY_FORBIDDEN", details: { receivingEntryOutcome: "rejected", idempotencyKey: "receiving-entry:changed-authority" } } });
      expect(await counts()).toEqual(before);
      await pool().query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES(1,1)");
      expect(await execute("changed-authority")).toMatchObject({ replayed: true, body: rejected.body });
      expect(await execute("new-authorized-intent")).toMatchObject({ terminalState: "succeeded" });
      expect(await counts()).toMatchObject({ lines: 1, audits: 1 });
    });

    it("does not expose saved success to a disabled or revoked operator, then recovers after reinstatement", async () => {
      await emptyReceipt();
      const committed = await execute("revoked-recovery");
      await pool().query("UPDATE identity.users SET active=0 WHERE id=$1", [harness.actorId]);
      await expect(execute("revoked-recovery")).rejects.toMatchObject({ code: "RECEIVING_ENTRY_FORBIDDEN", statusCode: 403 });
      await pool().query("UPDATE identity.users SET active=1 WHERE id=$1", [harness.actorId]);
      await pool().query("DELETE FROM identity.auth_role_permissions WHERE permission_id=1");
      await expect(execute("revoked-recovery")).rejects.toMatchObject({ code: "RECEIVING_ENTRY_FORBIDDEN", statusCode: 403 });
      await pool().query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES(1,1)");
      expect(await execute("revoked-recovery")).toMatchObject({ replayed: true, body: committed.body });
      expect(await counts()).toMatchObject({ lines: 1, audits: 1 });
    });

    it("stores a stale reviewed pack rejection without writes and requires a new reviewed intent", async () => {
      await emptyReceipt();
      const stale = { ...intent, payload: { ...intent.payload, expectedUnitsPerVariant: 10 } };
      const first = await execute("stale-pack", stale);
      expect(first).toMatchObject({ terminalState: "rejected", httpStatus: 409,
        body: { code: "RECEIVING_UNIT_CHANGED", details: { receivingEntryOutcome: "rejected", idempotencyKey: "receiving-entry:stale-pack" } } });
      expect(await execute("stale-pack", stale)).toMatchObject({ replayed: true, body: first.body });
      await expect(execute("stale-pack")).rejects.toMatchObject({ code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" });
      expect(await counts()).toMatchObject({ lines: 0, audits: 0, stock_receipts: 0, on_hand: 20 });
      expect(await execute("new-reviewed-pack")).toMatchObject({ terminalState: "succeeded" });
    });
  });
}
