import { describe, expect, it, vi } from "vitest";
import type { SafetyDefinitionSetResult } from "@shared/types/inventory-safety-definition";

import { ChannelInventoryApiError } from "../api";
import {
  activeHoldBackExceptions, describeHoldBack, describeHoldBackOutcome, holdBackFingerprint, holdBackInput, parseHoldBack,
  sameHoldBack, saveHoldBack, type HoldBackException,
} from "../available-stock";

const fixed = (fixedUnits: number) => ({ policyMode: "fixed_units" as const, fixedUnits });
const cover = { policyMode: "days_of_cover" as const, daysOfCoverMilliDays: 7000, untrustedDemandFallbackUnits: 2, demandMethodVersion: "irreversible_consumption_v1_28d" };
const result = (overrides: Partial<SafetyDefinitionSetResult> = {}): SafetyDefinitionSetResult => ({
  receipt: { scopeKey: "business", policyId: 9, appliedAt: "2026-11-12T12:00:00.000Z", appliedBy: "operator-1",
    reviewHash: "a".repeat(64), publicationIds: [], alreadyApplied: false },
  affectedProducts: 2, changedRows: 0, changes: [], skippedDestinations: [], ...overrides,
});

describe("reading a stored hold-back setting", () => {
  it("shows a plain number for the modes this screen edits", () => {
    expect(describeHoldBack(fixed(1250))).toEqual({ text: "1,250", simple: true });
    expect(describeHoldBack({ policyMode: "off" })).toEqual({ text: "0", simple: true });
    expect(describeHoldBack({ policyMode: "inherit" })).toEqual({ text: "Business number", simple: true });
    expect(describeHoldBack(null)).toEqual({ text: "Not set", simple: true });
  });

  it("names the demand-based mode without pretending it is a number", () => {
    expect(describeHoldBack(cover)).toEqual({ text: "7 days of recent sales", simple: false });
    expect(describeHoldBack({ ...cover, daysOfCoverMilliDays: 1000 }).text).toBe("1 day of recent sales");
    expect(describeHoldBack({ ...cover, daysOfCoverMilliDays: 2500 }).text).toBe("2.5 days of recent sales");
    expect(holdBackInput(cover)).toBe("");
  });

  it("fills the number box from a number or 'off', and leaves it blank otherwise", () => {
    expect(holdBackInput(fixed(25))).toBe("25");
    expect(holdBackInput({ policyMode: "off" })).toBe("0");
    expect(holdBackInput({ policyMode: "inherit" })).toBe("");
    expect(holdBackInput(null)).toBe("");
  });
});

describe("turning what was typed into a setting", () => {
  it("accepts whole numbers including zero", () => {
    expect(parseHoldBack(" 25 ", { blankUsesBusiness: false })).toEqual({ ok: true, value: fixed(25) });
    expect(parseHoldBack("0", { blankUsesBusiness: false })).toEqual({ ok: true, value: fixed(0) });
    expect(parseHoldBack("2147483647", { blankUsesBusiness: false })).toEqual({ ok: true, value: fixed(2_147_483_647) });
  });

  it("rejects anything that is not a whole number of units", () => {
    for (const text of ["-1", "2.5", "1e3", "ten", "1,000", "+5"]) {
      expect(parseHoldBack(text, { blankUsesBusiness: true })).toEqual({ ok: false, message: "Enter a whole number, 0 or more." });
    }
    expect(parseHoldBack("2147483648", { blankUsesBusiness: false })).toEqual({ ok: false, message: "That number is too large." });
    expect(parseHoldBack("99999999999999999999", { blankUsesBusiness: false }).ok).toBe(false);
  });

  it("treats a blank box as 'use the business number' only where there is one to use", () => {
    expect(parseHoldBack("  ", { blankUsesBusiness: true })).toEqual({ ok: true, value: { policyMode: "inherit" } });
    expect(parseHoldBack("", { blankUsesBusiness: false })).toEqual({ ok: false, message: "Enter a number, 0 or more." });
  });

  it("compares settings by what they hold back", () => {
    expect(sameHoldBack(fixed(0), { policyMode: "off" })).toBe(true);
    expect(sameHoldBack(fixed(5), fixed(5))).toBe(true);
    expect(sameHoldBack(fixed(5), fixed(6))).toBe(false);
    expect(sameHoldBack({ policyMode: "inherit" }, fixed(0))).toBe(false);
    expect(sameHoldBack(null, fixed(0))).toBe(false);
    expect(sameHoldBack(null, null)).toBe(true);
    expect(sameHoldBack(cover, { ...cover })).toBe(true);
    expect(sameHoldBack(cover, { ...cover, untrustedDemandFallbackUnits: 3 })).toBe(false);
  });
});

