/** eBay documents REQUEST/BUSINESS categories in uppercase, but its Inventory
 * API also returns title-case "Request". Case must not change response finality.
 * https://developer.ebay.com/develop/guides/sell/using-ebay-restful-apis */
export function isEbayProviderRefusalCategory(category: string | undefined): boolean {
  return category !== undefined && ["REQUEST", "BUSINESS"].includes(category.toUpperCase());
}

/** Historical receipts retain error IDs, not their category or raw body. Only
 * these documented HTTP 400 input refusals are reinterpreted from that evidence;
 * a generic APPLICATION error or HTTP status alone cannot prove rejection.
 * https://developer.ebay.com/develop/api/sell/inventory_api/location/bulkCreateOrReplaceInventoryItem */
const DOCUMENTED_INPUT_REJECTIONS: ReadonlySet<string> = new Set([
  "25007", // Invalid shipping policy information.
  "25016", // Invalid field value.
]);

export function isDocumentedEbayInputRejection(status: number | null, errorCodes: readonly string[]): boolean {
  return status === 400 && errorCodes.length > 0 && errorCodes.length <= 25
    && errorCodes.every(code => DOCUMENTED_INPUT_REJECTIONS.has(code));
}
