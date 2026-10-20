import { randomUUID } from "node:crypto";
import { setTimeout as waitForRetry } from "node:timers/promises";
import { expect, it } from "vitest";
import { previewSupplierReturnStock } from "../../../inventory/application/supplier-return-stock";
import { createSupplierReturnCommands, SUPPLIER_RETURN_COMMAND_SCOPE } from "../../supplier-return.commands";
import { createDrizzleFinancialCommandRepository } from "../../../../platform/commands/command-results.repository";
import { hashHttpFinancialCommand } from "../../../../platform/commands/http-command";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";
import type { SupplierReturnStockFixture } from "./supplier-return-stock.cases";

export function registerSupplierReturnCommandCases(fixture: SupplierReturnStockFixture) {
  const query = (text: string, values: unknown[] = []) => fixture.pool().query(text, values);
  const commands = () => createSupplierReturnCommands(createDrizzleFinancialCommandRepository(fixture.database()), () => fixture.at);
  async function request() {
    await fixture.receive();
    const lotId = Number((await query("SELECT id FROM inventory.inventory_lots ORDER BY id LIMIT 1")).rows[0].id);
    const reviewed = await fixture.database().transaction(tx => previewSupplierReturnStock(tx, { vendorId: 5, lines: [{ inventoryLotId: lotId, quantity: 1 }] }));
    return { vendorId: 5, lines: [{ inventoryLotId: lotId, quantity: 1 }], expectedSourceFingerprint: reviewed.sourceFingerprint,
      returnCalendarDate: "2026-09-06", evidenceReference: "RETURN-COMMAND-COLLECTION", reason: "Supplier collected verified stock" };
  }
  function descriptor(raw: unknown, key = randomUUID(), actorId = fixture.actorId): FinancialCommandDescriptor {
    return { ...SUPPLIER_RETURN_COMMAND_SCOPE, actorType: "user", actorId, idempotencyKey: key, contractVersion: 1,
      requestHash: hashHttpFinancialCommand({ ...SUPPLIER_RETURN_COMMAND_SCOPE, body: raw, params: {}, query: {} }) };
  }
  async function counts() {
    return (await query(`SELECT
      (SELECT count(*)::int FROM procurement.supplier_returns) AS returns,
      (SELECT count(*)::int FROM inventory.supplier_return_allocations) AS allocations,
      (SELECT count(*)::int FROM inventory.supplier_return_cost_entries) AS entries,
      (SELECT count(*)::int FROM procurement.supplier_return_reporting_events) AS reports,
      (SELECT count(*)::int FROM inventory.supplier_return_followups) AS followups,
      (SELECT count(*)::int FROM inventory.inventory_transactions WHERE transaction_type='supplier_return') AS movements,
      (SELECT sum(qty_on_hand)::int FROM inventory.inventory_lots) AS on_hand`)).rows[0];
  }
  it("supplier return command recovers a lost response with one physical movement and rejects cross-actor key reuse", async () => {
    const raw = await request(), identity = descriptor(raw);
    const first = await commands().record(raw, identity);
    expect(first).toMatchObject({ terminalState: "succeeded", httpStatus: 201, replayed: false });
    const committed = await counts();
    expect(committed).toEqual({ returns: 1, allocations: 1, entries: 3, reports: 1, followups: 1, movements: 1, on_hand: 1 });
    const retry = await commands().record(raw, identity);
    expect(retry.body).toEqual(first.body); expect(retry.replayed).toBe(true);
    expect(await counts()).toEqual(committed);
    await expect(commands().record(raw, { ...identity, actorId: "admin-user" })).rejects.toMatchObject({ statusCode: 422, code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" });
    expect(await counts()).toEqual(committed);
  });
  it("supplier return concurrent reviewed commands cannot remove the same stock twice", async () => {
    const raw = await request(), identities = [descriptor(raw), descriptor(raw)];
    const results = await Promise.all(identities.map(identity => commands().record(raw, identity)));
    expect(results.filter(result => result.terminalState === "succeeded")).toHaveLength(1);
    const rejectedIndex = results.findIndex(result => result.terminalState === "rejected");
    expect(rejectedIndex).toBeGreaterThanOrEqual(0);
    expect(results[rejectedIndex]).toMatchObject({ httpStatus: 409, body: { details: { supplierReturnCommandOutcome: "rejected", command: "record", actorId: fixture.actorId,
      idempotencyKey: identities[rejectedIndex].idempotencyKey } } });
    expect(await counts()).toMatchObject({ returns: 1, movements: 1, on_hand: 1 });
    expect((await commands().record(raw, identities[rejectedIndex])).body).toEqual(results[rejectedIndex].body);
  });
  it("supplier return failed durable response write rolls back collection and retries the original command", async () => {
    const raw = await request(), identity = descriptor(raw), before = await counts();
    await query(`CREATE FUNCTION public.fail_supplier_return_command_result() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='succeeded' AND NEW.command_name='supplier_return.record' THEN RAISE EXCEPTION 'injected return command result failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_supplier_return_command_result BEFORE UPDATE ON public.financial_command_results FOR EACH ROW EXECUTE FUNCTION public.fail_supplier_return_command_result()`);
    try { await expect(commands().record(raw, identity)).rejects.toThrow("injected return command result failure"); }
    finally { await query("DROP TRIGGER fail_supplier_return_command_result ON public.financial_command_results; DROP FUNCTION public.fail_supplier_return_command_result()"); }
    expect(await counts()).toEqual(before);
    expect((await query("SELECT status FROM public.financial_command_results WHERE idempotency_key=$1", [identity.idempotencyKey])).rows).toEqual([{ status: "retryable" }]);
    await expect(commands().record(raw, identity)).rejects.toMatchObject({ statusCode: 409, code: "FINANCIAL_COMMAND_IN_PROGRESS" });
    // Exercise the existing real retry schedule; do not rewrite the durable
    // ledger or bypass its admission trigger merely to accelerate this test.
    const delay = Number((await query("SELECT GREATEST(0,extract(epoch FROM next_attempt_at-clock_timestamp())*1000) AS delay FROM public.financial_command_results WHERE idempotency_key=$1", [identity.idempotencyKey])).rows[0].delay);
    expect(delay).toBeGreaterThanOrEqual(0); expect(delay).toBeLessThanOrEqual(5000);
    await waitForRetry(delay + 20);
    expect(await commands().record(raw, identity)).toMatchObject({ terminalState: "succeeded", httpStatus: 201 });
    expect(await counts()).toMatchObject({ returns: 1, movements: 1, on_hand: 1 });
  });
  it("supplier return uses current permission and durably rejects a revoked operator without stock changes", async () => {
    const raw = await request(), identity = descriptor(raw), before = await counts();
    await query("UPDATE identity.users SET active=0 WHERE id=$1", [fixture.actorId]);
    const result = await commands().record(raw, identity);
    expect(result).toMatchObject({ terminalState: "rejected", httpStatus: 403, body: { details: { code: "SUPPLIER_RETURN_AUTHORITY_REQUIRED" } } });
    expect(await counts()).toEqual(before);
    await query("UPDATE identity.users SET active=1 WHERE id=$1", [fixture.actorId]);
    expect((await commands().record(raw, identity)).body).toEqual(result.body);
    expect(await counts()).toEqual(before);
  });
}
