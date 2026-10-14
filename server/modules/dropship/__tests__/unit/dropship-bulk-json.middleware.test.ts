import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../platform/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { logger } from "../../../../platform/observability/logger";
import {
  BULK_JSON_PATHS,
  CONTENT_PROFILE_TOO_LARGE_MESSAGE,
  DROPSHIP_BULK_JSON_LIMIT_BYTES,
  EBAY_CATEGORY_RULES_TOO_LARGE_MESSAGE,
  LISTING_SETTINGS_TOO_LARGE_MESSAGE,
  PRICING_RULES_TOO_LARGE_MESSAGE,
  isDropshipBulkJsonRequest,
  parseDropshipBulkJson,
  parseDropshipBulkJsonFor,
} from "../../interfaces/http/dropship-bulk-json.middleware";

const STORE = "/api/dropship/listings/stores/22";

describe("the bulk JSON path table (plan PR 9, P8, section 3.6)", () => {
  it.each([
    ["PUT", `${STORE}/ebay-category-rules`],
    ["POST", `${STORE}/ebay-category-rules/review`],
    ["POST", `${STORE}/pricing-rules/reviews`],
    ["PUT", `${STORE}/content-profile`],
    ["PUT", `${STORE}/listing-settings/size-prices`],
    ["put", `${STORE}/listing-settings/size-prices/`],
    // W5, one product (9c).
    ["PUT", `${STORE}/listing-settings/products/7`],
    ["PUT", `${STORE}/listing-settings/products/7/`],
    // W6, many products (9d).
    ["POST", `${STORE}/listing-settings/products/bulk`],
    ["post", `${STORE}/listing-settings/products/bulk/`],
    // W12, one category (9e).
    ["PUT", `${STORE}/listing-settings/categories/3`],
    ["put", `${STORE}/listing-settings/categories/3/`],
    // W7, the price check and its apply (9f).
    ["POST", `${STORE}/listing-settings/price-changes/review`],
    ["post", `${STORE}/listing-settings/price-changes/review/`],
    ["POST", `${STORE}/listing-settings/price-changes/apply`],
    // W13, "Got it" (9g).
    ["POST", `${STORE}/listing-settings/category-moves/acknowledge`],
    ["post", `${STORE}/listing-settings/category-moves/acknowledge/`],
    ["POST", "/api/dropship/listings/stores/anything/pricing-rules/reviews"],
  ])("skips the global parser for %s %s", (method, path) => {
    expect(isDropshipBulkJsonRequest(method, path)).toBe(true);
  });

  it.each([
    ["GET", `${STORE}/ebay-category-rules`],
    ["POST", `${STORE}/listing-settings/size-prices`],
    ["GET", `${STORE}/pricing-rules/reviews/6f1b1d7e-6d0e-4d43-9a43-2f9d3c0b7c11`],
    ["POST", `${STORE}/pricing-rules/apply`],
    ["GET", `${STORE}/content-profile`],
    ["PUT", `${STORE}/variants/101/content`],
    ["PUT", `${STORE}/listing-settings/size-prices/extra`],
    ["PUT", `/api/dropship/listings/stores/22/x/listing-settings/size-prices`],
    ["PUT", `/admin${STORE}/listing-settings/size-prices`],
    // Only W5's PUT: the read router's GETs and another verb keep the global parser.
    ["GET", `${STORE}/listing-settings/products/7`],
    ["GET", `${STORE}/listing-settings/products/ids`],
    ["POST", `${STORE}/listing-settings/products/7`],
    ["PUT", `${STORE}/listing-settings/products/7/sizes`],
    // Only W6's POST: the read router's GET of the same path, and a longer path, keep the global parser.
    ["GET", `${STORE}/listing-settings/products/bulk`],
    ["POST", `${STORE}/listing-settings/products/bulk/extra`],
    ["POST", `${STORE}/listing-settings/products/bulkier`],
    // Only W12's PUT: the read router's GETs of the categories, another verb and a longer path keep the global parser.
    ["GET", `${STORE}/listing-settings/categories`],
    ["GET", `${STORE}/listing-settings/categories/3`],
    ["POST", `${STORE}/listing-settings/categories/3`],
    ["PUT", `${STORE}/listing-settings/categories`],
    ["PUT", `${STORE}/listing-settings/categories/3/products`],
    // Only W7's two POSTs: the page's GET, another verb and a longer path keep the global parser.
    ["GET", `${STORE}/listing-settings/price-changes/reviews/6f1b1d7e-6d0e-4d43-9a43-2f9d3c0b7c11`],
    ["GET", `${STORE}/listing-settings/price-changes/review`],
    ["PUT", `${STORE}/listing-settings/price-changes/apply`],
    ["POST", `${STORE}/listing-settings/price-changes/apply/extra`],
    ["POST", `${STORE}/listing-settings/price-changes/reviews`],
    // Only W13's POST: another verb, the bare prefix and a longer path keep the global parser.
    ["GET", `${STORE}/listing-settings/category-moves/acknowledge`],
    ["PUT", `${STORE}/listing-settings/category-moves/acknowledge`],
    ["POST", `${STORE}/listing-settings/category-moves`],
    ["POST", `${STORE}/listing-settings/category-moves/acknowledge/extra`],
  ])("leaves %s %s to the global parser", (method, path) => {
    expect(isDropshipBulkJsonRequest(method, path)).toBe(false);
  });

  it("lists eleven routes, each one method and one path", () => {
    expect(BULK_JSON_PATHS.map((entry) => entry.method)).toEqual(["PUT", "POST", "POST", "PUT", "PUT", "PUT", "POST", "PUT", "POST", "POST", "POST"]);
    expect(Object.isFrozen(BULK_JSON_PATHS)).toBe(true);
  });

  it("keeps the category rules' words and gives each new route its own", () => {
    expect(EBAY_CATEGORY_RULES_TOO_LARGE_MESSAGE).toBe(
      "These rules are too large to save at once. Use category, product or product-line rules instead of long lists of single listings.");
    expect(LISTING_SETTINGS_TOO_LARGE_MESSAGE).toBe("This change is too large to send at once. Choose fewer products.");
    expect(PRICING_RULES_TOO_LARGE_MESSAGE).toBe(
      "These pricing rules are too large to save at once. Use category, product or product-line rules instead of long lists of single sizes.");
    expect(CONTENT_PROFILE_TOO_LARGE_MESSAGE).toBe("These descriptions are too large to save at once. Use fewer description groups or shorter text.");
  });
});