describe("which SKUs count as exceptions", () => {
  const row = (scopeKey: string, value: HoldBackException["value"], hasUnappliedChange = false) => ({ scopeKey, value, hasUnappliedChange }) as HoldBackException;
  it("drops a SKU handed back to the business number and keeps everything else", () => {
    const kept = activeHoldBackExceptions({ exceptions: [
      row("network:variant:1", fixed(5)), row("network:variant:2", { policyMode: "inherit" }), row("network:variant:3", { policyMode: "off" }),
      row("network:variant:4", cover), row("network:variant:5", null, true), row("network:variant:6", null, false),
    ] });
    expect(kept.map(item => item.scopeKey)).toEqual(["network:variant:1", "network:variant:3", "network:variant:4", "network:variant:5"]);
  });
});

describe("saving", () => {
  const input = { scope: { scopeType: "business" as const }, value: fixed(5), expectedHeadRevision: "1", note: "  More cushion  ", idempotencyKey: "key-1" };

  it("sends one command with the fence, the trimmed note and the retry key", async () => {
    const send = vi.fn(async () => result());
    await expect(saveHoldBack(input, send)).resolves.toEqual({ status: "saved", result: result() });
    expect(send).toHaveBeenCalledWith({ scope: { scopeType: "business" }, value: fixed(5), expectedHeadRevision: "1",
      changeReason: "More cushion", idempotencyKey: "key-1" });
    await saveHoldBack({ ...input, note: "   ", expectedHeadRevision: null }, send);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ changeReason: null, expectedHeadRevision: null }));
  });

  it("reports a refusal as not saved, with the server's reason", async () => {
    const send = vi.fn(async () => { throw new ChannelInventoryApiError(409, "DEFINITION_REVIEW_BLOCKED", "Not saved, nothing changed. P5 / MAIN: no stock."); });
    await expect(saveHoldBack(input, send)).resolves.toEqual({ status: "rejected", message: "Not saved, nothing changed. P5 / MAIN: no stock." });
  });

  it("never claims success or failure when the response is lost or the server times out", async () => {
    for (const error of [new TypeError("Failed to fetch"), new ChannelInventoryApiError(504, "GATEWAY_TIMEOUT", "Gateway timeout"),
      new ChannelInventoryApiError(500, "DEFINITION_COMMAND_FAILED", "Not confirmed")]) {
      const outcome = await saveHoldBack(input, vi.fn(async () => { throw error; }));
      expect(outcome.status).toBe("unknown");
    }
  });

  it("gives the same change the same fingerprint and a different change a different one", () => {
    const base = { scope: input.scope, value: input.value, expectedHeadRevision: "1", note: "x" };
    expect(holdBackFingerprint(base)).toBe(holdBackFingerprint({ ...base, note: " x " }));
    expect(holdBackFingerprint(base)).not.toBe(holdBackFingerprint({ ...base, value: fixed(6) }));
    expect(holdBackFingerprint(base)).not.toBe(holdBackFingerprint({ ...base, expectedHeadRevision: "2" }));
    expect(holdBackFingerprint(base)).not.toBe(holdBackFingerprint({ ...base, scope: { scopeType: "network_variant", productVariantId: 1 } }));
  });

  it("describes each outcome in one plain line", () => {
    expect(describeHoldBackOutcome({ status: "saved", result: result() })).toBe("Saved. Available stock does not change right now.");
    const change = (sku: string | null, current: string | null, proposed: string) => ({ sku, warehouseName: "MAIN", current, proposed });
    expect(describeHoldBackOutcome({ status: "saved", result: result({ changedRows: 1, changes: [change("P5", "1500", "1475")] }) }))
      .toBe("Saved. Available stock changed: P5 at MAIN 1,500 → 1,475.");
    expect(describeHoldBackOutcome({ status: "saved", result: result({ changedRows: 40,
      changes: [change("A", "9", "4"), change("B", null, "0"), change(null, "3", "0"), change("D", "8", "3")], skippedDestinations: ["eBay: listing not linked"] }) }))
      .toBe("Saved. Available stock changed: A at MAIN 9 → 4, B at MAIN ? → 0, SKU at MAIN 3 → 0 and 37 more. 1 destination was skipped.");
    expect(describeHoldBackOutcome({ status: "rejected", message: "This setting changed." })).toBe("Not saved. This setting changed.");
    expect(describeHoldBackOutcome({ status: "unknown", message: "The outcome is unknown." })).toBe("The outcome is unknown.");
  });
});
