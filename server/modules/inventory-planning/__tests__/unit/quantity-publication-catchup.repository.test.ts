import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { PostgresQuantityPublicationAdmission, QUANTITY_PUBLICATION_LOCK_NAMESPACE } from "../../infrastructure/quantity-publication-admission.repository";
import type { QuantityPublicationCatchup } from "../../application/quantity-publication-admission.port";

const claim: QuantityPublicationCatchup = { catchupId: "10", revision: "2", attemptBoundaryId: "0",
  scope: { destinationKind: "channel_connection", connectionId: 1, providerKey: "ebay", providerScopeType: "account",
    externalScopeId: "account", externalInventoryItemId: "SKU-A", productId: 20, productVariantId: 101 } };
function fixture(options: { gate?: boolean; scope?: boolean; completed?: boolean; proofError?: Error; rollbackError?: Error } = {}) {
  const query = vi.fn(async (sql: string, _args?: unknown[]) => {
    if (sql.includes("pg_try_advisory_xact_lock_shared")) return { rows: [{ acquired: options.gate ?? true }], rowCount: 1 };
    if (sql.includes("pg_try_advisory_xact_lock(hashtextextended")) return { rows: [{ acquired: options.scope ?? true }], rowCount: 1 };
    if (sql.startsWith("WITH current_canonical_outboxes")) {
      if (options.proofError) throw options.proofError;
      return { rows: [], rowCount: options.completed === false ? 0 : 1 };
    }
    if (sql === "ROLLBACK" && options.rollbackError) throw options.rollbackError;
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn(); const connect = vi.fn(async () => ({ query, release }) as unknown as PoolClient);
  return { query, release, connect, repository: new PostgresQuantityPublicationAdmission({ connect }) };
}

describe("catch-up completion transaction boundary", () => {
  it("holds gate then exact-scope locks in a bounded transaction before its conditional acknowledgement", async () => {
    const f = fixture(); await expect(f.repository.complete(claim)).resolves.toBe(true);
    const calls = f.query.mock.calls;
    expect(calls.slice(0, 4).map(call => call[0])).toEqual(["BEGIN", "SET LOCAL lock_timeout='2s'",
      "SET LOCAL statement_timeout='10s'", "SET LOCAL idle_in_transaction_session_timeout='15s'"]);
    expect(calls[4]).toEqual(["SELECT pg_try_advisory_xact_lock_shared($1,0) AS acquired", [QUANTITY_PUBLICATION_LOCK_NAMESPACE]]);
    expect(calls[5][0]).toContain("pg_try_advisory_xact_lock(hashtextextended");
    expect(calls[6][1]).toEqual(["10", "2", null, "0", expect.stringMatching(/^[a-f0-9]{64}$/)]);
    expect(calls.at(-1)).toEqual(["COMMIT"]); expect(f.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });
  it.each([{ gate: false }, { scope: false }])("fails closed without proof mutation when a provider/gate owner is busy: %j", async options => {
    const f = fixture(options); await expect(f.repository.complete(claim)).resolves.toBe(false);
    expect(f.query.mock.calls.some(call => call[0].startsWith("WITH current_canonical_outboxes"))).toBe(false);
    expect(f.query.mock.calls.at(-1)).toEqual(["ROLLBACK"]); expect(f.release).toHaveBeenCalledOnce();
  });
  it("retains a raced revision when the conditional update returns no row", async () => {
    const f = fixture({ completed: false }); await expect(f.repository.complete(claim, { outboxId: "44" })).resolves.toBe(false);
    expect(f.query.mock.calls.find(call => call[0].startsWith("WITH current_canonical_outboxes"))?.[1]?.[2]).toBe("44");
  });
  it("rolls back proof failure and discards the connection if rollback cannot be confirmed", async () => {
    const proofError = new Error("Proof failed"); const rollbackError = new Error("Rollback failed");
    const f = fixture({ proofError, rollbackError }); await expect(f.repository.complete(claim)).rejects.toBe(proofError);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(rollbackError);
  });
  it.each(["-1", "1.5", "", "01", "9223372036854775808", "nonsense"])("rejects malformed boundary %s before connecting", async attemptBoundaryId => {
    const f = fixture(); await expect(f.repository.complete({ ...claim, attemptBoundaryId })).rejects.toMatchObject({ code: "PUBLICATION_ID_INVALID" });
    expect(f.connect).not.toHaveBeenCalled();
  });
  it("uses immutable provider scope identity independently of internal product metadata", async () => {
    const a = fixture(); const b = fixture();
    await a.repository.complete(claim); await b.repository.complete({ ...claim, scope: { ...claim.scope, productId: null, productVariantId: null } });
    expect(a.query.mock.calls[5][1]).toEqual(b.query.mock.calls[5][1]);
  });
});
