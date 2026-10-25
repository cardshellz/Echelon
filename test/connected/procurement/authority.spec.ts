import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect, login, prepareCaseReceipt, type Backend, type ConnectedActor, type ConnectedState } from "./fixtures";

interface EntryAttempt { body: string | null; key: string | undefined }

function actor(backend: Backend, id: string): ConnectedActor {
  const selected = backend.actors.find(candidate => candidate.id === id);
  if (!selected) throw new Error("Connected fixture actor is missing: " + id);
  return selected;
}
function receiptUrl(backend: Backend): string {
  return backend.url + "/receiving?open=" + backend.receivingOrderId;
}
function retryButton(page: Page): Locator {
  return page.getByRole("button", { name: "Retry saved receiving entry", exact: true }).filter({ visible: true });
}
async function savedIntent(page: Page, actorId: string): Promise<string | null> {
  return page.evaluate(key => window.sessionStorage.getItem(key), "echelon:receiving-entry:v1:" + encodeURIComponent(actorId));
}
function businessEvidence(state: ConnectedState) {
  return { authority: state.authority, receiptStatus: state.receiptStatus, receiptNotes: state.receiptNotes, lines: state.lines,
    entryAudits: state.entryAudits, receiptTransactions: state.receiptTransactions,
    stockReceivedBasePieces: state.stockReceivedBasePieces, quantityReceiptCommands: state.quantityReceiptCommands,
    quantityReceiptEntries: state.quantityReceiptEntries, onHandBasePieces: state.onHandBasePieces };
}
async function attachState(info: TestInfo, name: string, backend: Backend): Promise<void> {
  await info.attach(name, { body: JSON.stringify(await backend.state(), null, 2), contentType: "application/json" });
}
async function switchActor(page: Page, backend: Backend, next: ConnectedActor): Promise<void> {
  const logout = await page.request.post(backend.url + "/api/auth/logout");
  expect(logout.ok(), await logout.text()).toBe(true);
  await login(page, backend, next);
}
async function addCaseLine(page: Page, backend: Backend): Promise<void> {
  await prepareCaseReceipt(page, backend);
  await page.getByTestId("btn-confirm-add-line").click();
  await expect(page.getByRole("dialog", { name: "Add Line", exact: true })).toBeHidden();
  await expect.poll(async () => (await backend.state()).entryAudits).toBe(1);
}
async function commitAndLoseResponse(page: Page, backend: Backend): Promise<EntryAttempt[]> {
  const attempts: EntryAttempt[] = [];
  let loseResponse = true;
  await page.route("**/api/receiving/*/lines", async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    attempts.push({ body: route.request().postData(), key: route.request().headers()["idempotency-key"] });
    if (!loseResponse) { await route.continue(); return; }
    loseResponse = false;
    const response = await route.fetch({ maxRetries: 0 });
    expect(response.status(), await response.text()).toBe(201);
    await route.abort("connectionreset");
  });
  await prepareCaseReceipt(page, backend);
  await page.getByTestId("btn-confirm-add-line").click();
  await expect(retryButton(page)).toBeEnabled();
  await expect.poll(async () => (await backend.state()).entryAudits).toBe(1);
  return attempts;
}

// These are ordinary assertions, including the candidate UI mismatches. A test
// that reproduces a defect must fail; existing behavior is not its own contract.
test("view-only lead cannot change receiving records through direct authenticated requests", async ({ page, backend }, info) => {
  await login(page, backend, actor(backend, "connected-receiver"));
  await addCaseLine(page, backend);
  const original = businessEvidence(await backend.state());
  await switchActor(page, backend, actor(backend, "connected-viewer"));
  const detail = await page.request.get(backend.url + "/api/receiving/" + backend.receivingOrderId);
  expect(detail.status(), await detail.text()).toBe(200);
  const lineId = original.lines[0].id;
  const attempts = [
    { method: "POST", path: "/api/receiving/" + backend.receivingOrderId + "/lines", body: { sku: "P5", expectedQty: 1 } },
    { method: "POST", path: "/api/receiving/" + backend.receivingOrderId + "/open", body: {} },
    { method: "POST", path: "/api/receiving/" + backend.receivingOrderId + "/close", body: {} },
    { method: "PATCH", path: "/api/receiving/lines/" + lineId, body: { receivedQty: 6 } },
    { method: "PATCH", path: "/api/receiving/" + backend.receivingOrderId, body: { notes: "Denied synthetic change" } },
  ];
  for (const [index, attempt] of attempts.entries()) {
    const response = await page.request.fetch(backend.url + attempt.path, { method: attempt.method,
      headers: { "Idempotency-Key": "connected-viewer-denied-" + index }, data: attempt.body });
    expect(response.status(), attempt.path + ": " + await response.text()).toBe(403);
    expect(businessEvidence(await backend.state())).toEqual(original);
  }
  await attachState(info, "view-only-denied-without-business-writes", backend);
});

