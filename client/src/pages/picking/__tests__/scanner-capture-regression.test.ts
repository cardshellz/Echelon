import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Regression (2026-11-25): #2158 changed how the handheld scanner's input is
// captured. It added inputMode="none" + pointer-events-none to the hidden
// scanner sink and moved post-pick focus from the visible scan box onto that
// sink. Scanned picks (wms.picking_logs.pick_method = 'scan') fell from 10-26
// per hour to zero in the first full hour after the deploy, and pickers fell
// back to "pick all", which confirms lines with no barcode check.
//
// These guards pin the scan-capture path to its known-good configuration.
// Change them only after testing on a real gun.

const ACTIVE_ITEM_VIEW_SRC = readFileSync(
  resolve(__dirname, "../PickingActiveItemView.tsx"),
  "utf8",
);
const PICKING_SRC = readFileSync(resolve(__dirname, "../../Picking.tsx"), "utf8");

/** Attributes of the hidden scanner <input>, from its ref up to its self-closing tag. */
function hiddenScannerSink(): string {
  const start = ACTIVE_ITEM_VIEW_SRC.indexOf("ref={hiddenScannerRef}");
  expect(start).toBeGreaterThan(-1);
  const end = ACTIVE_ITEM_VIEW_SRC.indexOf("/>", start);
  expect(end).toBeGreaterThan(start);
  return ACTIVE_ITEM_VIEW_SRC.slice(start, end);
}

/** Body of confirmPick, up to the next handler. */
function confirmPickBody(): string {
  const start = PICKING_SRC.indexOf("const confirmPick = (");
  expect(start).toBeGreaterThan(-1);
  const end = PICKING_SRC.indexOf("const checkReplenGuidance", start);
  expect(end).toBeGreaterThan(start);
  return PICKING_SRC.slice(start, end);
}

describe("picking scanner capture", () => {
  it("keeps the hidden scanner sink a plain, focusable input", () => {
    const sink = hiddenScannerSink();
    expect(sink).not.toMatch(/inputMode=/);
    expect(sink).not.toMatch(/pointer-events-none/);
    expect(sink).not.toMatch(/\bdisabled\b/);
    expect(sink).not.toMatch(/\breadOnly\b/);
  });

  it("still turns Enter on the hidden sink into a scan", () => {
    const sink = hiddenScannerSink();
    expect(sink).toMatch(/onKeyDown=/);
    expect(sink).toMatch(/e\.key === "Enter"/);
    expect(sink).toMatch(/processScanRef\.current\(val\)/);
  });

  it("returns focus to the visible scan box after each pick", () => {
    expect(confirmPickBody()).toMatch(/manualInputRef\.current\.focus\(\)/);
  });
});
