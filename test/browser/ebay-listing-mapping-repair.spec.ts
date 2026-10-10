import { expect, test, type Page, type Route } from "@playwright/test";
import type { EbayListingMappingApply, EbayListingMappingReview } from "../../shared/types/ebay-listing-mapping";
import { setupEbayChannelPage } from "./fixtures/ebay-channel-page.fixture";

const job = {
  id: "f08ab89b-4bb4-4fa7-9591-c9bc7439ec36", productId: 1, kind: "sync", state: "queued", code: null, message: null,
  nextAttemptAt: "2026-10-10T12:00:00.000Z", updatedAt: "2026-10-10T12:00:00.000Z",
};
const review: EbayListingMappingReview = {
  productId: 1, reviewHash: "a".repeat(64), observedAt: "2026-10-10T12:00:00.000Z",
  title: "The saved offer points to an older eBay offer",
  diagnosticCode: null,
  membership: null,
  explanation: "The complete live listing has the expected variants. Echelon can update its saved mapping to that verified listing.",
  rows: [{
    variantId: 101, catalogSku: "SHLZ-TOP-180PT-CLR-P10", savedSku: "SHLZ-TOP-180PT-P10",
    savedOfferId: "offer-old", savedListingId: "listing-old",
    observedOffers: [{ sku: "SHLZ-TOP-180PT-P10", offerId: "offer-current", status: "PUBLISHED", listingId: "listing-current", listingStatus: "ACTIVE" }],
    problem: "offer_changed", recommendation: "Replace offer-old with the verified offer-current and listing-current for this SKU.",
  }],
  effects: ["Update the saved eBay offer and listing identifiers for this product.", "Queue a fresh listing sync using current catalog content and inventory."],
  canApply: true, allowedToApply: true, requiredPermission: null,
  action: { kind: "apply_fix", label: "Apply verified mapping and sync" }, manualSteps: [],
};
function queued(command: EbayListingMappingApply) {
  return { repairStatus: "queued", job, replayed: false, receipt: { commandKey: command.commandKey, productId: 1, reviewHash: command.reviewHash, appliedAt: "2026-10-10T12:00:01.000Z" } };
}
async function setup(page: Page) {
  const state = await setupEbayChannelPage(page);
  state.jobs = [{ ...job, state: "needs_attention", code: "EBAY_SYNC_PROVIDER_IDENTITY_CHANGED", message: "The offer identity needs verification." }];
  const mapping = {
    review: structuredClone(review), reads: 0, commands: [] as EbayListingMappingApply[], receiptReads: [] as string[],
    post: null as ((route: Route, command: EbayListingMappingApply) => Promise<void>) | null,
    receipt: null as ReturnType<typeof queued> | null,
  };
  await page.route("**/api/ebay/listings/products/1/mapping-review", async (route) => {
    if (route.request().method() === "GET") { mapping.reads++; return route.fulfill({ json: mapping.review }); }
    const command = route.request().postDataJSON() as EbayListingMappingApply;
    mapping.commands.push(command);
    if (mapping.post) return mapping.post(route, command);
    state.jobs = [job];
    return route.fulfill({ json: queued(command) });
  });
  await page.route("**/api/ebay/listings/products/1/mapping-repairs/*", (route) => {
    mapping.receiptReads.push(new URL(route.request().url()).pathname.split("/").at(-1)!);
    return mapping.receipt
      ? route.fulfill({ json: mapping.receipt })
      : route.fulfill({ status: 404, json: { code: "EBAY_MAPPING_REPAIR_NOT_FOUND", error: "No saved receipt was found." } });
  });
  await page.reload();
  await page.getByRole("button", { name: "Review listing mapping", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Fix eBay listing mapping" })).toBeVisible();
  return { state, mapping, dialog };
}

test("mapping diagnosis gives a concrete per-SKU correction and Recheck only reads", async ({ page }, info) => {
  const { state, mapping, dialog } = await setup(page);
  await expect(dialog).toContainText(review.title);
  await expect(dialog).toContainText("Saved in Echelon");
  await expect(dialog).toContainText("Current eBay details");
  await expect(dialog).toContainText("SHLZ-TOP-180PT-CLR-P10");
  await expect(dialog).toContainText("Replace offer-old with the verified offer-current");
  await expect(dialog).toContainText("What this action will do");
  await dialog.getByRole("button", { name: "Recheck mapping", exact: true }).click();
  await expect.poll(() => mapping.reads).toBe(2);
  expect(mapping.commands).toEqual([]); expect(state.commands).toEqual([]);
  await expect(dialog.getByRole("button", { name: review.action.label })).toBeEnabled();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath("ebay-mapping-review.png") });
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("Apply queues the verified repair and only authoritative job completion reports success", async ({ page }) => {
  const { state, mapping, dialog } = await setup(page);
  await dialog.getByRole("button", { name: review.action.label }).click();
  await expect(dialog.getByRole("status")).toContainText("Listing sync is queued or running");
  expect(mapping.commands).toHaveLength(1);
  expect(mapping.commands[0]).toMatchObject({ reviewHash: review.reviewHash });
  expect(mapping.commands[0].commandKey).toMatch(/^[a-f0-9-]{36}$/);
  await expect(dialog).not.toContainText("Listing sync completed.");
  state.jobs = [{ ...job, state: "completed" }];
  await dialog.getByRole("button", { name: "Refresh sync status" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Listing sync completed.");
  expect(state.commands).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a stale review requires a fresh comparison and a new explicit apply", async ({ page }) => {
  const { state, mapping, dialog } = await setup(page);
  mapping.post = async (route) => route.fulfill({ status: 409, json: { code: "EBAY_MAPPING_REVIEW_STALE", error: "The current mapping changed after your review." } });
  await dialog.getByRole("button", { name: review.action.label }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "This repair request was rejected" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: review.action.label })).toBeDisabled();
  mapping.review = { ...review, reviewHash: "b".repeat(64), title: "Updated comparison after the listing changed" };
  await dialog.getByRole("button", { name: "Recheck mapping", exact: true }).click();
  await expect(dialog).toContainText(mapping.review.title);
  mapping.post = null;
  await dialog.getByRole("button", { name: review.action.label }).click();
  await expect(dialog.getByRole("status")).toContainText("Listing sync is queued or running");
  expect(mapping.commands).toHaveLength(2);
  expect(mapping.commands[1].reviewHash).toBe("b".repeat(64));
  expect(mapping.commands[1].commandKey).not.toBe(mapping.commands[0].commandKey);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("lost response finds the exact saved receipt without submitting another repair", async ({ page }) => {
  const { state, mapping, dialog } = await setup(page);
  mapping.post = async (route) => route.abort("failed");
  await dialog.getByRole("button", { name: review.action.label }).click();
  await expect(dialog.getByRole("button", { name: "Retry this fix" })).toBeEnabled();
  const command = mapping.commands[0];
  mapping.receipt = { ...queued(command), replayed: true };
  state.jobs = [job];
  await dialog.getByRole("button", { name: "Check saved request" }).click();
  await expect(dialog.getByRole("status")).toContainText("Listing sync is queued or running");
  expect(mapping.receiptReads).toContain(command.commandKey);
  expect(mapping.commands).toHaveLength(1);
  expect(await page.evaluate(() => sessionStorage.getItem("ebay:mapping-repair:1"))).toBeNull();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a lost request survives reload and retries the same review and command after receipt 404", async ({ page }) => {
  const { state, mapping, dialog } = await setup(page);
  mapping.post = async (route) => route.abort("failed");
  await dialog.getByRole("button", { name: review.action.label }).click();
  await expect(dialog.getByRole("button", { name: "Retry this fix" })).toBeEnabled();
  const command = mapping.commands[0];
  await page.reload();
  await page.getByRole("button", { name: "Review listing mapping", exact: true }).click();
  await expect(dialog).toContainText("No saved receipt was found yet");
  expect(mapping.commands).toHaveLength(1);
  mapping.post = null;
  await dialog.getByRole("button", { name: "Retry this fix" }).click();
  await expect(dialog.getByRole("status")).toContainText("Listing sync is queued or running");
  expect(mapping.commands).toEqual([command, command]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("ambiguous offers have a concrete Seller Hub action and never offer an automatic fix", async ({ page }) => {
  const { state, mapping, dialog } = await setup(page);
  mapping.review = {
    ...review, reviewHash: null, canApply: false, title: "Two published offers match this SKU", action: { kind: "manual", label: "Review listing in eBay" },
    rows: [{ ...review.rows[0], problem: "ambiguous", recommendation: "Identify the intended listing in Seller Hub before changing its mapping.", observedOffers: [...review.rows[0].observedOffers, { ...review.rows[0].observedOffers[0], offerId: "second-offer", listingId: "second-listing" }] }],
    effects: [], manualSteps: [{ text: "Compare the two listings for SHLZ-TOP-180PT-P10 in Seller Hub", href: "https://www.ebay.com/sh/lst/active" }],
  };
  await dialog.getByRole("button", { name: "Recheck mapping", exact: true }).click();
  await expect(dialog).toContainText("Two published offers");
  await expect(dialog.getByRole("link", { name: /Compare the two listings/ })).toHaveAttribute("href", "https://www.ebay.com/sh/lst/active");
  await expect(dialog.getByRole("button", { name: review.action.label })).toHaveCount(0);
  expect(mapping.commands).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("provider auth failure offers connection settings and read retry instead of a fake mismatch", async ({ page }) => {
  const { state, mapping, dialog } = await setup(page);
  mapping.review = { ...review, title: "Reconnect the intended eBay account", explanation: "eBay rejected the account authorization; its offers have not been verified.", rows: [], effects: [], reviewHash: null, canApply: false, action: { kind: "reconnect", label: "Review connection" }, manualSteps: [] };
  await dialog.getByRole("button", { name: "Recheck mapping", exact: true }).click();
  await expect(dialog.getByRole("link", { name: "Open connection settings" })).toHaveAttribute("href", "/channels/ebay#connection");
  await expect(dialog).toContainText("offers have not been verified");
  await expect(dialog.getByRole("button", { name: review.action.label })).toHaveCount(0);
  expect(mapping.commands).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("read-only permission shows the exact missing permission and prevents Apply", async ({ page }) => {
  const { state, mapping, dialog } = await setup(page);
  mapping.review = { ...review, canApply: false, allowedToApply: false, requiredPermission: "channels:edit" };
  await dialog.getByRole("button", { name: "Recheck mapping", exact: true }).click();
  await expect(dialog).toContainText("applying it requires permission to edit channels (channels:edit)");
  await expect(dialog.getByRole("button", { name: review.action.label })).toBeDisabled();
  expect(mapping.commands).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a mismatch that disappeared offers Resume sync through the reviewed command", async ({ page }) => {
  const { state, mapping, dialog } = await setup(page);
  mapping.review = { ...review, title: "The saved mapping now matches eBay", action: { kind: "resume_sync", label: "Resume sync" }, effects: ["Queue a fresh listing sync using current catalog content and inventory."] };
  await dialog.getByRole("button", { name: "Recheck mapping", exact: true }).click();
  await dialog.getByRole("button", { name: "Resume sync", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Listing sync is queued or running");
  expect(mapping.commands).toHaveLength(1); expect(state.commands).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a mismatched receipt cannot claim completion or discard the original retry key", async ({ page }) => {
  const { state, mapping, dialog } = await setup(page);
  mapping.post = async (route, command) => route.fulfill({ json: { ...queued(command), receipt: { ...queued(command).receipt, productId: 2 }, job: { ...job, state: "completed" } } });
  await dialog.getByRole("button", { name: review.action.label }).click();
  await expect(dialog).toContainText("The repair receipt does not match this product and request");
  await expect(dialog.getByRole("button", { name: "Retry this fix" })).toBeEnabled();
  await expect(dialog).not.toContainText("Listing sync completed.");
  expect(JSON.parse((await page.evaluate(() => sessionStorage.getItem("ebay:mapping-repair:1")))!)).toEqual(mapping.commands[0]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("canonical registration conflicts open the existing review with a preview and no repair write", async ({ page }) => {
  const { state, mapping, dialog } = await setup(page);
  mapping.review = { ...review, canApply: false, reviewHash: null, action: { kind: "review_registered_listing", label: "Review registered listing" }, title: "The registered listing differs from the current publication", effects: [], manualSteps: [{ text: "Compare the current publication with its registered variants before making a change." }] };
  const previews: unknown[] = [];
  await page.route("**/api/ebay/listings/push", async (route) => {
    previews.push(route.request().postDataJSON());
    return route.fulfill({ json: { results: [{ productId: 1, success: true, rebuildPreview: {
      productId: 1, groupKey: "PHOTO-PRODUCT", currentExternalListingId: "listing-current", sourceState: "active",
      currentSkus: ["SHLZ-TOP-180PT-P10"], activeSkus: ["SHLZ-TOP-180PT-P10"], inactiveSkus: [], desiredSkus: ["SHLZ-TOP-180PT-P10"],
      addedSkus: [], removedSkus: [], rebuildRequired: false, confirmationToken: "c".repeat(64),
    } }] } });
  });
  await dialog.getByRole("button", { name: "Recheck mapping", exact: true }).click();
  await dialog.getByRole("button", { name: "Review registered listing", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review eBay listing changes", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("The live eBay variants already match Echelon");
  expect(previews).toEqual([{ productIds: [1], rebuild: { mode: "preview" } }]);
  expect(mapping.commands).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("unreadable saved retry details block new commands until the original request can be recovered", async ({ page }) => {
  const { state, mapping, dialog } = await setup(page);
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  const command = { reviewHash: review.reviewHash, commandKey: "d61b6950-ad51-4b3d-a351-86586657d637" };
  await page.evaluate((request) => {
    sessionStorage.setItem("ebay:mapping-repair:1", JSON.stringify(request));
    const original = Storage.prototype.getItem;
    (window as Window & { restoreMappingStorage?: () => void }).restoreMappingStorage = () => { Storage.prototype.getItem = original; };
    Storage.prototype.getItem = function (key: string) { if (key === "ebay:mapping-repair:1") throw new Error("Storage access denied"); return original.call(this, key); };
  }, command);
  await page.getByRole("button", { name: "Review listing mapping", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("An earlier fix may have been sent");
  await expect(dialog.getByRole("button", { name: review.action.label })).toBeDisabled();
  expect(mapping.commands).toEqual([]);
  await page.evaluate(() => (window as Window & { restoreMappingStorage?: () => void }).restoreMappingStorage?.());
  await dialog.getByRole("button", { name: "Retry loading saved request" }).click();
  await expect(dialog).toContainText("No saved receipt was found yet");
  await dialog.getByRole("button", { name: "Retry this fix" }).click();
  await expect(dialog.getByRole("status")).toContainText("Listing sync is queued or running");
  expect(mapping.commands).toEqual([command]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("storage write failure sends no request and can be retried once storage works", async ({ page }) => {
  const { state, mapping, dialog } = await setup(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as Window & { restoreMappingStorage?: () => void }).restoreMappingStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function (key: string, value: string) { if (key === "ebay:mapping-repair:1") throw new Error("Storage full"); return original.call(this, key, value); };
  });
  await dialog.getByRole("button", { name: review.action.label }).click();
  await expect(dialog.getByRole("alert")).toContainText("the fix was not sent");
  expect(mapping.commands).toEqual([]);
  await page.evaluate(() => (window as Window & { restoreMappingStorage?: () => void }).restoreMappingStorage?.());
  await dialog.getByRole("button", { name: review.action.label }).click();
  await expect(dialog.getByRole("status")).toContainText("Listing sync is queued or running");
  expect(mapping.commands).toHaveLength(1); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("an incomplete provider read offers a named recheck and never enables Apply", async ({ page }) => {
  const { state, mapping, dialog } = await setup(page);
  mapping.review = { ...review, canApply: false, reviewHash: null, title: "eBay did not return a complete listing", diagnosticCode: "EBAY_LISTING_READ_TIMEOUT", explanation: "The eBay read timed out. No mapping correction is authorized until the complete listing can be checked.", rows: [], effects: [], action: { kind: "retry_read", label: "Check eBay again" } };
  await dialog.getByRole("button", { name: "Recheck mapping", exact: true }).click();
  await expect(dialog).toContainText("EBAY_LISTING_READ_TIMEOUT");
  await expect(dialog.getByRole("button", { name: review.action.label })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Check eBay again" }).click();
  await expect.poll(() => mapping.reads).toBe(3);
  expect(mapping.commands).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("membership mismatch identifies the missing and additional SKUs without inventing a fix", async ({ page }) => {
  const { state, mapping, dialog } = await setup(page);
  mapping.review = { ...review, canApply: false, reviewHash: null, action: { kind: "manual", label: "Review listing in eBay" }, effects: [], title: "The live group contains different variants", membership: {
    expectedSkus: ["EXPECTED-P10", "EXPECTED-C500"], observedSkus: ["EXPECTED-P10", "EXTRA-C200"], missingSkus: ["EXPECTED-C500"], extraSkus: ["EXTRA-C200"], groupKey: "TOPLOADERS",
  }, manualSteps: [{ text: "Compare the current SKU membership in Seller Hub", href: "https://www.ebay.com/sh/lst/active" }] };
  await dialog.getByRole("button", { name: "Recheck mapping", exact: true }).click();
  await expect(dialog).toContainText("Missing from eBay: EXPECTED-C500");
  await expect(dialog).toContainText("Additional eBay variants: EXTRA-C200");
  await expect(dialog.getByRole("button", { name: review.action.label })).toHaveCount(0);
  expect(mapping.commands).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a receipt for a different review cannot resolve an uncertain repair", async ({ page }) => {
  const { state, mapping, dialog } = await setup(page);
  mapping.post = async (route) => route.abort("failed");
  await dialog.getByRole("button", { name: review.action.label }).click();
  await expect(dialog.getByRole("button", { name: "Retry this fix" })).toBeEnabled();
  const saved = queued(mapping.commands[0]);
  mapping.receipt = { ...saved, receipt: { ...saved.receipt, reviewHash: "e".repeat(64) } };
  await dialog.getByRole("button", { name: "Check saved request" }).click();
  await expect(dialog).toContainText("The saved receipt could not be checked");
  await expect(dialog).not.toContainText("Listing sync is queued or running");
  expect(JSON.parse((await page.evaluate(() => sessionStorage.getItem("ebay:mapping-repair:1")))!)).toEqual(mapping.commands[0]);
  expect(mapping.commands).toHaveLength(1); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a durable rejection found after a lost response returns to fresh review instead of a retry loop", async ({ page }) => {
  const { state, mapping, dialog } = await setup(page);
  mapping.post = async (route) => route.abort("failed");
  await dialog.getByRole("button", { name: review.action.label }).click();
  await expect(dialog.getByRole("button", { name: "Retry this fix" })).toBeEnabled();
  await page.route("**/api/ebay/listings/products/1/mapping-repairs/*", (route) => route.fulfill({ status: 409, json: { code: "EBAY_MAPPING_REVIEW_CHANGED", error: "The saved mapping changed; this command was durably rejected." } }));
  await dialog.getByRole("button", { name: "Check saved request" }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "This repair request was rejected" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Retry this fix" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: review.action.label })).toBeDisabled();
  expect(await page.evaluate(() => sessionStorage.getItem("ebay:mapping-repair:1"))).toBeNull();
  await dialog.getByRole("button", { name: "Recheck mapping", exact: true }).click();
  await expect(dialog.getByRole("button", { name: review.action.label })).toBeEnabled();
  expect(mapping.commands).toHaveLength(1); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("manual action links cannot navigate to an untrusted or disguised external destination", async ({ page }) => {
  const { state, mapping, dialog } = await setup(page);
  mapping.review = { ...review, canApply: false, reviewHash: null, action: { kind: "manual", label: "Review listing in eBay" }, effects: [], manualSteps: [
    { text: "Unsafe protocol", href: "javascript:alert(1)" },
    { text: "Disguised external link", href: "/\n/other.example/listings" },
    { text: "Lookalike eBay host", href: "https://www.ebay.com.attacker.example/listings" },
    { text: "Open the catalog product", href: "/products/1" },
  ] };
  await dialog.getByRole("button", { name: "Recheck mapping", exact: true }).click();
  await expect(dialog.getByRole("link")).toHaveCount(1);
  await expect(dialog.getByRole("link", { name: /Open the catalog product/ })).toHaveAttribute("href", "/products/1");
  expect(mapping.commands).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a viewer is not sent into the registered listing workflow without its required edit permission", async ({ page }) => {
  const { state, mapping, dialog } = await setup(page);
  mapping.review = { ...review, canApply: false, allowedToApply: false, requiredPermission: "channels:edit", reviewHash: null, action: { kind: "review_registered_listing", label: "Review registered listing" }, effects: [] };
  await dialog.getByRole("button", { name: "Recheck mapping", exact: true }).click();
  await expect(dialog).toContainText("Opening the registered listing change workflow requires permission to edit channels (channels:edit)");
  await expect(dialog.getByRole("button", { name: "Review registered listing", exact: true })).toBeDisabled();
  expect(mapping.commands).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});