describe("parseDropshipBulkJsonFor", () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => { await close?.(); close = null; });

  async function serve(handler: express.RequestHandler): Promise<string> {
    const app = express();
    app.post("/bulk", handler, (req, res) => res.json({ received: req.body }));
    const listener = http.createServer(app);
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    close = () => new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    return `http://127.0.0.1:${(listener.address() as AddressInfo).port}/bulk`;
  }
  const post = (url: string, text: string) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: text });

  it("parses a body up to 1 MiB, answers a larger one with the route's words and logs it once at WARN", async () => {
    const url = await serve(parseDropshipBulkJsonFor("Route words."));
    const big = JSON.stringify({ ids: Array.from({ length: 20_000 }, (_, index) => index) });
    expect(big.length).toBeGreaterThan(100 * 1024);
    expect(await (await post(url, big)).json()).toEqual({ received: JSON.parse(big) });

    const tooLarge = await post(url, JSON.stringify({ padding: "x".repeat(DROPSHIP_BULK_JSON_LIMIT_BYTES + 1) }));
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({ error: { code: "DROPSHIP_REQUEST_TOO_LARGE", message: "Route words." } });
    expect(logger.warn).toHaveBeenCalledWith("dropship.bulk_json_body_rejected", expect.objectContaining({
      outcome: "rejected", error_code: "DROPSHIP_REQUEST_TOO_LARGE", limit_bytes: DROPSHIP_BULK_JSON_LIMIT_BYTES }));
  });

  it("answers broken JSON with 400", async () => {
    const url = await serve(parseDropshipBulkJsonFor("Route words."));
    const response = await post(url, "{\"ids\":");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "DROPSHIP_REQUEST_JSON_INVALID", message: "The request body is not valid JSON." } });
  });

  it("keeps parseDropshipBulkJson as the category rules' parser, with their words", async () => {
    const url = await serve(parseDropshipBulkJson);
    const response = await post(url, JSON.stringify({ padding: "x".repeat(DROPSHIP_BULK_JSON_LIMIT_BYTES + 1) }));
    expect(await response.json()).toEqual({ error: { code: "DROPSHIP_REQUEST_TOO_LARGE", message: EBAY_CATEGORY_RULES_TOO_LARGE_MESSAGE } });
  });
});
