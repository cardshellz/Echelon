import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stockLinkStatusSchema } from "@shared/types/stock-link";

import {
  STOCK_LINK_RELOAD_CODES,
  STOCK_LINK_WORDS,
  buildStockLinkCheckAgainRequest,
  buildStockLinkContinueRequest,
  buildStockLinkSwitchRequest,
  describeStockLink,
  describeStockLinkControlError,
  stockLinkStatusApplies,
  stockLinkSwitchAction,
} from "../stock-link-presentation";
import { stockLinkStatus as supportedStatus } from "./fixtures";

const AT = "2026-10-27T12:00:00.000Z";

describe("which destinations read a stock-link status", () => {
  it("asks only for a Shopify channel connection; the server's `supported` still decides", () => {
    expect(stockLinkStatusApplies({ kind: "channel_connection", provider: "shopify" })).toBe(true);
    expect(stockLinkStatusApplies({ kind: "channel_connection", provider: "ebay" })).toBe(false);
    expect(stockLinkStatusApplies({ kind: "channel_connection", provider: "walmart" })).toBe(false);
    expect(stockLinkStatusApplies({ kind: "dropship_store_connection", provider: "shopify" })).toBe(false);
    expect(stockLinkStatusApplies({ kind: "channel_connection", provider: "unknown" })).toBe(false);
  });
});

