import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "migrations/210_dropship_order_intake_health.sql"),
  "utf8",
);

describe("210_dropship_order_intake_health migration", () => {
  it("persists typed heartbeat, failure, and state-transition evidence per store", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS dropship.dropship_store_order_intake_health");
    expect(sql).toContain("store_connection_id integer PRIMARY KEY");
    expect(sql).toContain("last_attempt_at timestamptz");
    expect(sql).toContain("last_success_at timestamptz");
    expect(sql).toContain("consecutive_failures integer NOT NULL DEFAULT 0");
    expect(sql).toContain("status_changed_at timestamptz NOT NULL");
  });

  it("constrains modes, statuses, failure evidence, and healthy rows", () => {
    expect(sql).toContain("CHECK (mode IN ('poll','webhook'))");
    expect(sql).toContain("CHECK (status IN ('healthy','warning','degraded','stopped'))");
    expect(sql).toContain("CHECK (consecutive_failures >= 0)");
    expect(sql).toContain("CHECK ((last_failure_code IS NULL) = (last_failure_message IS NULL))");
    expect(sql).toContain("status <> 'healthy' OR (last_success_at IS NOT NULL AND consecutive_failures = 0)");
  });
});
