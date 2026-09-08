import { describe, expect, it, vi } from "vitest";
import type { CanonicalClaimTransactionClient } from "../../application/canonical-claim-inventory.port";
import {
  createTransactionScopedInventoryPublicationService,
  PostgresTransactionScopedInventoryPublicationExecutor,
} from "../../infrastructure/inventory-availability-runtime-publication.repository";
import { shipmentPublicationIntent } from "../fixtures/shipment-publication.fixture";

function setup(options: { authority?: "legacy" | "canonical"; state?: string; busy?: boolean; isolation?: string; readOnly?: string } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("current_setting")) return { rows: [{ isolation: options.isolation ?? "serializable", read_only: options.readOnly ?? "off" }] };
    if (sql.includes("FROM inventory.availability_runtime_authority")) return { rows: [{
      authority: options.authority ?? "canonical", authority_revision: "1",
      activation_run_id: options.authority === "legacy" ? null : "1",
    }] };
    if (sql.includes("SELECT state") && sql.includes("availability_activation_runs")) {
      return { rows: [{ state: options.state ?? "active" }] };
    }
    if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: !options.busy }] };
    if (sql.includes("ORDER BY desired_revision DESC")) return { rows: [] };
    if (sql.includes("INSERT INTO inventory.inventory_publication_outbox")) return { rows: [{ id: "1" }], rowCount: 1 };
    if (sql.trim().startsWith("UPDATE")) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  // Compile-time proof: callers need only the existing inventory owner contract.
  const client: CanonicalClaimTransactionClient = { query };
  return { query, client, executor: new PostgresTransactionScopedInventoryPublicationExecutor(client) };
}

describe("shipment publication transaction ownership", () => {
  it.each([{ isolation: "read committed" }, { readOnly: "on" }])("rejects an unsuitable transaction %j", async options => {
    const { executor, query } = setup(options);
    const work = vi.fn();
    await expect(executor.execute(work)).rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_TRANSACTION_REQUIRED" });
    expect(work).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("stages the real outbox owner without acquiring, controlling or releasing a transaction", async () => {
    const { executor, query } = setup();
    await expect(executor.execute(context => context.enqueueFullPublications("1", [shipmentPublicationIntent()])))
      .resolves.toMatchObject({ enqueuedRows: 1, enqueuedPublicationKeys: ["5:105"] });
    expect(query.mock.calls.some(([sql]) => /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)/i.test(sql.trim()))).toBe(false);
    expect(query.mock.calls.filter(([sql]) => sql.includes("FOR SHARE"))).toHaveLength(2);
  });

  it("rejects legacy authority without invoking a fallback publisher", async () => {
    const { client, query } = setup({ authority: "legacy" });
    const legacy = vi.fn(async () => "unreachable");
    await expect(createTransactionScopedInventoryPublicationService(client).publishProduct({
      productId: 10, dryRun: false,
    }, legacy)).rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_CANONICAL_AUTHORITY_REQUIRED" });
    expect(legacy).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each(["activating", "publication_verified", "failed"])("rejects nonactive activation %s", async state => {
    const { executor } = setup({ state });
    const work = vi.fn(async () => undefined);
    await expect(executor.execute(work)).rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_ACTIVATION_NOT_ACTIVE" });
    expect(work).not.toHaveBeenCalled();
  });

  it("does not accept another activation's enqueue lineage", async () => {
    const { executor, query } = setup();
    await expect(executor.execute(context => context.enqueueFullPublications("2", [shipmentPublicationIntent()])))
      .rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_AUTHORITY_LINEAGE_MISMATCH" });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("classifies occupied target pairs immediately without blocking or inserting", async () => {
    const { executor, query } = setup({ busy: true });
    await expect(executor.execute(context => context.enqueueFullPublications("1", [shipmentPublicationIntent()])))
      .rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_TARGET_BUSY", context: { retryable: true } });
    expect(query.mock.calls.some(([sql]) => sql.includes("pg_advisory_xact_lock("))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT"))).toBe(false);
  });

  it("propagates a later failure without rolling back work owned by its caller", async () => {
    const { executor, query } = setup();
    const failure = new Error("later owner failed");
    await expect(executor.execute(async context => {
      await context.enqueueFullPublications("1", [shipmentPublicationIntent()]);
      throw failure;
    })).rejects.toBe(failure);
    expect(query.mock.calls.some(([sql]) => sql.trim() === "ROLLBACK")).toBe(false);
  });
});
