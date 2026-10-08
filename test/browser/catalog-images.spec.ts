import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import type { ReorderProductAssets, CatalogGalleryAsset } from "../../shared/catalog/product-assets";
import type { ProductAssetScopeCommand } from "../../shared/catalog/product-asset-scope";

const photoBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");
function preview(index: number) {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#f0f4f8"/><rect x="60" y="85" width="280" height="230" rx="12" fill="${["#2563eb", "#4338ca", "#0e7490", "#475569"][index - 1]}"/><text x="200" y="180" fill="white" font-size="24" text-anchor="middle" font-family="sans-serif">EASY GLIDE</text><text x="200" y="225" fill="white" font-size="16" text-anchor="middle" font-family="sans-serif">Product photo ${index}</text></svg>`)}`;
}

async function setup(page: Page, canEdit = true) {
  const assets: CatalogGalleryAsset[] = [1, 2, 3, 4].map((id, index) => ({ id, url: preview(id), altText: `Photo ${id}`, assetType: "image",
    isPrimary: id === 2 ? 1 : 0, position: index, productVariantId: id === 1 ? 10 : null, storageType: id === 4 ? "file" : "url" }));
  const state = { assets, orders: [] as ReorderProductAssets[], downloads: [] as number[], errors: [] as string[], rejectOrder: false, rejectDownload: false, delayOrder: false,
    scopeCalls: [] as { assetId:number; command:ProductAssetScopeCommand; key:string }[], scopeWrites:0,
    rejectScope:false, loseScopeResponse:false, editAfterCommit:false,
    receipts:new Map<string,{ productId:number; assetId:number; productVariantId:number|null; changed:boolean }>() };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "operator", role: "staff", username: "operator" }, permissions: canEdit ? ["inventory:view", "inventory:edit"] : ["inventory:view"], roles: [] } });
    if (path === "/api/products/1") return route.fulfill({ json: {
      id: 1, productId: 1, sku: "ESS-TOP-55PT-SLV-CLR", name: "55PT 3x4 Toploader Essentials Clear+ Easy Glide Combo Pack",
      title: null, description: null, brand: "Shellz", status: "active", isActive: true, inventoryTrackingDefault: true,
      baseUnit: "piece", inventoryStrategy: "physical_fungible", variants: [
        { id:10,sku:"ESS-TOP-55PT-SLV-CLR-P50",name:"Pack of 50",isActive:true,unitsPerVariant:50,hierarchyLevel:1 },
        { id:11,sku:"ESS-TOP-55PT-SLV-CLR-C500",name:"Case of 500",isActive:true,unitsPerVariant:500,hierarchyLevel:2 },
      ], assets: state.assets,
    } });
    const scope = path.match(/^\/api\/products\/1\/assets\/(\d+)\/scope$/);
    if (scope) {
      const assetId = Number(scope[1]), command = request.postDataJSON() as ProductAssetScopeCommand;
      const key = request.headers()["idempotency-key"];
      state.scopeCalls.push({ assetId, command, key });
      if (!key) return route.fulfill({ status:400,json:{ error:"Missing stable command key." } });
      const previous = state.receipts.get(key);
      if (previous) return route.fulfill({ json:previous,headers:{ "Idempotency-Replayed":"true" } });
      const asset = state.assets.find(item => item.id === assetId)!;
      if (state.rejectScope) {
        state.rejectScope = false; asset.productVariantId = 11;
        return route.fulfill({ status:409,json:{ code:"ASSET_SCOPE_CHANGED",error:"This photo's assignment changed in another session." } });
      }
      if (asset.productVariantId !== command.expectedProductVariantId) return route.fulfill({
        status:409,json:{ code:"ASSET_SCOPE_CHANGED",error:"Refresh the assignment." },
      });
      asset.productVariantId = command.productVariantId;
      state.scopeWrites++;
      const receipt = { productId:1,assetId,productVariantId:command.productVariantId,changed:true };
      state.receipts.set(key,receipt);
      if (state.loseScopeResponse) {
        state.loseScopeResponse = false;
        if (state.editAfterCommit) asset.productVariantId = 11;
        return route.abort("failed");
      }
      return route.fulfill({ json:receipt });
    }
    if (path === "/api/products/1/assets/reorder") {
      const command = request.postDataJSON() as ReorderProductAssets;
      state.orders.push(command);
      if (state.delayOrder) await new Promise(resolve => setTimeout(resolve, 250));
      if (state.rejectOrder) return route.fulfill({ status: 409, json: { error: "Image order changed in another session. Refresh and try again." } });
      state.assets = command.orderedIds.map((id, position) => ({ ...state.assets.find(asset => asset.id === id)!, position }));
      return route.fulfill({ json: { success: true } });
    }
    const download = path.match(/^\/api\/product-assets\/(\d+)\/download$/);
    if (download) {
      const id = Number(download[1]); state.downloads.push(id);
      if (state.rejectDownload) return route.fulfill({ status: 502, json: { error: "Could not connect to the image source. Try again." } });
      return route.fulfill({ contentType: "image/png", body: photoBytes, headers: { "Content-Disposition": `attachment; filename="ESS-TOP-55PT-image-${id}.png"` } });
    }
    if (path === "/api/product-assets/4/file") return route.fulfill({ contentType: "image/svg+xml", body: decodeURIComponent(preview(4).split(",")[1]) });
    if (path === "/api/settings") return route.fulfill({ json: {} });
    if (path.includes("runtime-authority")) return route.fulfill({ json: { authority: "legacy" } });
    if (["/api/product-categories", "/api/shipping-groups", "/api/vendors", "/api/products/1/locations", "/api/products/1/vendors"].includes(path)) return route.fulfill({ json: [] });
    state.errors.push(`Unexpected ${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: "Unexpected test request" } });
  });
  await page.route("**/products/1?tab=images", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><main id="root"></main><script type="module" src="/@fs/${resolve("test/browser/fixtures/catalog-images-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto("/products/1?tab=images");
  await expect(page.getByRole("button", { name: "Download image 1", exact: true })).toBeVisible();
  return state;
}

async function imageOrder(page: Page) { return page.locator("[data-catalog-image]").evaluateAll(elements => elements.map(element => Number((element as HTMLElement).dataset.catalogImage))); }

async function expectPageFitsViewport(page: Page) {
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    page: document.documentElement.scrollWidth,
    headerActions: ["Duplicate", "Archive", "Delete"].map(label => {
      const button = [...document.querySelectorAll("button")].find(element => element.textContent?.trim() === label);
      const bounds = button?.getBoundingClientRect();
      return { label, left: bounds?.left, right: bounds?.right };
    }),
  }));
  expect(layout.page, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewport);
}

async function dragSecondFirst(page: Page, cancel = false) {
  const source = page.getByRole("button", { name: "Drag image 2 to reorder", exact: true });
  await expect(source).toBeEnabled();
  await source.scrollIntoViewIfNeeded();
  const start = await source.boundingBox(), end = await page.getByRole("button", { name: "Drag image 1 to reorder", exact: true }).boundingBox();
  expect(start).not.toBeNull(); expect(end).not.toBeNull();
  await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2); await page.mouse.down();
  await page.mouse.move(end!.x + end!.width / 2, end!.y + end!.height / 2, { steps: 12 });
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
}

test("dragging persists order through refresh and preserves the primary photo", async ({ page }, info) => {
  const state = await setup(page); state.delayOrder = true;
  await dragSecondFirst(page);
  await expect.poll(() => imageOrder(page)).toEqual([2, 1, 3, 4]);
  await expect(page.getByRole("status").filter({ hasText: "Order saved" })).toBeVisible();
  expect(state.orders).toEqual([{ orderedIds: [2, 1, 3, 4], expectedOrderedIds: [1, 2, 3, 4] }]);
  await page.reload();
  await expect.poll(() => imageOrder(page)).toEqual([2, 1, 3, 4]);
  await expect(page.locator('[data-catalog-image="2"]').getByText("Primary", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("catalog-images.png"), fullPage: true });
  await expectPageFitsViewport(page);
  expect(state.errors).toEqual([]);
});

test("catalog controls fit narrow screens without hiding header actions", async ({ page }, info) => {
  const state = await setup(page);
  for (const width of [320, 360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByTestId("btn-back").scrollIntoViewIfNeeded();
    await expectPageFitsViewport(page);
    for (const name of ["Duplicate", "Archive", "Delete"]) {
      await expect(page.getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
    }
    await expect(page.getByRole("button", { name: "Download image 1", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`catalog-images-${width}px.png`), fullPage: true });
  }
  expect(state.errors).toEqual([]);
});

test("keyboard movement and buttons work without a drag; Escape cancels a drag", async ({ page }) => {
  const state = await setup(page);
  await dragSecondFirst(page, true);
  expect(state.orders).toHaveLength(0); expect(await imageOrder(page)).toEqual([1, 2, 3, 4]);
  await page.getByRole("button", { name: "Drag image 2 to reorder", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("status").filter({ hasText: "Order saved" })).toBeVisible();
  await page.getByRole("button", { name: "Move image 1 later", exact: true }).click();
  await expect.poll(() => state.orders.length).toBe(2);
  await expect.poll(() => imageOrder(page)).toEqual([1, 2, 3, 4]);
  expect(state.errors).toEqual([]);
});

test("failed saves restore the gallery and leave controls usable", async ({ page }) => {
  const state = await setup(page); state.rejectOrder = true;
  await dragSecondFirst(page);
  await expect(page.getByText("Could not save image order", { exact: true })).toBeVisible();
  await expect.poll(() => imageOrder(page)).toEqual([1, 2, 3, 4]);
  await expect(page.getByRole("button", { name: "Move image 1 later", exact: true })).toBeEnabled();
  expect(state.assets.find(asset => asset.isPrimary === 1)?.id).toBe(2);
  expect(state.errors).toEqual([]);
});

test("touch dragging reorders photos using the grip", async ({ page }) => {
  const state = await setup(page);
  const source = page.getByRole("button", { name: "Drag image 2 to reorder", exact: true });
  await expect(source).toBeEnabled();
  await source.scrollIntoViewIfNeeded();
  const start = (await source.boundingBox())!, end = (await page.getByRole("button", { name: "Drag image 1 to reorder", exact: true }).boundingBox())!;
  const session = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => [{ x, y, radiusX: 5, radiusY: 5, force: 1, id: 1 }];
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(start.x + 18, start.y + 18) });
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point((start.x + end.x) / 2 + 18, end.y + 18) });
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(end.x + 18, end.y + 18) });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => imageOrder(page)).toEqual([2, 1, 3, 4]);
  await expect(page.getByRole("status").filter({ hasText: "Order saved" })).toBeVisible();
  expect(state.orders).toHaveLength(1); expect(state.errors).toEqual([]);
  await session.detach();
});

test("downloads URL and uploaded photos with original bytes and filenames", async ({ page }) => {
  const state = await setup(page);
  for (const id of [1, 4]) {
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: `Download image ${id}`, exact: true }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe(`ESS-TOP-55PT-image-${id}.png`);
    expect(await readFile((await download.path())!)).toEqual(photoBytes);
  }
  expect(state.downloads).toEqual([1, 4]); expect(state.orders).toHaveLength(0); expect(state.errors).toEqual([]);
});

test("a failed download shows the source error and supports retry", async ({ page }) => {
  const state = await setup(page); state.rejectDownload = true;
  await page.getByRole("button", { name: "Download image 1", exact: true }).click();
  await expect(page.getByText("Could not connect to the image source. Try again.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download image 1", exact: true })).toBeEnabled();
  state.rejectDownload = false;
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download image 1", exact: true }).click();
  expect((await pending).suggestedFilename()).toBe("ESS-TOP-55PT-image-1.png");
  expect(state.errors).toEqual([]);
});

test("view-only users can download photos but cannot change the gallery", async ({ page }) => {
  const state = await setup(page, false);
  await expect(page.getByRole("button", { name: "Drag image 2 to reorder", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Move image 1 later", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Set image 1 as primary", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Remove image 1", exact: true })).toBeDisabled();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download image 1", exact: true }).click();
  expect((await pending).suggestedFilename()).toBe("ESS-TOP-55PT-image-1.png");
  expect(state.orders).toHaveLength(0); expect(state.errors).toEqual([]);
});

test("shows existing variant scope, shares a photo, and saves an exact variant without changing other photos", async ({ page }, info) => {
  const state = await setup(page);
  await expect(page.getByRole("combobox",{ name:"Applies to image 1",exact:true })).toHaveValue("10");
  await expect(page.locator('[data-catalog-image="1"]').getByText("Pack of 50 · ESS-TOP-55PT-SLV-CLR-P50",{ exact:true })).toBeVisible();
  await expect(page.getByRole("combobox",{ name:"Applies to image 2",exact:true })).toHaveValue("all");
  await page.getByRole("combobox",{ name:"Applies to image 1",exact:true }).selectOption("all");
  await expect.poll(() => state.scopeCalls.length).toBe(1);
  await expect(page.getByRole("combobox",{ name:"Applies to image 1",exact:true })).toHaveValue("all");
  expect(state.scopeCalls[0].command).toEqual({ productVariantId:null,expectedProductVariantId:10 });
  await page.getByRole("combobox",{ name:"Applies to image 2",exact:true }).selectOption("11");
  await expect.poll(() => state.scopeCalls.length).toBe(2);
  await expect(page.getByRole("combobox",{ name:"Applies to image 2",exact:true })).toHaveValue("11");
  expect(state.scopeCalls[1].command).toEqual({ productVariantId:11,expectedProductVariantId:null });
  expect(state.scopeCalls[0].key).not.toBe(state.scopeCalls[1].key);
  await page.reload();
  await expect(page.getByRole("combobox",{ name:"Applies to image 1",exact:true })).toHaveValue("all");
  await expect(page.getByRole("combobox",{ name:"Applies to image 2",exact:true })).toHaveValue("11");
  expect(state.assets.find(asset => asset.isPrimary === 1)?.id).toBe(2);
  expect(state.assets.find(asset => asset.id === 3)?.productVariantId).toBe(null);
  expect(await imageOrder(page)).toEqual([1,2,3,4]);
  await page.screenshot({ path:info.outputPath("photo-sharing-controls.png"),fullPage:true });
  await expectPageFitsViewport(page);
  expect(state.errors).toEqual([]);
});

test("a stale assignment refreshes the current scope and permits a new deliberate edit", async ({ page }) => {
  const state = await setup(page); state.rejectScope = true;
  const control = page.getByRole("combobox",{ name:"Applies to image 1",exact:true });
  await control.selectOption("all");
  await expect(page.getByRole("alert").filter({ hasText:"assignment changed" })).toBeVisible();
  await expect(control).toHaveValue("11"); await expect(control).toBeEnabled();
  await control.selectOption("all");
  await expect.poll(() => state.scopeCalls.length).toBe(2);
  expect(state.scopeCalls[1].command).toEqual({ productVariantId:null,expectedProductVariantId:11 });
  expect(state.scopeCalls[1].key).not.toBe(state.scopeCalls[0].key);
  await expect(control).toHaveValue("all");
  expect(state.errors).toEqual([]);
});

test("a lost committed response reuses the same key and preserves a later editor's assignment", async ({ page }) => {
  const state = await setup(page); state.loseScopeResponse = true; state.editAfterCommit = true;
  const control = page.getByRole("combobox",{ name:"Applies to image 1",exact:true });
  await control.selectOption("all");
  await expect(page.getByRole("button",{ name:"Retry assignment",exact:true })).toBeEnabled();
  await expect(control).toHaveValue("11"); await expect(control).toBeDisabled();
  await page.getByRole("button",{ name:"Retry assignment",exact:true }).click();
  await expect.poll(() => state.scopeCalls.length).toBe(2);
  expect(state.scopeCalls[1]).toEqual(state.scopeCalls[0]);
  expect(state.scopeWrites).toBe(1);
  await expect(control).toBeEnabled(); await expect(control).toHaveValue("11");
  await expect(page.getByRole("button",{ name:"Retry assignment",exact:true })).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test("view-only users see exact photo scope but cannot change it", async ({ page }) => {
  const state = await setup(page,false);
  await expect(page.getByRole("combobox",{ name:"Applies to image 1",exact:true })).toHaveValue("10");
  await expect(page.getByRole("combobox",{ name:"Applies to image 1",exact:true })).toBeDisabled();
  await expect(page.getByRole("combobox",{ name:"Applies to image 2",exact:true })).toHaveValue("all");
  expect(state.scopeCalls).toEqual([]); expect(state.errors).toEqual([]);
});
