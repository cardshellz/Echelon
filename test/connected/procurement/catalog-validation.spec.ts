import { test, expect, login, type Backend, type ConnectedActor, type ConnectedState } from "./fixtures";

function actor(backend: Backend, id: string): ConnectedActor {
  const selected = backend.actors.find(candidate => candidate.id === id);
  if (!selected) throw new Error("Connected fixture actor is missing: " + id);
  return selected;
}

function businessEvidence(state: ConnectedState) {
  return { authority: state.authority, receiptStatus: state.receiptStatus, receiptNotes: state.receiptNotes,
    lines: state.lines, entryAudits: state.entryAudits, receiptTransactions: state.receiptTransactions,
    stockReceivedBasePieces: state.stockReceivedBasePieces, quantityReceiptCommands: state.quantityReceiptCommands,
    quantityReceiptEntries: state.quantityReceiptEntries, onHandBasePieces: state.onHandBasePieces,
    catalogProducts: state.catalogProducts, catalogVariants: state.catalogVariants };
}

for (const sku of ["ZERO-C0", "TOO-LARGE-C2147483648"]) {
  test("catalog creation rejects invalid case factor before writes: " + sku, async ({ page, backend }, info) => {
    await login(page, backend, actor(backend, "connected-receiver"));
    const entered = await page.request.post(backend.url + "/api/receiving/" + backend.receivingOrderId + "/lines", {
      headers: { "Idempotency-Key": "invalid-catalog-factor-" + sku },
      data: { sku, productName: "Unresolved case factor", expectedQty: 1, receivedQty: 0,
        productVariantId: null, productId: null, putawayLocationId: 100 },
    });
    expect(entered.status(), await entered.text()).toBe(201);
    const logout = await page.request.post(backend.url + "/api/auth/logout");
    expect(logout.ok(), await logout.text()).toBe(true);
    await login(page, backend, actor(backend, "connected-catalog-creator"));
    const original = businessEvidence(await backend.state());
    expect(original.lines).toHaveLength(1);
    const lineId = original.lines[0].id;

    // Exercise the actual authenticated command, including a repeated invalid
    // attempt. A rejected SKU must not leave a parent product behind either.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await page.request.post(backend.url + "/api/receiving/lines/" + lineId + "/create-variant");
      expect.soft(response.status(), await response.text()).toBe(400);
      const after = businessEvidence(await backend.state());
      await info.attach("invalid-factor-attempt-" + attempt, {
        body: JSON.stringify({ status: response.status(), before: original, after }, null, 2), contentType: "application/json",
      });
      expect.soft(after).toEqual(original);
    }
  });
}

test("catalog creation rolls back its parent on variant failure and permits a clean retry", async ({ page, backend }, info) => {
  await login(page, backend, actor(backend, "connected-receiver"));
  const entered = await page.request.post(backend.url + "/api/receiving/" + backend.receivingOrderId + "/lines", {
    headers: { "Idempotency-Key": "catalog-rollback-entry" },
    data: { sku: "ROLLBACK-C7", productName: "Catalog rollback case", expectedQty: 1, receivedQty: 0,
      productVariantId: null, productId: null, putawayLocationId: 100 },
  });
  expect(entered.status(), await entered.text()).toBe(201);
  const logout = await page.request.post(backend.url + "/api/auth/logout");
  expect(logout.ok(), await logout.text()).toBe(true);
  await login(page, backend, actor(backend, "connected-catalog-creator"));
  const original = businessEvidence(await backend.state());
  expect(original.lines).toHaveLength(1);
  const endpoint = backend.url + "/api/receiving/lines/" + original.lines[0].id + "/create-variant";
  await backend.control("catalog-variant-failure", { enabled: true });
  const failed = await page.request.post(endpoint);
  expect(failed.status(), await failed.text()).toBe(500);
  const afterFailure = businessEvidence(await backend.state());
  await info.attach("catalog-write-failure", {
    body: JSON.stringify({ before: original, after: afterFailure }, null, 2), contentType: "application/json",
  });
  expect.soft(afterFailure).toEqual(original);

  await backend.control("catalog-variant-failure", { enabled: false });
  const retried = await page.request.post(endpoint);
  expect(retried.status(), await retried.text()).toBe(200);
  expect(await retried.json()).toMatchObject({ requiresUnitConfirmation: true,
    product: { sku: "ROLLBACK" }, variant: { sku: "ROLLBACK-C7", unitsPerVariant: 7 },
    line: { id: original.lines[0].id, productId: null, productVariantId: null } });
  const committed = businessEvidence(await backend.state());
  expect(committed.catalogProducts).toHaveLength(original.catalogProducts.length + 1);
  expect(committed.catalogVariants).toHaveLength(original.catalogVariants.length + 1);
  const { catalogProducts: _originalProducts, catalogVariants: _originalVariants, ...originalReceipt } = original;
  const { catalogProducts: _newProducts, catalogVariants: _newVariants, ...afterReceipt } = committed;
  expect(afterReceipt).toEqual(originalReceipt);
  const duplicate = await page.request.post(endpoint);
  expect(duplicate.status(), await duplicate.text()).toBe(409);
  expect(businessEvidence(await backend.state())).toEqual(committed);
  await info.attach("catalog-retry-single-create", {
    body: JSON.stringify(committed, null, 2), contentType: "application/json",
  });
});