describe("stock-link presentation", () => {
  it("hides the controls while loading and for an unsupported destination", () => {
    expect(describeStockLink(undefined, false)).toEqual({ kind: "hidden" });
    expect(describeStockLink({ supported: false, publicationTargetId: 5 }, false)).toEqual({ kind: "hidden" });
  });

  it("shows a failed first read (5xx/403) as unavailable, never as linked or off", () => {
    expect(describeStockLink(undefined, true)).toEqual({ kind: "unavailable", text: STOCK_LINK_WORDS.unavailable });
    expect(describeStockLink({ supported: false, publicationTargetId: 5 }, true)).toEqual({ kind: "unavailable", text: STOCK_LINK_WORDS.unavailable });
  });

  it("keeps the last supported status and the switch when a refresh fails, and says it is not current (review TST-1)", () => {
    const shown = describeStockLink(supportedStatus({ retiresHeld: { count: 25, limit: 25, windowHours: 24 } }), true);
    expect(shown).toMatchObject({ kind: "shown", switchOn: true, showContinue: true, showCheckAgain: true,
      statusLine: "12 linked · 3 waiting for a store item · 1 need a fix · 0 failed" });
    expect(shown.kind === "shown" && shown.callouts[0]).toEqual({ tone: "warning", text: STOCK_LINK_WORDS.refreshFailed });
    expect(describeStockLink(supportedStatus(), false)).toMatchObject({ callouts: [] });
  });

  it("shows the switch position and the four counts in the plan's words", () => {
    const shown = describeStockLink(supportedStatus(), false);
    expect(shown).toEqual({ kind: "shown", switchOn: true,
      statusLine: "12 linked · 3 waiting for a store item · 1 need a fix · 0 failed",
      callouts: [], showContinue: false, showCheckAgain: true });
    const off = describeStockLink(supportedStatus({ autoLinkEnabled: false, counts: { linked: 0, waiting: 0, flagged: 0, error: 0 } }), false);
    expect(off).toMatchObject({ kind: "shown", switchOn: false, statusLine: "0 linked · 0 waiting for a store item · 0 need a fix · 0 failed" });
  });

  it("shows a pause as a warning that resumes by itself and offers Continue", () => {
    const shown = describeStockLink(supportedStatus({ paused: { code: "STOCK_LINK_STORE_NOT_ANSWERING", since: AT, until: AT } }), false);
    expect(shown).toMatchObject({ kind: "shown", showContinue: true, showCheckAgain: true,
      callouts: [{ tone: "warning", text: "Linking is paused: the store stopped answering. It resumes by itself." }] });
  });

  it("shows held retires with their count and offers Continue", () => {
    const shown = describeStockLink(supportedStatus({ retiresHeld: { count: 25, limit: 25, windowHours: 24 } }), false);
    expect(shown).toMatchObject({ kind: "shown", showContinue: true,
      callouts: [{ tone: "warning", text: "25 items lost their SKU today. Echelon kept their links. Check the store, then press Continue." }] });
    expect(STOCK_LINK_WORDS.held(1)).toBe("1 item lost its SKU today. Echelon kept its link. Check the store, then press Continue.");
  });

  it("shows a halt as a danger callout with Check again and without Continue", () => {
    const shown = describeStockLink(supportedStatus({ halted: { code: "STOCK_LINK_ADAPTER_CONTRACT", at: AT } }), false);
    expect(shown).toMatchObject({ kind: "shown", showContinue: false, showCheckAgain: true,
      callouts: [{ tone: "danger", text: "Linking stopped because of a setup problem. Fix it, then press Check again." }] });
  });

  it("orders several callouts halt, held, paused and never shows a raw code", () => {
    const shown = describeStockLink(supportedStatus({
      halted: { code: "STOCK_LINK_UNCLASSIFIED", at: AT },
      retiresHeld: { count: 30, limit: 25, windowHours: 24 },
      paused: { code: "STOCK_LINK_STORE_AUTH_REFUSED", since: AT, until: AT },
    }), false);
    if (shown.kind !== "shown") throw new Error("expected shown");
    expect(shown.callouts.map(callout => callout.tone)).toEqual(["danger", "warning", "warning"]);
    expect(JSON.stringify(shown)).not.toMatch(/STOCK_LINK_/);
  });

  it("says linking is off for every store while the server's kill switch is on, and drops the 'resumes by itself' pause line (review CMP-1)", () => {
    const shown = describeStockLink(supportedStatus({ runnerOff: true,
      paused: { code: "STOCK_LINK_STORE_NOT_ANSWERING", since: AT, until: AT } }), false);
    if (shown.kind !== "shown") throw new Error("expected shown");
    expect(shown.callouts).toEqual([{ tone: "warning", text: STOCK_LINK_WORDS.runnerOff }]);
    expect(shown.showContinue).toBe(true);
    expect(STOCK_LINK_WORDS.runnerOff).toMatch(/^Automatic linking is turned off for every store/);
    // An answer from a server before the field (absent) reads as running.
    expect(describeStockLink(supportedStatus(), false)).toMatchObject({ callouts: [] });
  });

  it("handles the largest counts the contract allows", () => {
    const max = 2_147_483_647;
    const shown = describeStockLink(supportedStatus({ counts: { linked: max, waiting: max, flagged: max, error: max } }), false);
    expect(shown).toMatchObject({ statusLine: `${max} linked · ${max} waiting for a store item · ${max} need a fix · ${max} failed` });
  });
});

