import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("inventory availability controlled cutover contract", () => {
  const migration = read("migrations/0638_inventory_availability_cutover.sql");
  const routes = read(
    "server/modules/inventory-planning/interfaces/http/inventory-availability-phase4.routes.ts",
  );
  const outbox = read(
    "server/modules/inventory-planning/infrastructure/inventory-publication-outbox.repository.ts",
  );
  const activationService = read(
    "server/modules/inventory-planning/application/inventory-availability-activation.service.ts",
  );
  const activationRepository = read(
    "server/modules/inventory-planning/infrastructure/inventory-availability-activation.repository.ts",
  );

  it("deploys with legacy authority and no public authority-commit route", () => {
    expect(migration).toContain("'legacy', NULL, 1, 'migration-0638'");
    expect(routes).toContain("/activation-runs/prepare");
    expect(routes).toContain("/activation-runs/abort");
    expect(routes).not.toContain("/activation-runs/commit");
    expect(migration).toContain("CHECK (command_type IN ('prepare', 'abort'))");
    expect(activationService).not.toContain("async commit(");
    expect(activationRepository).not.toContain("async commit(");
  });

  it("requires immutable exact target identity on cutover outbox and readback evidence", () => {
    for (const field of [
      "channel_connection_id_snapshot",
      "provider_scope_type_snapshot",
      "external_scope_id_snapshot",
      "publication_target_revision_snapshot",
    ]) {
      expect(migration).toContain(field);
      expect(outbox).toContain(field);
    }
  });

  it("serializes abort against provider leases and never claims work for a stopped run", () => {
    expect(activationRepository).toContain("ACTIVATION_PROVIDER_WRITE_IN_FLIGHT");
    expect(outbox).toContain("FOR UPDATE OF run");
    expect(outbox).toContain("run.state = 'publishing'");
    expect(outbox).toContain("count(*) FILTER (WHERE state = 'leased')");
    expect(outbox).toContain("finalizeDeadLetteredRunIfQuiescent");
  });

  it("prevents first-cutover fallback from canonical to legacy", () => {
    expect(migration).toContain("the first canonical cutover cannot return to legacy authority");
    expect(migration).toContain("availability_activation_runs_one_cutover_uq");
  });
});