test("view-only lead sees disabled receive controls on a fresh receipt without pending recovery", async ({ page, backend }, info) => {
  await login(page, backend, actor(backend, "connected-receiver"));
  await addCaseLine(page, backend);
  const original = businessEvidence(await backend.state());
  await switchActor(page, backend, actor(backend, "connected-viewer"));
  await page.goto(receiptUrl(backend));
  await expect(page.getByTestId("btn-add-line")).toBeVisible();
  expect(await savedIntent(page, "connected-viewer")).toBeNull();
  await expect.soft(page.getByTestId("btn-add-line")).toBeDisabled();
  await expect.soft(page.getByTestId("btn-close-receipt")).toBeDisabled();
  await expect.soft(page.getByRole("spinbutton", { name: "Received count for line " + original.lines[0].id, exact: true }).filter({ visible: true })).toBeDisabled();
  expect(businessEvidence(await backend.state())).toEqual(original);
  await attachState(info, "view-only-ui-state", backend);
});

test("view-only lead cannot start, discard or import into an independently created draft", async ({ page, backend }, info) => {
  await login(page, backend, actor(backend, "connected-receiver"));
  await page.goto(backend.url + "/receiving");
  await page.getByTestId("btn-new-receipt").click();
  await page.getByTestId("select-warehouse").click();
  await page.getByRole("option").first().click();
  const created = page.waitForResponse(response => response.request().method() === "POST"
    && response.url() === backend.url + "/api/receiving");
  await page.getByTestId("btn-create-receipt").click();
  const response = await created;
  expect(response.status(), await response.text()).toBe(201);
  const draft = await response.json();
  expect(draft).toMatchObject({ status: "draft", sourceType: "blind" });
  await switchActor(page, backend, actor(backend, "connected-viewer"));
  await page.goto(backend.url + "/receiving?open=" + draft.id);
  await expect(page.getByTestId("btn-open-receipt")).toBeDisabled();
  await expect(page.getByTestId("btn-discard-receipt")).toBeDisabled();
  await expect(page.getByTestId("btn-import-csv")).toBeDisabled();
  await expect(page.getByTestId("btn-add-line")).toBeDisabled();
  const forbidden = await page.request.post(backend.url + "/api/receiving/" + draft.id + "/open");
  expect(forbidden.status(), await forbidden.text()).toBe(403);
  const unchanged = await page.request.get(backend.url + "/api/receiving/" + draft.id);
  expect(unchanged.ok(), await unchanged.text()).toBe(true);
  expect(await unchanged.json()).toMatchObject({ id: draft.id, status: "draft", lines: [] });
  await attachState(info, "view-only-draft-denied", backend);
});

test("a non-lead receiver with identical grants can reach the same receipt as the authorized API", async ({ page, backend }, info) => {
  const receiver = actor(backend, "connected-picker");
  await login(page, backend, receiver);
  const identityResponse = await page.request.get(backend.url + "/api/auth/me");
  expect(identityResponse.ok(), await identityResponse.text()).toBe(true);
  const identity = await identityResponse.json();
  expect(identity).toMatchObject({ user: { id: receiver.id, role: "picker" } });
  expect(identity.permissions).toEqual(expect.arrayContaining(["inventory:adjust", "inventory:view", "purchasing:view"]));
  const apiReceipt = await page.request.get(backend.url + "/api/receiving/" + backend.receivingOrderId);
  expect(apiReceipt.status(), await apiReceipt.text()).toBe(200);
  const added = await page.request.post(backend.url + "/api/receiving/" + backend.receivingOrderId + "/lines", {
    headers: { "Idempotency-Key": "connected-picker-authorized-entry" },
    data: { sku: "P5", productName: "Connected five-piece case", expectedQty: 5, receivedQty: 5,
      productVariantId: 101, productId: 20, expectedUnitsPerVariant: 5, putawayLocationId: 100 },
  });
  expect(added.status(), await added.text()).toBe(201);
  expect(await backend.state()).toMatchObject({ entryAudits: 1, receiptTransactions: 0,
    lines: [{ receivedQty: 5, unitsPerVariantSnapshot: 5 }] });
  await page.goto(receiptUrl(backend));
  await attachState(info, "granted-picker-api-proof", backend);
  await expect(page).toHaveURL(receiptUrl(backend));
  await expect(page.getByTestId("btn-add-line")).toBeEnabled();
  if ((page.viewportSize()?.width ?? 1280) < 768) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(page.getByRole("link", { name: "Receiving", exact: true })).toBeVisible();
  // Receiving access must not expose unrelated links inherited from the
  // Procurement group's legacy lead/admin role restriction.
  await expect(page.getByRole("link", { name: "Demand Planner", exact: true })).toHaveCount(0);
});

