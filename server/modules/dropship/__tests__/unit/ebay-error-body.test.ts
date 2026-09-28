import { describe, expect, it } from "vitest";
import {
  describeEbayErrors,
  MAX_EBAY_ERROR_BODY_LENGTH,
  MAX_EBAY_ERROR_ENTRIES,
  MAX_EBAY_ERROR_TEXT,
  parseEbayErrorBody,
} from "../../infrastructure/ebay-error-body";

const body = JSON.stringify({
  errors: [
    { errorId: 25002, domain: "API_INVENTORY", category: "REQUEST", message: "A user error has occurred.",
      longMessage: "A user error has occurred. Invalid value for aspect Brand.", parameters: [{ name: "aspect", value: "Brand" }] },
    { errorId: "25709", message: "Invalid value for field" },
  ],
});

describe("parseEbayErrorBody", () => {
  it("keeps the documented fields, bounded and printable", () => {
    expect(parseEbayErrorBody(body)).toEqual([
      { errorId: 25002, domain: "API_INVENTORY", category: "REQUEST", message: "A user error has occurred.",
        longMessage: "A user error has occurred. Invalid value for aspect Brand.", parameters: [{ name: "aspect", value: "Brand" }] },
      { errorId: 25709, domain: null, category: null, message: "Invalid value for field", longMessage: null, parameters: [] },
    ]);
  });

  it("yields nothing for text that is not the eBay shape, without throwing", () => {
    expect(parseEbayErrorBody("")).toEqual([]);
    expect(parseEbayErrorBody("<html>Bad Gateway</html>")).toEqual([]);
    expect(parseEbayErrorBody(JSON.stringify({ errors: "nope" }))).toEqual([]);
    expect(parseEbayErrorBody(JSON.stringify({ errors: [null, 7, "x", {}] }))).toEqual([]);
    expect(parseEbayErrorBody(JSON.stringify([{ errorId: 1 }]))).toEqual([]);
    expect(parseEbayErrorBody("x".repeat(MAX_EBAY_ERROR_BODY_LENGTH + 1))).toEqual([]);
  });

  it("caps the entry count and the text length, and strips control characters", () => {
    const many = JSON.stringify({ errors: Array.from({ length: MAX_EBAY_ERROR_ENTRIES + 3 }, (_, index) => ({ errorId: index })) });
    expect(parseEbayErrorBody(many)).toHaveLength(MAX_EBAY_ERROR_ENTRIES);
    const long = JSON.stringify({ errors: [{ message: `a\u0000b\n\tc ${"d".repeat(MAX_EBAY_ERROR_TEXT * 2)}` }] });
    const [entry] = parseEbayErrorBody(long);
    expect(entry.message?.startsWith("a b c d")).toBe(true);
    expect(entry.message).toHaveLength(MAX_EBAY_ERROR_TEXT);
    expect(entry.message).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe("describeEbayErrors", () => {
  it("names every entry on one line, preferring the longer message", () => {
    expect(describeEbayErrors(parseEbayErrorBody(body)))
      .toBe("25002 A user error has occurred. Invalid value for aspect Brand. (aspect: Brand); 25709 Invalid value for field");
  });

  it("is null when there is nothing to say", () => {
    expect(describeEbayErrors([])).toBeNull();
    expect(describeEbayErrors(parseEbayErrorBody("not json"))).toBeNull();
  });
});
