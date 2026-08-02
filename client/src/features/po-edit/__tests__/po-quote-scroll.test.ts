import { describe, expect, it } from "vitest";

import {
  canScrollVertically,
  shouldChainQuoteWheelToPage,
  type VerticalScrollMetrics,
} from "../po-quote-scroll";

const scrollablePage: VerticalScrollMetrics = {
  scrollTop: 300,
  clientHeight: 800,
  scrollHeight: 2_000,
};

describe("PO quote editor scroll chaining", () => {
  it("keeps wheel input in the quote editor while it can scroll", () => {
    const quoteViewport = {
      scrollTop: 100,
      clientHeight: 500,
      scrollHeight: 1_200,
    };

    expect(canScrollVertically(quoteViewport, 120)).toBe(true);
    expect(
      shouldChainQuoteWheelToPage(quoteViewport, scrollablePage, 120),
    ).toBe(false);
  });

  it("chains downward wheel input to the page at the quote editor bottom", () => {
    const quoteViewport = {
      scrollTop: 700,
      clientHeight: 500,
      scrollHeight: 1_200,
    };

    expect(
      shouldChainQuoteWheelToPage(quoteViewport, scrollablePage, 120),
    ).toBe(true);
  });

  it("chains upward wheel input to the page at the quote editor top", () => {
    const quoteViewport = {
      scrollTop: 0,
      clientHeight: 500,
      scrollHeight: 1_200,
    };

    expect(
      shouldChainQuoteWheelToPage(quoteViewport, scrollablePage, -120),
    ).toBe(true);
  });

  it("does not consume wheel input when neither viewport can continue", () => {
    const quoteViewport = {
      scrollTop: 700,
      clientHeight: 500,
      scrollHeight: 1_200,
    };
    const pageAtBottom = {
      scrollTop: 1_200,
      clientHeight: 800,
      scrollHeight: 2_000,
    };

    expect(
      shouldChainQuoteWheelToPage(quoteViewport, pageAtBottom, 120),
    ).toBe(false);
  });

  it("ignores zero and non-finite wheel deltas", () => {
    expect(canScrollVertically(scrollablePage, 0)).toBe(false);
    expect(canScrollVertically(scrollablePage, Number.NaN)).toBe(false);
    expect(canScrollVertically(scrollablePage, Number.POSITIVE_INFINITY)).toBe(
      false,
    );
  });
});