test("revocation after a committed lost response retains intent and restoration replays exactly once", async ({ page, backend }, info) => {
  const receiver = actor(backend, "connected-receiver");
  await login(page, backend, receiver);
  const attempts = await commitAndLoseResponse(page, backend);
  const intent = await savedIntent(page, receiver.id);
  expect(intent).not.toBeNull();
  const committed = businessEvidence(await backend.state());
  await backend.control("receiving-grant", { actorId: receiver.id, allowed: false });
  // The mounted page deliberately still has its earlier grant snapshot. The
  // real server must reject it before it exposes a previous successful result.
  const denied = page.waitForResponse(response => response.request().method() === "POST"
    && response.url().endsWith("/api/receiving/" + backend.receivingOrderId + "/lines"));
  await retryButton(page).click();
  expect((await denied).status()).toBe(403);
  await expect(retryButton(page)).toBeEnabled();
  expect(await savedIntent(page, receiver.id)).toBe(intent);
  expect(businessEvidence(await backend.state())).toEqual(committed);
  await page.reload();
  await expect(retryButton(page)).toBeDisabled();
  expect(attempts).toHaveLength(2);
  expect(await savedIntent(page, receiver.id)).toBe(intent);
  await backend.control("receiving-grant", { actorId: receiver.id, allowed: true });
  await page.reload();
  await expect(retryButton(page)).toBeEnabled();
  await retryButton(page).click();
  await expect(retryButton(page)).toHaveCount(0);
  await expect.poll(() => savedIntent(page, receiver.id)).toBeNull();
  expect(attempts).toHaveLength(3);
  expect(attempts.every(attempt => attempt.key === attempts[0].key && attempt.body === attempts[0].body)).toBe(true);
  expect(businessEvidence(await backend.state())).toEqual(committed);
  await attachState(info, "revoked-and-restored-single-commit", backend);
});

test("expired persisted session preserves committed entry intent through real login and replay", async ({ page, backend }, info) => {
  const receiver = actor(backend, "connected-receiver");
  await login(page, backend, receiver);
  const attempts = await commitAndLoseResponse(page, backend);
  const intent = await savedIntent(page, receiver.id);
  expect(intent).not.toBeNull();
  const committed = businessEvidence(await backend.state());
  await backend.control("expire-sessions", {});
  const expired = page.waitForResponse(response => response.request().method() === "POST"
    && response.url().endsWith("/api/receiving/" + backend.receivingOrderId + "/lines"));
  await retryButton(page).click();
  expect((await expired).status()).toBe(401);
  await expect(retryButton(page)).toBeEnabled();
  expect(await savedIntent(page, receiver.id)).toBe(intent);
  await page.reload();
  await expect(page).toHaveURL(backend.url + "/login");
  expect(await savedIntent(page, receiver.id)).toBe(intent);
  await login(page, backend, receiver);
  await page.goto(receiptUrl(backend));
  await expect(retryButton(page)).toBeEnabled();
  await retryButton(page).click();
  await expect(retryButton(page)).toHaveCount(0);
  await expect.poll(() => savedIntent(page, receiver.id)).toBeNull();
  expect(attempts).toHaveLength(3);
  expect(attempts.every(attempt => attempt.key === attempts[0].key && attempt.body === attempts[0].body)).toBe(true);
  expect(businessEvidence(await backend.state())).toEqual(committed);
  await attachState(info, "expired-session-single-commit", backend);
});

