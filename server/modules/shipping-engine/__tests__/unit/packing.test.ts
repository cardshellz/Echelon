/**
 * PACKING PAGE v2 — unit tests for packing.service pure helpers.
 *
 * DB-touching paths (getPackingQueue, confirmParcel) are thin drizzle reads/
 * writes exercised by the routes in practice; the decision logic they lean on
 * — "all parcels confirmed ⇒ plan becomes 'packed'" and predicted-vs-actual
 * delta — is pure and covered here.
 */

import { describe, expect, it } from "vitest";
import {
  allParcelsConfirmed,
  isParcelConfirmed,
  PACKING_ELIGIBLE_WAREHOUSE_STATUSES,
  weightDeltaGrams,
} from "../../application/packing.service";

const confirmed = { packedAt: new Date("2026-07-05T12:00:00Z") };
const unconfirmed = { packedAt: null };

describe("isParcelConfirmed", () => {
  it("is true once packed_at is stamped", () => {
    expect(isParcelConfirmed(confirmed)).toBe(true);
  });

  it("is false while packed_at is null", () => {
    expect(isParcelConfirmed(unconfirmed)).toBe(false);
  });
});

describe("allParcelsConfirmed (active → packed transition gate)", () => {
  it("is true when every parcel is confirmed", () => {
    expect(allParcelsConfirmed([confirmed, confirmed, confirmed])).toBe(true);
  });

  it("is false while any parcel is unconfirmed", () => {
    expect(allParcelsConfirmed([confirmed, unconfirmed])).toBe(false);
    expect(allParcelsConfirmed([unconfirmed])).toBe(false);
  });

  it("is false for an empty parcel list — a plan with no parcels never flips to packed", () => {
    expect(allParcelsConfirmed([])).toBe(false);
  });

  it("single-parcel plan flips on its one confirmation", () => {
    expect(allParcelsConfirmed([confirmed])).toBe(true);
  });
});

describe("weightDeltaGrams (predicted vs actual)", () => {
  it("is null until an actual weight is recorded", () => {
    expect(weightDeltaGrams(500, null)).toBeNull();
  });

  it("is positive when the parcel weighed more than estimated", () => {
    expect(weightDeltaGrams(500, 620)).toBe(120);
  });

  it("is negative when the parcel weighed less than estimated", () => {
    expect(weightDeltaGrams(500, 450)).toBe(-50);
  });

  it("is zero on an exact match", () => {
    expect(weightDeltaGrams(500, 500)).toBe(0);
  });
});

describe("PACKING_ELIGIBLE_WAREHOUSE_STATUSES", () => {
  it("covers the picking hand-off ('ready_to_ship' via markReadyToShip) and the station states", () => {
    expect([...PACKING_ELIGIBLE_WAREHOUSE_STATUSES]).toEqual([
      "ready_to_ship",
      "picked",
      "packing",
    ]);
  });

  it("excludes terminal and pre-pick states", () => {
    for (const status of ["ready", "picking", "packed", "shipped", "cancelled", "on_hold"]) {
      expect(PACKING_ELIGIBLE_WAREHOUSE_STATUSES).not.toContain(status);
    }
  });
});
