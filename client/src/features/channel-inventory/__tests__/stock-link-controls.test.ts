import { readFileSync } from "node:fs";
import { join } from "node:path";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StockLinkDetails, StockLinkSwitchRow } from "../components/StockLinkControls";
import type { DestinationIdentity } from "../model";
import { describeStockLink, type StockLinkPresentation } from "../stock-link-presentation";
import { stockLinkStatus } from "./fixtures";

const AT = "2026-10-27T12:00:00.000Z";
const identity: DestinationIdentity = { id: 5, title: "us-store.myshopify.com", scope: "Location 1", provider: "shopify", kind: "channel_connection" };
const noop = () => undefined;

// The test transform compiles JSX to React.createElement (same stand-in as the dropship component tests).
afterEach(() => { vi.unstubAllGlobals(); });
function render(node: React.ReactElement): string {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(node);
}

function row(presentation: StockLinkPresentation, canActivate = true, busy = false) {
  return render(createElement(StockLinkSwitchRow, { presentation, identity, canActivate, busy, onToggle: noop }));
}
function details(presentation: StockLinkPresentation, canActivate = true, busy = false) {
  return render(createElement(StockLinkDetails, {
    presentation, canActivate, busy, retrying: false, onContinue: noop, onCheckAgain: noop, onRetry: noop,
  }));
}

describe("stock-link switch row", () => {
  it("renders nothing for a hidden or unavailable status", () => {
    expect(row({ kind: "hidden" })).toBe("");
    expect(row(describeStockLink(undefined, true))).toBe("");
  });

  it("renders the labelled switch in the status's position", () => {
    const on = row(describeStockLink(stockLinkStatus(), false));
    expect(on).toContain("Link store items by SKU");
    expect(on).toContain('aria-label="Link store items by SKU for us-store.myshopify.com, Location 1"');
    expect(on).toContain('aria-checked="true"');
    expect(on).not.toMatch(/\sdisabled=""/);
    expect(row(describeStockLink(stockLinkStatus({ autoLinkEnabled: false }), false))).toContain('aria-checked="false"');
  });

  it("disables the switch without activation permission or while a control runs", () => {
    expect(row(describeStockLink(stockLinkStatus(), false), false)).toMatch(/\sdisabled=""/);
    expect(row(describeStockLink(stockLinkStatus(), false), true, true)).toMatch(/\sdisabled=""/);
  });
});

describe("stock-link details", () => {
  it("renders nothing for a hidden status, so an unsupported destination looks as it does today", () => {
    expect(details({ kind: "hidden" })).toBe("");
  });

  it("shows the counts and Check again; no Continue when nothing is held or paused", () => {
    const html = details(describeStockLink(stockLinkStatus(), false));
    expect(html).toContain("Link store items by SKU · On");
    expect(html).toContain("12 linked · 3 waiting for a store item · 1 need a fix · 0 failed");
    expect(html).toContain("Verified active and draft Shopify products can be linked for inventory.");
    expect(html).toContain("Archived products cannot. Linking leaves the product’s Shopify status unchanged.");
    expect(html).toContain("Use Check again to retry items waiting after a previous product status check.");
    expect(html).toContain(">Check again<");
    expect(html).not.toContain(">Continue<");
    expect(html).not.toContain("requires inventory activation permission");
  });

  it("shows Continue and the held callout when retires are held", () => {
    const html = details(describeStockLink(stockLinkStatus({ retiresHeld: { count: 26, limit: 25, windowHours: 24 } }), false));
    expect(html).toContain(">Continue<");
    expect(html).toContain("26 items lost their SKU today.");
  });

  it("shows the halt as an alert", () => {
    const html = details(describeStockLink(stockLinkStatus({ halted: { code: "STOCK_LINK_UNCLASSIFIED", at: AT } }), false));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Linking stopped because of a setup problem.");
    expect(html).not.toContain("STOCK_LINK_UNCLASSIFIED");
  });

  it("disables both actions and explains why without activation permission", () => {
    const html = details(describeStockLink(stockLinkStatus({ paused: { code: "STOCK_LINK_STORE_NOT_ANSWERING", since: AT, until: AT } }), false), false);
    expect(html).toContain("Changing linking requires inventory activation permission.");
    expect(html.match(/<button[^>]*disabled=""/g)?.length).toBe(2);
  });

  it("says a failed status read could not be loaded and offers a reload", () => {
    const html = details(describeStockLink(undefined, true));
    expect(html).toContain("Linking status could not be loaded.");
    expect(html).toContain(">Reload linking status<");
    expect(html).not.toContain("Check again");
  });
});

describe("stock-link wiring", () => {
  const dir = join(process.cwd(), "client/src/features/channel-inventory");
  const control = readFileSync(join(dir, "components/StockUpdatesControl.tsx"), "utf8");
  const controls = readFileSync(join(dir, "components/StockLinkControls.tsx"), "utf8");

  it("is used by the stock-update control only, with the switch row, details and confirm", () => {
    expect(control).toContain("useStockLinkControls(identity)");
    for (const piece of ["<StockLinkSwitchRow", "<StockLinkDetails", "<StockLinkTurnOffDialog"]) expect(control).toContain(piece);
  });

  it("asks for the status only where it applies and never toasts a status read", () => {
    expect(controls).toContain("useStockLinkStatus(identity.id, applies)");
    expect(controls).toMatch(/const applies = stockLinkStatusApplies\(identity\)/);
    // Toasts come only from the three mutations; the status query has no onError.
    expect(controls.match(/toast\(/g)?.length).toBe(3);
  });

  it("refreshes with the cached status so a failed refresh keeps the last supported answer (review TST-1)", () => {
    const hooks = readFileSync(join(dir, "hooks.ts"), "utf8");
    expect(hooks).toContain("fetchStockLinkStatus(publicationTargetId, queryClient.getQueryData<StockLinkStatus>(stockLinkStatusQueryKey(publicationTargetId)))");
  });

  it("closes the turn-off confirm when the status stops being supported, so its button never does nothing (review TST-1)", () => {
    expect(controls).toMatch(/useEffect\(\(\) => \{ if \(!supported\) setConfirmOff\(false\); \}, \[supported\]\)/);
    expect(controls).toContain("confirmOff: confirmOff && supported !== null");
  });
});
