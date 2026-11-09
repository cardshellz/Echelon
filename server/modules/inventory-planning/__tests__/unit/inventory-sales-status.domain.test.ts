import { describe, expect, it } from "vitest";
import { inventoryPublicationTargetHoldSchema } from "@shared/types/inventory-channel-exposure";
import type { SalesStatusChange, SalesStatusScope } from "@shared/types/inventory-sales-status";

import {
  affectedSalesStatusProductIds,
  planSalesStatusChanges,
  salesStatusHold,
  salesStatusScopeKey,
  salesStatusStopsForChannel,
  type CurrentSalesStatus,
} from "../../domain/inventory-sales-status";

const AT = "2026-11-07T15:00:00.000Z";
const productEverywhere: SalesStatusScope = { channelId: null, productId: 11, productVariantId: null };
const skuEverywhere: SalesStatusScope = { channelId: null, productId: 11, productVariantId: 22 };
const skuOnShopify: SalesStatusScope = { channelId: 36, productId: 11, productVariantId: 22 };

function current(scope: SalesStatusScope, status: "selling" | "stopped", revision: string): CurrentSalesStatus {
  return { scopeKey: salesStatusScopeKey(scope), scope, status, revision };
}

function stored(...entries: CurrentSalesStatus[]): Map<string, CurrentSalesStatus> {
  return new Map(entries.map((entry) => [entry.scopeKey, entry]));
}

function change(scope: SalesStatusScope, status: SalesStatusChange["status"], expectedRevision: string | null): SalesStatusChange {
  return { scope, status, expectedRevision };
}

describe("planSalesStatusChanges", () => {
  it("inserts a new setting, updates a different one and leaves an identical one alone", () => {
    const existingStop = current(skuEverywhere, "stopped", "7");
    const existingSell = current(skuOnShopify, "selling", "8");
    const plan = planSalesStatusChanges(stored(existingStop, existingSell), [
      change(productEverywhere, "stopped", null),
      change(skuEverywhere, "stopped", "7"),
      change(skuOnShopify, "stopped", "8"),
    ]);
    expect(plan).toEqual({ ok: true, operations: [
      { kind: "insert", scopeKey: "all:product:11", scope: productEverywhere, status: "stopped", before: null },
      { kind: "none", scopeKey: "all:variant:22", scope: skuEverywhere, before: existingStop },
      { kind: "update", scopeKey: "channel:36:variant:22", scope: skuOnShopify, status: "stopped", before: existingSell },
    ] });
  });

  it("removes a setting to inherit, and treats inheriting an unset scope as no change", () => {
    const existing = current(skuEverywhere, "stopped", "3");
    expect(planSalesStatusChanges(stored(existing), [
      change(skuEverywhere, "inherit", "3"),
      change(productEverywhere, "inherit", null),
    ])).toEqual({ ok: true, operations: [
      { kind: "delete", scopeKey: "all:variant:22", scope: skuEverywhere, before: existing },
      { kind: "none", scopeKey: "all:product:11", scope: productEverywhere, before: null },
    ] });
  });

  it("refuses the whole command when any scope changed since the operator read it", () => {
    const plan = planSalesStatusChanges(stored(current(skuEverywhere, "stopped", "9")), [
      change(productEverywhere, "stopped", null),
      change(skuEverywhere, "inherit", "4"),
      change(skuOnShopify, "selling", "5"),
    ]);
    expect(plan).toEqual({ ok: false, conflicts: [
      { scopeKey: "all:variant:22", expectedRevision: "4", currentRevision: "9" },
      { scopeKey: "channel:36:variant:22", expectedRevision: "5", currentRevision: null },
    ] });
  });

  it("refuses a create when someone else already created the setting, even with the same status", () => {
    expect(planSalesStatusChanges(stored(current(skuEverywhere, "stopped", "2")), [change(skuEverywhere, "stopped", null)]))
      .toEqual({ ok: false, conflicts: [{ scopeKey: "all:variant:22", expectedRevision: null, currentRevision: "2" }] });
  });

  it("does not mutate the current settings it was given", () => {
    const existing = current(skuEverywhere, "stopped", "3");
    const map = stored(existing);
    const snapshot = structuredClone([...map.entries()]);
    planSalesStatusChanges(map, [change(skuEverywhere, "selling", "3")]);
    expect([...map.entries()]).toEqual(snapshot);
  });
});

describe("affectedSalesStatusProductIds", () => {
  it("returns each product once, in id order", () => {
    expect(affectedSalesStatusProductIds([
      { channelId: null, productId: 12, productVariantId: 30 },
      { channelId: 36, productId: 11, productVariantId: null },
      { channelId: null, productId: 12, productVariantId: null },
    ])).toEqual([11, 12]);
    expect(affectedSalesStatusProductIds([])).toEqual([]);
  });
});

describe("salesStatusHold", () => {
  it("explains the zero with the scope, never the free-text note, within the hold contract", () => {
    const hold = salesStatusHold({ scopeKey: "all:variant:22", scope: skuEverywhere, status: "stopped", updatedBy: "admin", updatedAt: AT });
    expect(hold).toEqual({ reason: "Sales status: stopped on all channels (SKU setting)", heldAt: AT, heldBy: "admin" });
    expect(inventoryPublicationTargetHoldSchema.parse(hold)).toEqual(hold);
    expect(salesStatusHold({ scopeKey: "channel:36:product:11", scope: { channelId: 36, productVariantId: null },
      status: "stopped", updatedBy: "admin", updatedAt: AT }).reason).toBe("Sales status: stopped on this channel (product setting)");
  });
});

describe("salesStatusStopsForChannel", () => {
  const entry = (scope: SalesStatusScope, status: "selling" | "stopped") => ({
    scopeKey: salesStatusScopeKey(scope), scope, status, updatedBy: "admin", updatedAt: AT,
  });

  it("returns only the SKUs stopped on this channel, each with its deciding setting's hold", () => {
    const entries = [entry({ channelId: null, productId: 11, productVariantId: 22 }, "stopped"),
      entry({ channelId: 36, productId: 11, productVariantId: 22 }, "selling")];
    expect(salesStatusStopsForChannel({ channelId: 67, productId: 11, productVariantIds: [22, 21, 22], entries })).toEqual([
      { productVariantId: 22, hold: { reason: "Sales status: stopped on all channels (SKU setting)", heldAt: AT, heldBy: "admin" } },
    ]);
    // The SKU's own Selling exception on channel 36 beats its own all-channels stop.
    expect(salesStatusStopsForChannel({ channelId: 36, productId: 11, productVariantIds: [21, 22], entries })).toEqual([]);
  });

  it("stops every SKU of a stopped product, and a SKU's Selling exception cannot override the product", () => {
    const entries = [entry(productEverywhere, "stopped"), entry(skuOnShopify, "selling")];
    const productHold = { reason: "Sales status: stopped on all channels (product setting)", heldAt: AT, heldBy: "admin" };
    expect(salesStatusStopsForChannel({ channelId: 36, productId: 11, productVariantIds: [22, 21], entries })).toEqual([
      { productVariantId: 21, hold: productHold }, { productVariantId: 22, hold: productHold },
    ]);
  });

  it("returns nothing without settings", () => {
    expect(salesStatusStopsForChannel({ channelId: 36, productId: 11, productVariantIds: [22], entries: [] })).toEqual([]);
  });
});
