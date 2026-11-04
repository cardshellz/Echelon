import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { applyPackageReconciliation, type PackageReconciliationCommand } from "../../package-reconciliation.repository";

const command: PackageReconciliationCommand = {
  commandKey: "test-adoption", expectedSnapshotHash: "a".repeat(64), expectedPlanHash: "b".repeat(64),
  sourceItemIds: [1], actor: "operator", reason: "Synthetic adoption authorization check",
  mode: "adopt_existing", correction: null, providerProof: null,
};

describe("package correction assigned-role admission", () => {
  it.each([
    { label: "legacy administrator without roles", active: 1, roles: [] },
    { label: "custom same-name administrator", active: 1, roles: [{ id: 8, name: "Administrator", isSystem: false }] },
    { label: "assigned lead", active: 1, roles: [{ id: 8, name: "Team Lead", isSystem: true }] },
    { label: "inactive assigned administrator", active: 0, roles: [{ id: 8, name: "Administrator", isSystem: true }] },
  ])("rejects $label before reconciliation writes or materialization", async ({ active, roles }) => {
    const execute = vi.fn(async (query: SQL) => {
      const text = new PgDialect().sqlToQuery(query).sql;
      if (text.includes("FROM identity.users")) return { rows: [{ active, role: "admin" }] };
      if (text.includes("identity.auth_user_roles")) return { rows: roles };
      throw new Error("Unauthorized reconciliation query executed");
    });
    const materialize = vi.fn();
    await expect(applyPackageReconciliation({ execute }, command, new Date("2026-11-04T00:00:00Z"), materialize))
      .rejects.toMatchObject({ code: "OPERATOR_NOT_AUTHORIZED" });
    expect(materialize).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(active === 1 ? 2 : 1);
  });

  it("admits an assigned system administrator despite a legacy picker label, before applying all remaining evidence checks", async () => {
    const nextEvidenceCheck = new Error("Synthetic stop at reconciliation evidence boundary");
    const execute = vi.fn(async (query: SQL) => {
      const text = new PgDialect().sqlToQuery(query).sql;
      if (text.includes("FROM identity.users")) return { rows: [{ active: 1, role: "picker" }] };
      if (text.includes("identity.auth_user_roles")) return { rows: [{ id: 8, name: "Administrator", isSystem: true }] };
      throw nextEvidenceCheck;
    });
    const materialize = vi.fn();
    await expect(applyPackageReconciliation({ execute }, command, new Date("2026-11-04T00:00:00Z"), materialize))
      .rejects.toBe(nextEvidenceCheck);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(materialize).not.toHaveBeenCalled();
  });
});
