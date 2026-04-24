/**
 * Unit tests for parseEchelonOrderKey (§6 Commit 13).
 *
 * Scope: parseEchelonOrderKey is a pure function — no mocks, no DB,
 * no network. The whole point is to protect the SHIP_NOTIFY dispatch
 * switch that routes webhooks into either the legacy OMS-id path or
 * the new shipment-id path.
 *
 * Invariants under test:
 *
 *   1. `echelon-wms-shp-<N>` → { source: "wms-shipment", shipmentId: N }
 *      for every positive integer N.
 *   2. `echelon-oms-<N>`     → { source: "oms",          omsOrderId: N }
 *      for every positive integer N.
 *   3. Any other prefix, any non-integer suffix, any non-positive suffix,
 *      empty / null / undefined, all return null. The helper NEVER throws.
 *   4. Prefix collision is impossible — "echelon-wms-shp-" is matched
 *      before "echelon-oms-", so an accidentally-shorter check cannot
 *      mis-route the new format into the legacy branch.
 */

import { describe, it, expect } from "vitest";

import { parseEchelonOrderKey } from "../../shipstation.service";

describe("parseEchelonOrderKey", () => {
  // ------------------------------------------------------------------
  // Happy path — both legal formats
  // ------------------------------------------------------------------

  it("parses legacy echelon-oms-<id> into { source: 'oms', omsOrderId }", () => {
    expect(parseEchelonOrderKey("echelon-oms-12345")).toEqual({
      source: "oms",
      omsOrderId: 12345,
    });
  });

  it("parses new echelon-wms-shp-<id> into { source: 'wms-shipment', shipmentId }", () => {
    expect(parseEchelonOrderKey("echelon-wms-shp-987")).toEqual({
      source: "wms-shipment",
      shipmentId: 987,
    });
  });

  it("parses single-digit ids correctly in both formats", () => {
    expect(parseEchelonOrderKey("echelon-oms-1")).toEqual({
      source: "oms",
      omsOrderId: 1,
    });
    expect(parseEchelonOrderKey("echelon-wms-shp-1")).toEqual({
      source: "wms-shipment",
      shipmentId: 1,
    });
  });

  it("parses large ids without overflow for typical integer ranges", () => {
    expect(parseEchelonOrderKey("echelon-oms-2147483647")).toEqual({
      source: "oms",
      omsOrderId: 2147483647,
    });
    expect(parseEchelonOrderKey("echelon-wms-shp-2147483647")).toEqual({
      source: "wms-shipment",
      shipmentId: 2147483647,
    });
  });

  // ------------------------------------------------------------------
  // Non-numeric suffix
  // ------------------------------------------------------------------

  it("returns null for echelon-wms-shp- with non-numeric suffix", () => {
    expect(parseEchelonOrderKey("echelon-wms-shp-abc")).toBeNull();
  });

  it("returns null for echelon-oms- with non-numeric suffix", () => {
    expect(parseEchelonOrderKey("echelon-oms-abc")).toBeNull();
  });

  it("returns null for mixed digits/letters in suffix (parseInt would be permissive)", () => {
    // parseInt("12abc", 10) === 12, but String(12) !== "12abc" so reject.
    expect(parseEchelonOrderKey("echelon-oms-12abc")).toBeNull();
    expect(parseEchelonOrderKey("echelon-wms-shp-12abc")).toBeNull();
  });

  // ------------------------------------------------------------------
  // Non-positive suffix
  // ------------------------------------------------------------------

  it("returns null for echelon-wms-shp-0 (must be positive)", () => {
    expect(parseEchelonOrderKey("echelon-wms-shp-0")).toBeNull();
  });

  it("returns null for echelon-oms-0 (must be positive)", () => {
    expect(parseEchelonOrderKey("echelon-oms-0")).toBeNull();
  });

  it("returns null for echelon-oms--1 (negative id)", () => {
    expect(parseEchelonOrderKey("echelon-oms--1")).toBeNull();
  });

  it("returns null for echelon-wms-shp--1 (negative id)", () => {
    expect(parseEchelonOrderKey("echelon-wms-shp--1")).toBeNull();
  });

  // ------------------------------------------------------------------
  // Empty / null / undefined
  // ------------------------------------------------------------------

  it("returns null for empty string", () => {
    expect(parseEchelonOrderKey("")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseEchelonOrderKey(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseEchelonOrderKey(undefined)).toBeNull();
  });

  // ------------------------------------------------------------------
  // Prefix-only (no id suffix)
  // ------------------------------------------------------------------

  it("returns null for the exact string 'echelon-oms-' with no digits", () => {
    expect(parseEchelonOrderKey("echelon-oms-")).toBeNull();
  });

  it("returns null for the exact string 'echelon-wms-shp-' with no digits", () => {
    expect(parseEchelonOrderKey("echelon-wms-shp-")).toBeNull();
  });

  // ------------------------------------------------------------------
  // Foreign / non-Echelon orderKeys (Shopify-native SS integration etc.)
  // ------------------------------------------------------------------

  it("returns null for a Shopify-native orderKey", () => {
    expect(parseEchelonOrderKey("shopify-native-12345")).toBeNull();
  });

  it("returns null for a key that looks similar but lacks the full prefix", () => {
    expect(parseEchelonOrderKey("echelon-12345")).toBeNull();
    expect(parseEchelonOrderKey("echelon-wms-12345")).toBeNull();
    expect(parseEchelonOrderKey("echelon-wms-shpx-12345")).toBeNull();
    expect(parseEchelonOrderKey("ECHELON-OMS-12345")).toBeNull(); // case-sensitive
  });

  it("returns null for arbitrary third-party strings", () => {
    expect(parseEchelonOrderKey("manual-123")).toBeNull();
    expect(parseEchelonOrderKey("SS-ORDER-789")).toBeNull();
    expect(parseEchelonOrderKey("ebay:12345")).toBeNull();
  });

  // ------------------------------------------------------------------
  // Prefix collision — the longer prefix must win
  // ------------------------------------------------------------------

  it("routes echelon-wms-shp-<N> into wms-shipment, not oms (prefix precedence)", () => {
    // "echelon-wms-shp-42" starts with "echelon-" but NOT with "echelon-oms-".
    // The parser must recognize the more-specific prefix first. If a future
    // regression swapped check order, a wms-shp key could silently match the
    // oms branch (it wouldn't — the prefix wouldn't match — but this test
    // makes the intent explicit).
    const parsed = parseEchelonOrderKey("echelon-wms-shp-42");
    expect(parsed).toEqual({ source: "wms-shipment", shipmentId: 42 });
  });

  // ------------------------------------------------------------------
  // Floating / scientific notation — not our format
  // ------------------------------------------------------------------

  it("returns null for scientific-notation suffix", () => {
    expect(parseEchelonOrderKey("echelon-oms-1e5")).toBeNull();
    expect(parseEchelonOrderKey("echelon-wms-shp-1e5")).toBeNull();
  });

  it("returns null for decimal suffix", () => {
    expect(parseEchelonOrderKey("echelon-oms-1.5")).toBeNull();
    expect(parseEchelonOrderKey("echelon-wms-shp-1.5")).toBeNull();
  });

  it("returns null for suffix with leading zeros (ambiguous form)", () => {
    // parseInt("007", 10) === 7 but String(7) !== "007". Reject to keep
    // the key-space canonical: one id, one string representation.
    expect(parseEchelonOrderKey("echelon-oms-007")).toBeNull();
    expect(parseEchelonOrderKey("echelon-wms-shp-007")).toBeNull();
  });

  // ------------------------------------------------------------------
  // Whitespace / tricky forms
  // ------------------------------------------------------------------

  it("returns null for surrounding whitespace", () => {
    // We don't trim: callers (ShipStation webhook payload) never send
    // whitespace-padded keys, and trimming silently would hide a real bug.
    expect(parseEchelonOrderKey(" echelon-oms-123")).toBeNull();
    expect(parseEchelonOrderKey("echelon-oms-123 ")).toBeNull();
    expect(parseEchelonOrderKey("echelon-wms-shp-123\n")).toBeNull();
  });
});