describe("stock-link switch and control requests", () => {
  it("confirms before turning off and turns on directly", () => {
    expect(stockLinkSwitchAction(false)).toBe("confirm_off");
    expect(stockLinkSwitchAction(true)).toBe("turn_on");
  });

  it("carries the status revision on every control, and revision 0 for a destination with no row yet", () => {
    expect(buildStockLinkSwitchRequest(supportedStatus(), false)).toEqual({ publicationTargetId: 5, enabled: false, expectedRevision: "4", reason: null });
    expect(buildStockLinkSwitchRequest(supportedStatus({ revision: "0" }), true)).toEqual({ publicationTargetId: 5, enabled: true, expectedRevision: "0", reason: null });
    expect(buildStockLinkContinueRequest(supportedStatus())).toEqual({ publicationTargetId: 5, expectedRevision: "4" });
    expect(buildStockLinkCheckAgainRequest(supportedStatus({ revision: "9" }))).toEqual({ publicationTargetId: 5, expectedRevision: "9" });
  });

  it("refuses a malformed revision before anything leaves the browser", () => {
    expect(() => buildStockLinkSwitchRequest(supportedStatus({ revision: "-1" }), true)).toThrow();
    expect(() => buildStockLinkContinueRequest(supportedStatus({ revision: "04" }))).toThrow();
    expect(() => buildStockLinkCheckAgainRequest(supportedStatus({ publicationTargetId: 0 }))).toThrow();
  });

  it("reloads only on a stale revision", () => {
    expect(STOCK_LINK_RELOAD_CODES.has("STOCK_LINK_DESTINATION_STALE")).toBe(true);
    expect(STOCK_LINK_RELOAD_CODES.has("STOCK_LINK_DESTINATION_BUSY")).toBe(false);
  });

  it("puts the store name into the confirm and the toasts", () => {
    expect(STOCK_LINK_WORDS.turnOffTitle("us-store.myshopify.com")).toBe("Turn off linking for us-store.myshopify.com?");
    expect(STOCK_LINK_WORDS.turnOffBody).toBe("Existing links keep sending stock. New sizes and replaced store items will not be linked until you turn it back on.");
    expect(STOCK_LINK_WORDS.turnedOn("A")).toBe("Linking turned on for A");
    expect(STOCK_LINK_WORDS.turnedOff("A")).toBe("Linking turned off for A");
    expect(STOCK_LINK_WORDS.checking("A")).toBe("Checking A again");
  });
});

describe("refused control toasts (review TST-2)", () => {
  const generic = () => ({ title: "Not saved: something changed first", message: "server sentence" });
  it("speaks the stock-link codes in staff words, a busy store included", () => {
    expect(describeStockLinkControlError({ code: "STOCK_LINK_DESTINATION_BUSY" }, generic)).toEqual({ title: "Linking is busy",
      message: "Echelon is checking this store right now. Try again in a moment." });
    expect(describeStockLinkControlError({ code: "STOCK_LINK_DESTINATION_STALE" }, generic)).toEqual({ title: "Linking changed on another screen",
      message: "The linking status was reloaded. Check it, then try again." });
    expect(describeStockLinkControlError({ code: "STOCK_LINK_DESTINATION_UNSUPPORTED" }, generic)).toEqual({ title: "Linking is not available",
      message: "Automatic linking is not available for this store." });
  });
  it("describes any other error as Channel Inventory does", () => {
    for (const error of [{ code: "GLOBAL_CONTROL_BUSY" }, new Error("x"), null, "text"])
      expect(describeStockLinkControlError(error, generic)).toEqual(generic());
  });
});

describe("status schema parsing", () => {
  it("parses both answers the server sends", () => {
    expect(stockLinkStatusSchema.parse(supportedStatus())).toEqual(supportedStatus());
    expect(stockLinkStatusSchema.parse({ supported: false, publicationTargetId: 5 })).toEqual({ supported: false, publicationTargetId: 5 });
    expect(stockLinkStatusSchema.parse(supportedStatus({ runnerOff: true }))).toMatchObject({ runnerOff: true });
  });
  it("rejects answers the controls must not trust", () => {
    for (const bad of [
      { ...supportedStatus(), counts: { linked: -1, waiting: 0, flagged: 0, error: 0 } },
      { ...supportedStatus(), counts: { linked: 1.5, waiting: 0, flagged: 0, error: 0 } },
      { ...supportedStatus(), revision: 4 },
      { ...supportedStatus(), extra: true },
      { ...supportedStatus(), paused: { code: "lowercase", since: AT, until: AT } },
      { supported: "yes", publicationTargetId: 5 },
      null,
    ]) expect(stockLinkStatusSchema.safeParse(bad).success).toBe(false);
  });
});

describe("staff words", () => {
  it("marks every stock-link word PROPOSED for owner wording", () => {
    const source = readFileSync(join(process.cwd(), "client/src/features/channel-inventory/stock-link-presentation.ts"), "utf8");
    const markers = source.match(/\/\* PROPOSED: owner wording/g) ?? [];
    expect(markers.length).toBe(Object.keys(STOCK_LINK_WORDS).length);
  });
});
