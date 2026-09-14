import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("quantity publication effective-state boundary", () => {
  it("holds the global provider fence, settings CAS, receipt, and audit in one transaction", () => {
    const source = readFileSync(
      "server/modules/inventory-planning/infrastructure/inventory-publication-global-control.repository.ts",
      "utf8",
    );
    expect(source).toContain("this.database.transaction");
    expect(source).toContain("pg_try_advisory_xact_lock");
    expect(source).toContain("PUBLICATION_GLOBAL_CONTROL_BUSY");
    expect(source).toContain("FOR UPDATE");
    expect(source).toContain("PUBLICATION_GLOBAL_CONTROL_STALE");
    expect(source).toContain("inventory_availability.publication_global_control.changed");
    expect(source).toContain("idempotencyKeys");
  });

  it("rechecks global, exact legacy channel, and canonical target state before provider I/O", () => {
    const source = readFileSync(
      "server/modules/inventory-planning/infrastructure/quantity-publication-admission.repository.ts",
      "utf8",
    );
    expect(source).toContain("FROM channels.sync_settings");
    expect(source).toContain("PUBLICATION_GLOBAL_STOP_ACTIVE");
    expect(source).toContain("channel_row.sync_enabled");
    expect(source).toContain("channel_row.sync_mode");
    expect(source).toContain("PUBLICATION_LEGACY_CHANNEL_NOT_LIVE");
    expect(source).toContain("target.revision::text AS target_revision");
    expect(source).toContain("PUBLICATION_TARGET_STATE_CHANGED");
    expect(source).toContain('row.target_state !== "live"');
  });

  it("fails closed instead of creating a missing global control from a read path", () => {
    const source = readFileSync("server/modules/channels/sync-settings.service.ts", "utf8");
    expect(source).toContain("settingsRows.length !== 1");
    expect(source).not.toContain(".values({ globalEnabled: false, sweepIntervalMinutes: 15 })");
  });

  it("enforces one global publication control in the database", () => {
    const migration = readFileSync(
      "migrations/0669_inventory_publication_global_control_singleton.sql",
      "utf8",
    );
    expect(migration).toContain("sync_settings_singleton_key_chk");
    expect(migration).toContain("sync_settings_singleton_key_uq");
    expect(migration).toContain("SELECT TRUE, FALSE, 15");
    expect(migration).toContain("reconcile them before installing the canonical publication singleton");
  });
});
