import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ORDERS_STORAGE_SRC = readFileSync(
  resolve(__dirname, "../../orders.storage.ts"),
  "utf-8",
);

describe("claimOrder claimable states", () => {
  it("treats ready / partially_shipped / ready_to_ship / in_progress as claimable statuses", () => {
    const claimBlock = ORDERS_STORAGE_SRC.slice(
      ORDERS_STORAGE_SRC.indexOf("async claimOrder"),
      ORDERS_STORAGE_SRC.indexOf("async releaseOrder"),
    );
    expect(claimBlock).toMatch(/inArray\(orders\.warehouseStatus, \[/);
    expect(claimBlock).toContain('"ready"');
    expect(claimBlock).toContain('"partially_shipped"');
    expect(claimBlock).toContain('"ready_to_ship"');
    expect(claimBlock).toContain('"in_progress"');
  });

  it("blocks ONLY when in_progress under a different picker (stale picker id never blocks)", () => {
    const claimBlock = ORDERS_STORAGE_SRC.slice(
      ORDERS_STORAGE_SRC.indexOf("async claimOrder"),
      ORDERS_STORAGE_SRC.indexOf("async releaseOrder"),
    );
    // The lock is expressed as: NOT (in_progress AND held by someone else),
    // i.e. allow if status != in_progress OR picker is null OR picker is me.
    expect(claimBlock).toMatch(/ne\(orders\.warehouseStatus, "in_progress"\)/);
    expect(claimBlock).toMatch(/isNull\(orders\.assignedPickerId\)/);
    expect(claimBlock).toMatch(/eq\(orders\.assignedPickerId, pickerId\)/);
  });

  it("does NOT require assigned_picker_id to be null as a blanket guard", () => {
    const claimBlock = ORDERS_STORAGE_SRC.slice(
      ORDERS_STORAGE_SRC.indexOf("async claimOrder"),
      ORDERS_STORAGE_SRC.indexOf("async releaseOrder"),
    );
    // The old bug: a top-level `isNull(orders.assignedPickerId)` in the AND(...)
    // blocked claims on any order carrying a stale attribution picker id.
    // It must now only appear inside the OR(...) lock expression. Assert there
    // is no standalone `isNull(...),` immediately preceded by the onHold guard.
    expect(claimBlock).not.toMatch(/eq\(orders\.onHold, 0\),\s*isNull\(orders\.assignedPickerId\)/);
  });
});
