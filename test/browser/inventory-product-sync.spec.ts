import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import type { InventoryProductSyncRequest, InventoryProductSyncReceipt, InventoryProductSyncProgress, InventoryProductSyncReview } from "../../shared/types/inventory-product-sync";

const ROOT = "/api/inventory-planning/admin/product-sync";
const SAVED_SHOPIFY_LINK_CHECK = "Last saved stock-link check: STOCK_LINK_NOT_ON_SALE (waiting); updated 2026-10-29T12:00:00.000Z. Shopify ACTIVE and DRAFT products can qualify for stock linking. Use Check again in Channel Inventory to recheck this saved result. Linking does not publish the product. No automatic retry is scheduled.";
async function setup(page: Page, options: { surface?: "catalog" | "channel" | "preview"; canSync?: boolean } = {}) {
  const state = { checkingLinks: false, allMissing: false, requests: [] as InventoryProductSyncRequest[], receipt: null as InventoryProductSyncReceipt | null,
    loseResponse: false, progressUnavailable: false, verified: false, failed: false, wrongProgress: false, wrongActor: false,
    stale: false, paused: false, reviewUnavailable: false, stockLinkIssue: false, delayResponse: false, releaseResponse: null as (() => void) | null,
    notCarried: false, hash: "a".repeat(64), errors: [] as string[] };
  const mappingBlockers = () => state.notCarried ? ["PUBLICATION_TARGET_VARIANT_MAPPING_MISSING", "STOCK_LINK_NOT_CARRIED"] : ["INVENTORY_MAPPING_MISSING: BINDER-P1 has no active inventory link.",
    ...(state.stockLinkIssue ? [SAVED_SHOPIFY_LINK_CHECK] : [])];
  const variants = [{ id: 51, sku: "BINDER-P1" }, { id: 52, sku: "BINDER-C5" }];
  const destinations = [
    { publicationTargetId: 9, channelId: 7, channelName: "Test Shopify", providerKey: "shopify", externalScopeId: "123" },
    { publicationTargetId: 10, channelId: 8, channelName: "Test eBay", providerKey: "ebay", externalScopeId: "ebay-account" },
    { publicationTargetId: 11, channelId: 9, channelName: "Shopify Canada", providerKey: "shopify", externalScopeId: "456" },
  ];
  const review = (): InventoryProductSyncReview => ({ productId: 41, productName: "Graded slab binder", sku: "BINDER",
    reviewHash: state.hash, ready: !state.paused, blockers: state.paused ? ["GLOBAL_PUBLICATION_PAUSED: All-channel stock updates are paused."] : [],
    targets: destinations.map(target => ({ ...target, status: target.publicationTargetId === 11 ? "blocked" : "ready",
      blockers: target.publicationTargetId === 11 ? mappingBlockers() : [] })),
    rows: destinations.flatMap(target => target.publicationTargetId === 11
      ? [{ ...target, productVariantId: 51, sku: "BINDER-P1", quantity: null, externalInventoryItemId: null, status: "blocked" as const,
        blockers: mappingBlockers() }]
      : variants.map(variant => ({ ...target, productVariantId: variant.id, sku: variant.sku, quantity: variant.id === 51 ? "17" : "0",
        externalInventoryItemId: `${target.publicationTargetId}-${variant.id}`, status: "ready" as const, blockers: [] }))),
  });
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "operator", username: "operator", role: "staff" }, roles: [],
      permissions: ["channels:view", "inventory:view", "inventory:edit", "channels:edit", "inventory_planning:view", ...(options.canSync === false ? [] : ["inventory_planning:activate"])] } });
    if (path === "/api/products/41/shopify-mapping") return route.fulfill({ json: { productId: 41, productName: "Graded slab binder",
      productSku: "BINDER", catalogProductId: "900", channel: { id: 7, name: "Test Shopify" }, status: "consistent", evidenceProductIds: ["900"],
      recommendedProductId: null, repairable: false, activeVariantCount: 2, archivedVariantCount: 0, activeVariantIssueIds: [],
      variants: variants.map((variant, index) => ({ variantId: variant.id, sku: variant.sku, isActive: true,
        catalogVariantId: String(901 + index), feedId: 11 + index, feedIsActive: true, feedProductId: "900", feedVariantId: String(901 + index),
        listingId: 21 + index, listingProductId: "900", listingVariantId: String(901 + index) })) } });
    if (path === "/api/channels") return route.fulfill({ json: [{ id: 7, name: "Test Shopify", provider: "shopify", status: "active", isDefault: 1 }] });
    if (path === "/api/products") return route.fulfill({ json: [{ id: 41, name: "Graded slab binder", sku: "BINDER", shopifyProductId: "900", isActive: true }] });
    if (path === "/api/channels/7/listings") return route.fulfill({ json: [] });
    if (path === "/api/inventory-planning/runtime-authority") return route.fulfill({ json: { contractVersion: "inventory_runtime_authority_readout_v1",
      authority: "canonical", liveAllocator: "inventory_exposure", revision: "2", activationRunId: "1", changedBy: "operator", changeReason: "Fixture", changedAt: "2026-10-29T12:00:00.000Z" } });
    if (path === ROOT + "/review") {
      expect(request.postDataJSON()).toEqual({ productId: 41 });
      if (state.reviewUnavailable) return route.fulfill({ status: 503, json: { error: { message: "ATP review is temporarily unavailable.", definitiveRejected: false } } });
      const current=review();
      if(state.allMissing) { current.ready=false; current.rows=current.rows.map(row=>({...row,status:"blocked",quantity:null,
        externalInventoryItemId:null,blockers:["PUBLICATION_TARGET_VARIANT_MAPPING_MISSING",SAVED_SHOPIFY_LINK_CHECK]}));
        current.targets=current.targets.map(target=>({...target,status:"blocked",blockers:["PUBLICATION_TARGET_VARIANT_MAPPING_MISSING"]})); }
      return route.fulfill({ json: current });
    }
    if (path === ROOT + "/requests" || path.startsWith(ROOT + "/requests/")) {
      if (request.method() === "POST") {
        const intent = request.postDataJSON();
        state.requests.push(intent);
        if (state.stale) { state.stale = false; return route.fulfill({ status: 409,
          json: { error: { message: "Inventory was paused before this request was accepted.", definitiveRejected: true } } }); }
        if (!state.receipt || state.receipt.idempotencyKey !== intent.idempotencyKey) {
          const current = review();
          state.receipt = { productId:41,productName:current.productName,sku:current.sku,targets:current.targets,
            idempotencyKey:intent.idempotencyKey,reviewHash:state.hash,requestedAt:"2026-10-30T12:00:00.000Z",requestedBy:"operator",
            blockedRows:current.rows.filter(row=>row.status==="blocked").map(row=>({...row,status:"blocked"})),
            rows:current.rows.filter(row=>row.status==="ready").map((row,index)=>({...row,status:"ready",quantity:row.quantity!,
              externalInventoryItemId:row.externalInventoryItemId!,outboxId:String(index+state.requests.length*100),revision:String(state.requests.length)})) };
        }
        if (state.loseResponse) { state.loseResponse=false; return route.abort("failed"); }
        if (state.delayResponse) await new Promise<void>(resolve=>{state.releaseResponse=resolve;});
      } else if (state.progressUnavailable || !state.receipt) return route.fulfill({status:503,json:{error:{message:"Status unavailable",definitiveRejected:false}}});
      const receipt=state.receipt!;
      const delivery = { receipt:{...receipt,requestedBy:state.wrongActor?"someone-else":"operator"}, rows:receipt.rows.map(row=>({
        publicationTargetId:row.publicationTargetId,productVariantId:row.productVariantId,outboxId:state.wrongProgress?"999":row.outboxId,
        state:state.failed&&row.providerKey==="ebay"?"dead_letter":state.verified?"verified":"queued",
        errorCode:state.failed&&row.providerKey==="ebay"?"PERMISSION_DENIED":null,
        errorMessage:state.failed&&row.providerKey==="ebay"?"Channel refused the inventory update.":null,
        observedQuantity:state.verified?row.quantity:null,observedAt:state.verified?"2026-10-30T12:00:05.000Z":null })) };
      return route.fulfill({status:request.method()==="POST"?202:200,json:{productId:41,idempotencyKey:receipt.idempotencyKey,
        requestedBy:"operator",requestedAt:receipt.requestedAt,updatedAt:receipt.requestedAt,
        state:state.checkingLinks?"checking_links":"queued",
        message:state.checkingLinks?"Checking this product's inventory links. Provider retries continue automatically.":"Inventory queued through ATP. Waiting for channel verification.",
        review:review(),delivery:state.checkingLinks?null:delivery}});
    }
    if (path === ROOT + "/sync") {
      const command = request.postDataJSON() as InventoryProductSyncRequest; state.requests.push(command);
      if (state.stale) { state.stale = false; state.hash = "b".repeat(64); return route.fulfill({ status: 409,
        json: { error: { code: "PRODUCT_SYNC_REVIEW_STALE", message: "Stock changed. Review current ATP quantities before syncing.", definitiveRejected: true } } }); }
      const replayed = state.receipt?.idempotencyKey === command.idempotencyKey;
      if (!replayed) {
        const current = review();
        state.receipt = { productId: current.productId, productName: current.productName, sku: current.sku, targets: current.targets,
          idempotencyKey: command.idempotencyKey, reviewHash: command.expectedReviewHash, requestedAt: "2026-10-29T12:00:00.000Z", requestedBy: "operator",
          blockedRows: current.rows.filter(row => row.status === "blocked").map(row => ({ ...row, status: "blocked" })),
          rows: current.rows.filter(row => row.status === "ready").map((row, index) => ({ ...row, status: "ready", quantity: row.quantity!,
            externalInventoryItemId: row.externalInventoryItemId!, outboxId: String(index + state.requests.length * 100), revision: String(state.requests.length) })) };
      }
      if (state.loseResponse) { state.loseResponse = false; return route.abort("failed"); }
      if (state.delayResponse) await new Promise<void>(resolve => { state.releaseResponse = resolve; });
      return route.fulfill({ status: 202, json: { receipt: state.receipt, replayed } });
    }
    if (path.startsWith(ROOT + "/commands/")) {
      if (state.progressUnavailable) return route.fulfill({ status: 503, json: { error: { message: "Status unavailable", definitiveRejected: false } } });
      if (!state.receipt) return route.fulfill({ status: 404, json: { error: { message: "Not recorded yet", definitiveRejected: true } } });
      const progress: InventoryProductSyncProgress = { receipt: { ...state.receipt, requestedBy: state.wrongActor ? "another-operator" : "operator" },
        rows: state.receipt.rows.map(row => ({ publicationTargetId: row.publicationTargetId, productVariantId: row.productVariantId,
          outboxId: state.wrongProgress ? "999" : row.outboxId, state: state.failed && row.providerKey === "ebay" ? "dead_letter" : state.verified ? "verified" : "queued",
          errorCode: state.failed && row.providerKey === "ebay" ? "PERMISSION_DENIED" : null,
          errorMessage: state.failed && row.providerKey === "ebay" ? "Channel refused the inventory update." : null,
          observedQuantity: state.verified ? row.quantity : null, observedAt: state.verified ? "2026-10-29T12:00:05.000Z" : null })) };
      return route.fulfill({ json: progress });
    }
    state.errors.push(`Unexpected ${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: { message: "Unexpected request" } } });
  });
  await page.route("**/product-sync-fixture**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
    <body><div id="root"></div><script type="module" src="/@fs/${resolve("test/browser/fixtures/inventory-product-sync-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto(`/product-sync-fixture?surface=${options.surface ?? "catalog"}`);
  return state;
}

async function openReview(page: Page) {
  await page.getByRole("button", { name: "Sync inventory", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sync inventory through ATP", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync eligible inventory", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Sync eligible inventory", exact: true })).toBeInViewport();
}
const queued = "Inventory queued through ATP. Waiting for channel verification.";
const verified = "Eligible inventory verified; some destinations need attention";
for (const surface of ["catalog", "channel", "preview"] as const) test(`records one product sync from the ${surface} surface and tracks every channel`, async ({ page }, info) => {
  const state=await setup(page,{surface}); await openReview(page);
  await expect(page.getByText("Test eBay",{exact:true})).toBeVisible();
  await expect(page.getByText("0 units",{exact:true})).toHaveCount(2);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({path:info.outputPath(`${surface}-atp-review.png`),fullPage:true,animations:"disabled"});
  expect(state.requests).toHaveLength(0);
  await page.getByRole("button",{name:"Sync eligible inventory",exact:true}).click();
  await expect(page.getByText(queued,{exact:true})).toBeVisible();
  expect(Object.keys(state.requests[0]).sort()).toEqual(["idempotencyKey","productId"]);
  expect(state.requests[0].productId).toBe(41);
  await expect(page.getByText(verified,{exact:true})).not.toBeVisible();
  state.verified=true; await expect(page.getByText(verified,{exact:true})).toBeVisible();
  await expect(page.getByText("Verified at channel",{exact:true})).toHaveCount(4);
  expect(state.errors).toEqual([]);
});

test("starts registration even when every ATP mapping is missing and resumes after closing the dialog", async ({page})=>{
  const state=await setup(page); state.allMissing=true; state.checkingLinks=true;
  await openReview(page);
  await expect(page.getByText(SAVED_SHOPIFY_LINK_CHECK,{exact:true})).not.toBeVisible();
  await expect(page.getByText("Existing inventory link will be checked during sync.",{exact:true})).toHaveCount(5);
  await page.getByRole("button",{name:"Sync eligible inventory",exact:true}).click();
  await expect(page.getByRole("status").filter({hasText:"Checking this product's inventory links"})).toBeVisible();
  await page.getByRole("button",{name:"Close",exact:true}).first().click();
  state.checkingLinks=false;state.allMissing=false;
  await page.getByRole("button",{name:"Sync inventory",exact:true}).click();
  await expect(page.getByText(queued,{exact:true})).toBeVisible();
  expect(state.requests).toHaveLength(1);expect(state.errors).toEqual([]);
});

test("retries the same recorded identity after a lost acceptance response",async({page})=>{
  const state=await setup(page);state.loseResponse=true;state.progressUnavailable=true;
  await openReview(page);await page.getByRole("button",{name:"Sync eligible inventory",exact:true}).click();
  await expect(page.getByRole("button",{name:"Retry same sync",exact:true})).toBeEnabled();
  const first=state.requests[0];state.progressUnavailable=false;
  await page.getByRole("button",{name:"Retry same sync",exact:true}).click();
  await expect(page.getByText(queued,{exact:true})).toBeVisible();
  expect(state.requests[1]).toEqual(first);expect(state.errors).toEqual([]);
});

test("allows a new key only after a definitive pre-acceptance refusal",async({page})=>{
  const state=await setup(page);state.stale=true;await openReview(page);
  await page.getByRole("button",{name:"Sync eligible inventory",exact:true}).click();
  await expect(page.getByText("Inventory was paused before this request was accepted.",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Sync eligible inventory",exact:true}).click();
  await expect(page.getByText(queued,{exact:true})).toBeVisible();
  expect(state.requests[0].idempotencyKey).not.toBe(state.requests[1].idempotencyKey);
});

test("keeps channel failures visible alongside exact verified deliveries",async({page})=>{
  const state=await setup(page);state.failed=true;state.verified=true;await openReview(page);
  await page.getByRole("button",{name:"Sync eligible inventory",exact:true}).click();
  await expect(page.getByText("Delivery failed",{exact:true})).toHaveCount(2);
  await expect(page.getByText("Verified at channel",{exact:true})).toHaveCount(2);
  await expect(page.getByText(verified,{exact:true})).not.toBeVisible();
  await expect(page.getByText("Channel refused the inventory update.",{exact:true})).toHaveCount(2);
  expect(state.errors).toEqual([]);
});
for(const mismatch of ["wrongProgress","wrongActor"] as const)test(`rejects ${mismatch} delivery evidence`,async({page})=>{
  const state=await setup(page);state[mismatch]=true;state.verified=true;await openReview(page);
  await page.getByRole("button",{name:"Sync eligible inventory",exact:true}).click();
  await expect(page.getByText("Current status is unavailable. The original request is retained.",{exact:true})).toBeVisible();
  await expect(page.getByText(verified,{exact:true})).not.toBeVisible();expect(state.errors).toEqual([]);
});
test("explains a settled listing exclusion without asking for another ATP check", async ({ page }) => {
  const state = await setup(page);
  state.notCarried = true;
  state.verified = true;
  await openReview(page);
  await page.getByRole("button", { name: "Sync eligible inventory", exact: true }).click();
  await expect(page.getByText(verified, { exact: true })).toBeVisible();
  await expect(page.getByText("This item has no eligible listing selected for inventory at this destination.", { exact: true })).toHaveCount(1);
  await expect(page.getByText("The existing channel inventory link needs an ATP check.", { exact: true })).toHaveCount(0);
  expect(state.requests).toHaveLength(1);
  expect(state.errors).toEqual([]);
});

test("requires activation permission",async({page})=>{
  const state=await setup(page,{canSync:false});await expect(page.getByRole("button",{name:"Sync inventory",exact:true})).toBeDisabled();
  expect(state.requests).toEqual([]);
});
test("honors the global inventory pause",async({page})=>{
  const state=await setup(page);state.paused=true;await page.getByRole("button",{name:"Sync inventory",exact:true}).click();
  await expect(page.getByRole("button",{name:"Sync eligible inventory",exact:true})).toBeDisabled();
  await expect(page.getByText("GLOBAL_PUBLICATION_PAUSED: All-channel stock updates are paused.",{exact:true})).toBeVisible();expect(state.requests).toEqual([]);
});
test("retains unreadable legacy command recovery instead of overwriting it",async({page})=>{
  const state=await setup(page);await page.evaluate(()=>sessionStorage.setItem("inventory-product-sync:v1:operator:41",JSON.stringify({productId:42,
    idempotencyKey:"11111111-1111-4111-8111-111111111111",expectedReviewHash:"a".repeat(64)})));
  await page.getByRole("button",{name:"Sync inventory",exact:true}).click();
  await expect(page.getByText("The saved inventory sync cannot be read. Its outcome must be checked before starting another sync.",{exact:true})).toBeVisible();
  expect(state.requests).toEqual([]);
});
test("preserves the previous Shopify send notice without replaying that request",async({page})=>{
  const state=await setup(page);await page.evaluate(()=>sessionStorage.setItem("inventory-stock-send:v1:operator:41:all:all",JSON.stringify({productId:41,
    publicationTargetId:9,productVariantIds:[51],idempotencyKey:"11111111-1111-4111-8111-111111111111",expectedReviewHash:"a".repeat(64)})));
  await openReview(page);await expect(page.getByLabel("Previous inventory send")).toContainText("This ATP sync does not retry that request.");
  expect(state.requests).toEqual([]);
});
test("starts a fresh request only after terminal delivery",async({page})=>{
  const state=await setup(page);state.verified=true;await openReview(page);
  await page.getByRole("button",{name:"Sync eligible inventory",exact:true}).click();
  await expect(page.getByText(verified,{exact:true})).toBeVisible();const first=state.requests[0];
  await page.getByRole("button",{name:"Sync again",exact:true}).click();state.verified=false;
  await page.getByRole("button",{name:"Sync eligible inventory",exact:true}).click();
  await expect(page.getByText(queued,{exact:true})).toBeVisible();
  expect(state.requests[1].idempotencyKey).not.toBe(first.idempotencyKey);expect(state.errors).toEqual([]);
});
test("retains recovery details while an acceptance response is still in flight",async({page})=>{
  const state=await setup(page);state.delayResponse=true;state.verified=true;await openReview(page);
  try{
    await page.getByRole("button",{name:"Sync eligible inventory",exact:true}).click();
    await expect(page.getByText(verified,{exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:"Sync again",exact:true})).toBeDisabled();
    state.releaseResponse?.();await expect(page.getByRole("button",{name:"Sync again",exact:true})).toBeEnabled();
    expect(state.requests).toHaveLength(1);
  }finally{state.releaseResponse?.();}
});
test("recovers a delayed status failure after acceptance returns verified delivery", async ({ page }) => {
  const state = await setup(page);
  state.delayResponse = true;
  state.verified = true;
  let releaseStatus: (() => void) | undefined;
  let firstStatus = true;
  await page.route("**/product-sync/requests/*", async route => {
    if (!firstStatus) return route.fallback();
    firstStatus = false;
    await new Promise<void>(resolve => { releaseStatus = resolve; });
    return route.fulfill({ status: 503, json: { error: { message: "Delayed status failure", definitiveRejected: false } } });
  });
  try {
    await openReview(page);
    await page.getByRole("button", { name: "Sync eligible inventory", exact: true }).click();
    await expect.poll(() => Boolean(releaseStatus && state.releaseResponse)).toBe(true);
    state.releaseResponse?.();
    await expect(page.getByText(verified, { exact: true })).toBeVisible();
    releaseStatus?.();
    await expect(page.getByText("Current status is unavailable. The original request is retained.", { exact: true })).toBeVisible();
    await expect(page.getByText(verified, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sync again", exact: true })).toBeEnabled();
    expect(state.requests).toHaveLength(1);
    expect(state.errors).toEqual([]);
  } finally {
    releaseStatus?.();
    state.releaseResponse?.();
  }
});

test("hides stale quantities after a failed review refresh",async({page})=>{
  const state=await setup(page);await openReview(page);state.reviewUnavailable=true;
  await page.getByRole("button",{name:"Refresh review",exact:true}).click();
  await expect(page.getByText("ATP review is temporarily unavailable.",{exact:true})).toBeVisible();
  await expect(page.getByText("17 units",{exact:true})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Sync eligible inventory",exact:true})).toBeDisabled();
  state.reviewUnavailable=false;await page.getByRole("button",{name:"Refresh review",exact:true}).click();
  await expect(page.getByText("17 units",{exact:true})).toHaveCount(2);expect(state.requests).toEqual([]);
});