test("another authenticated receiver cannot consume the original operator's pending intent", async ({ page, backend }, info) => {
  const originalActor = actor(backend, "connected-receiver");
  await login(page, backend, originalActor);
  const attempts = await commitAndLoseResponse(page, backend);
  const intent = await savedIntent(page, originalActor.id);
  expect(intent).not.toBeNull();
  const committed = businessEvidence(await backend.state());
  await switchActor(page, backend, actor(backend, "connected-second-receiver"));
  await page.goto(receiptUrl(backend));
  await expect(page.getByTestId("btn-add-line")).toBeEnabled();
  await expect(retryButton(page)).toHaveCount(0);
  expect(await savedIntent(page, originalActor.id)).toBe(intent);
  expect(await savedIntent(page, "connected-second-receiver")).toBeNull();
  expect(attempts).toHaveLength(1);
  // A copied request key must not let the second actor recover or duplicate the
  // first actor's entry even when both hold the same current grant.
  const copied = await page.request.post(backend.url + "/api/receiving/" + backend.receivingOrderId + "/lines", {
    headers: { "Idempotency-Key": attempts[0].key!, "Content-Type": "application/json" }, data: attempts[0].body!,
  });
  expect(copied.status(), await copied.text()).toBe(422);
  expect(await copied.json()).toMatchObject({ code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" });
  expect(businessEvidence(await backend.state())).toEqual(committed);
  await switchActor(page, backend, originalActor);
  await page.goto(receiptUrl(backend));
  await expect(retryButton(page)).toBeEnabled();
  await retryButton(page).click();
  await expect(retryButton(page)).toHaveCount(0);
  await expect.poll(() => savedIntent(page, originalActor.id)).toBeNull();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(businessEvidence(await backend.state())).toEqual(committed);
  await attachState(info, "actor-isolation-single-commit", backend);
});

test("receiving adjustment does not grant vendor or catalog creation", async ({ page, backend }, info) => {
  await login(page, backend, actor(backend, "connected-receiver"));
  await page.goto(backend.url + "/receiving");
  const vendorsBefore = await page.request.get(backend.url + "/api/vendors");
  expect(vendorsBefore.ok(), await vendorsBefore.text()).toBe(true);
  const originalVendors = await vendorsBefore.json();
  const deniedVendor = await page.request.post(backend.url + "/api/vendors", {
    data: { code: "CONNECTED-DENIED", name: "Must not be created" },
  });
  expect(deniedVendor.status(), await deniedVendor.text()).toBe(403);
  await expect.soft(page.getByTestId("btn-new-vendor")).toBeDisabled();
  const vendorsAfter = await page.request.get(backend.url + "/api/vendors");
  expect(vendorsAfter.ok(), await vendorsAfter.text()).toBe(true);
  expect(await vendorsAfter.json()).toEqual(originalVendors);

  // A receiving operator may record unresolved goods. Creating a catalog
  // variant for those goods is a separate inventory:create permission.
  const entered = await page.request.post(backend.url + "/api/receiving/" + backend.receivingOrderId + "/lines", {
    headers: { "Idempotency-Key": "connected-unresolved-catalog-line" },
    data: { sku: "CONNECTED-UNKNOWN-C5", productName: "Unresolved synthetic case", expectedQty: 1,
      receivedQty: 0, productVariantId: null, productId: null, putawayLocationId: 100 },
  });
  expect(entered.status(), await entered.text()).toBe(201);
  const original = businessEvidence(await backend.state());
  const lineId = original.lines[0].id;
  const variantsBefore = await page.request.get(backend.url + "/api/product-variants");
  expect(variantsBefore.ok(), await variantsBefore.text()).toBe(true);
  const originalVariants = await variantsBefore.json();
  const deniedCatalog = await page.request.post(backend.url + "/api/receiving/lines/" + lineId + "/create-variant");
  expect(deniedCatalog.status(), await deniedCatalog.text()).toBe(403);
  await page.goto(receiptUrl(backend));
  const resolveSku = page.getByRole("button", { name: /^SKU(?: not linked)?$/, exact: true }).filter({ visible: true });
  await expect(resolveSku).toBeVisible();
  await resolveSku.click();
  await expect.soft(page.getByRole("button", { name: "Create catalog variant", exact: true })).toBeDisabled();
  const variantsAfter = await page.request.get(backend.url + "/api/product-variants");
  expect(variantsAfter.ok(), await variantsAfter.text()).toBe(true);
  expect(await variantsAfter.json()).toEqual(originalVariants);
  expect(businessEvidence(await backend.state())).toEqual(original);
  await attachState(info, "separate-creation-permissions-denied", backend);
});
