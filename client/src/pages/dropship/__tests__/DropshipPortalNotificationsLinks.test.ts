import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { splitVendorMessageLinks } from "@/lib/vendor-message-links";
import { NotificationMessage } from "../DropshipPortalNotifications";

/** Owner report: an alert's eBay and Listing settings URLs are real links on the Alerts page, and nothing else is. */
describe("alert message links", () => {
  // The page is compiled with the classic JSX runtime in tests, as the other page tests do.
  beforeAll(() => { vi.stubGlobal("React", React); });
  afterAll(() => { vi.unstubAllGlobals(); });
  const message = [
    "Affected listings:",
    "- Toploaders (SKU TL-1), eBay item 123456789012: https://www.ebay.com/itm/123456789012",
    "1. Open Business policies (https://www.ebay.com/sh/sell-preferences/business-policies), and find \"X\".",
    "Or go to Catalog > Listing settings (https://cardshellz.io/catalog/setup) and choose one.",
  ].join("\n");

  it("links eBay pages in a new tab and the portal in place, keeping the punctuation around them as text", () => {
    const pieces = splitVendorMessageLinks(message);
    expect(pieces.filter((piece) => piece.kind === "link")).toEqual([
      { kind: "link", href: "https://www.ebay.com/itm/123456789012", text: "https://www.ebay.com/itm/123456789012", external: true },
      { kind: "link", href: "https://www.ebay.com/sh/sell-preferences/business-policies",
        text: "https://www.ebay.com/sh/sell-preferences/business-policies", external: true },
      { kind: "link", href: "https://cardshellz.io/catalog/setup", text: "https://cardshellz.io/catalog/setup", external: false },
    ]);
    expect(pieces.map((piece) => piece.text).join("")).toBe(message);
    expect(splitVendorMessageLinks("See https://sandbox.ebay.com/itm/123456789012.")[1])
      .toEqual(expect.objectContaining({ kind: "link", href: "https://sandbox.ebay.com/itm/123456789012" }));
  });

  it("keeps javascript:, http:, other hosts, look-alike hosts and credentials as plain text", () => {
    for (const text of [
      "javascript:alert(1)",
      "Click javascript://www.ebay.com/%0Aalert(1)",
      "http://www.ebay.com/itm/123456789012",
      "https://evil.example/itm/1",
      "https://www.ebay.com.evil.example/itm/1",
      "https://evilebay.com/itm/1",
      "https://www.ebay.com@evil.example/",
      "https://user:pass@www.ebay.com/itm/1",
      "https://cardshellz.io.evil.example/catalog/setup",
    ]) {
      expect(splitVendorMessageLinks(text)).toEqual([{ kind: "text", text }]);
    }
  });

  it("allows the page's own https origin, never an http one", () => {
    expect(splitVendorMessageLinks("Go https://portal.example.com/catalog/setup", "https://portal.example.com")[1])
      .toEqual(expect.objectContaining({ kind: "link", external: false }));
    expect(splitVendorMessageLinks("Go http://localhost:5000/catalog/setup", "http://localhost:5000")).toHaveLength(1);
  });

  it("renders links as anchors and text as escaped text, never as HTML", () => {
    const markup = renderToStaticMarkup(React.createElement(NotificationMessage, {
      message: "<img src=x onerror=alert(1)> https://www.ebay.com/itm/123456789012 javascript:alert(1) https://evil.example/x",
    }));
    expect(markup).toContain('<a class="underline" href="https://www.ebay.com/itm/123456789012" target="_blank" rel="noopener noreferrer">'
      + "https://www.ebay.com/itm/123456789012</a>");
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain('href="javascript');
    expect(markup).not.toContain('href="https://evil.example');
    const portal = renderToStaticMarkup(React.createElement(NotificationMessage, { message: "https://cardshellz.io/catalog/setup" }));
    expect(portal).toBe('<p class="mt-1 whitespace-pre-line break-words text-sm text-zinc-600"><a class="underline" '
      + 'href="https://cardshellz.io/catalog/setup">https://cardshellz.io/catalog/setup</a></p>');
  });

  it("never uses dangerouslySetInnerHTML on the Alerts page", () => {
    expect(readFileSync(join(__dirname, "..", "DropshipPortalNotifications.tsx"), "utf8")).not.toContain("dangerouslySetInnerHTML");
  });
});
