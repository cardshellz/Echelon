import { describe, expect, it } from "vitest";

import {
  PO_RECEIVE_CONFIGURATION_REQUIRED,
  PO_RECEIVE_VARIANT_CLEAR_BLOCKED,
  PO_RECEIVE_VARIANT_REQUIRED,
  checkReceiveConfigurationReadyToLeaveDraft,
  checkReceiveVariantChosen,
  checkReceiveVariantNotCleared,
  findLinesMissingReceiveConfiguration,
  hasChosenReceiveVariant,
  isOpenPoLine,
  isProductPoLine,
} from "../../receive-configuration-policy";

describe("receive configuration policy", () => {
  describe("hasChosenReceiveVariant", () => {
    it("accepts only a real positive catalog identifier", () => {
      expect(hasChosenReceiveVariant(101)).toBe(true);
      for (const value of [null, undefined, 0, -1, 1.5, "101", NaN, {}, []]) {
        expect(hasChosenReceiveVariant(value)).toBe(false);
      }
    });
  });

  describe("line classification", () => {
    it("reads an absent line type as a product line", () => {
      expect(isProductPoLine(undefined)).toBe(true);
      expect(isProductPoLine(null)).toBe(true);
      expect(isProductPoLine("product")).toBe(true);
      expect(isProductPoLine("discount")).toBe(false);
      expect(isProductPoLine("fee")).toBe(false);
    });

    it("treats only cancelled lines as closed", () => {
      expect(isOpenPoLine(undefined)).toBe(true);
      expect(isOpenPoLine("open")).toBe(true);
      expect(isOpenPoLine("received")).toBe(true);
      expect(isOpenPoLine("cancelled")).toBe(false);
    });
  });

  describe("checkReceiveVariantChosen", () => {
    it("passes a product line that carries an explicit choice", () => {
      expect(checkReceiveVariantChosen({
        lineType: "product",
        expectedReceiveVariantId: 42,
        productId: 7,
      })).toBeNull();
    });

    it("refuses a product line with no choice, whatever shape the blank takes", () => {
      for (const value of [null, undefined, 0, -3]) {
        const violation = checkReceiveVariantChosen({
          lineType: "product",
          expectedReceiveVariantId: value,
          productId: 7,
        });
        expect(violation).not.toBeNull();
        expect(violation).toMatchObject({
          code: PO_RECEIVE_VARIANT_REQUIRED,
          status: 400,
        });
        expect(violation!.context).toMatchObject({ productId: 7 });
      }
    });

    it("never refuses a non-product line, which has nothing to receive", () => {
      for (const lineType of ["discount", "fee", "tax", "rebate", "adjustment"]) {
        expect(checkReceiveVariantChosen({
          lineType,
          expectedReceiveVariantId: null,
        })).toBeNull();
      }
    });

    it("prefixes the caller's label so a bulk request names the offending line", () => {
      const violation = checkReceiveVariantChosen({
        lineType: "product",
        expectedReceiveVariantId: null,
        label: "lines[2]",
      });
      expect(violation!.message.startsWith("lines[2]: ")).toBe(true);
    });
  });

  describe("checkReceiveVariantNotCleared", () => {
    it("ignores an update that does not mention the receive configuration", () => {
      expect(checkReceiveVariantNotCleared({
        lineType: "product",
        submittedExpectedReceiveVariantId: undefined,
        lineId: 5,
      })).toBeNull();
    });

    it("allows an update that moves the choice to another configuration", () => {
      expect(checkReceiveVariantNotCleared({
        lineType: "product",
        submittedExpectedReceiveVariantId: 99,
        lineId: 5,
      })).toBeNull();
    });

    it("refuses an update that explicitly takes the choice away", () => {
      for (const value of [null, 0]) {
        const violation = checkReceiveVariantNotCleared({
          lineType: "product",
          submittedExpectedReceiveVariantId: value,
          lineId: 5,
        });
        expect(violation).toMatchObject({
          code: PO_RECEIVE_VARIANT_CLEAR_BLOCKED,
          status: 400,
        });
        expect(violation!.context).toMatchObject({ lineId: 5 });
      }
    });
  });

  describe("findLinesMissingReceiveConfiguration", () => {
    const lines = [
      { id: 1, lineNumber: 1, lineType: "product", expectedReceiveVariantId: 10, sku: "A" },
      { id: 2, lineNumber: 2, lineType: "product", expectedReceiveVariantId: null, sku: "B", productName: "Widget" },
      { id: 3, lineNumber: 3, lineType: "discount", expectedReceiveVariantId: null, sku: null },
      { id: 4, lineNumber: 4, lineType: "product", expectedReceiveVariantId: null, status: "cancelled", sku: "D" },
      { id: 5, lineNumber: 5, expectedReceiveVariantId: null, sku: "E" },
    ];

    it("reports only open product lines with the question unanswered, in order", () => {
      expect(findLinesMissingReceiveConfiguration(lines)).toEqual([
        { lineId: 2, lineNumber: 2, sku: "B", productName: "Widget" },
        { lineId: 5, lineNumber: 5, sku: "E", productName: null },
      ]);
    });

    it("returns nothing for a fully answered order or a non-array input", () => {
      expect(findLinesMissingReceiveConfiguration([lines[0], lines[2], lines[3]])).toEqual([]);
      expect(findLinesMissingReceiveConfiguration([])).toEqual([]);
      expect(findLinesMissingReceiveConfiguration(undefined as any)).toEqual([]);
    });

    it("normalizes blank identifying text to null rather than empty strings", () => {
      expect(findLinesMissingReceiveConfiguration([
        { id: 9, lineNumber: 1, lineType: "product", expectedReceiveVariantId: null, sku: "   ", productName: "" },
      ])).toEqual([{ lineId: 9, lineNumber: 1, sku: null, productName: null }]);
    });
  });

  describe("checkReceiveConfigurationReadyToLeaveDraft", () => {
    it("lets a fully answered order advance", () => {
      expect(checkReceiveConfigurationReadyToLeaveDraft([
        { id: 1, lineType: "product", expectedReceiveVariantId: 10 },
        { id: 2, lineType: "fee", expectedReceiveVariantId: null },
      ])).toBeNull();
    });

    it("blocks with a 409 naming how many lines are unanswered", () => {
      const violation = checkReceiveConfigurationReadyToLeaveDraft([
        { id: 1, lineNumber: 1, lineType: "product", expectedReceiveVariantId: null },
        { id: 2, lineNumber: 2, lineType: "product", expectedReceiveVariantId: 5 },
        { id: 3, lineNumber: 3, lineType: "product", expectedReceiveVariantId: null },
      ]);
      expect(violation).toMatchObject({
        code: PO_RECEIVE_CONFIGURATION_REQUIRED,
        status: 409,
      });
      expect(violation!.context.missingLineCount).toBe(2);
      expect(violation!.context.missingLines).toEqual([
        { lineId: 1, lineNumber: 1, sku: null, productName: null },
        { lineId: 3, lineNumber: 3, sku: null, productName: null },
      ]);
    });

    it("bounds the reported detail so one bad order cannot produce an unbounded payload", () => {
      const many = Array.from({ length: 50 }, (_, index) => ({
        id: index + 1,
        lineNumber: index + 1,
        lineType: "product",
        expectedReceiveVariantId: null,
      }));
      const violation = checkReceiveConfigurationReadyToLeaveDraft(many);
      expect(violation!.context.missingLineCount).toBe(50);
      expect((violation!.context.missingLines as unknown[]).length).toBe(20);
    });
  });
});
