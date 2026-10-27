import { test, expect, login, prepareCaseReceipt } from "./fixtures";

test("committed case receipt survives lost response, reload, retry and close without duplicate stock", async ({ page, backend }, info) => {
  const pageErrors: string[] = [];
  const serverFailures: Array<Promise<string>> = [];
  page.on("response", response => {
    if (response.status() >= 500) serverFailures.push(response.text().then(body => response.status() + " " + new URL(response.url()).pathname + " " + body));
  });
  page.on("pageerror", error => pageErrors.push(error.message));
  await login(page, backend);
  const initial = await backend.state();
  expect(initial).toMatchObject({ authority: "canonical", receiptStatus: "open", lines: [],
    onHandBasePieces: 100, entryAudits: 0, receiptTransactions: 0, quantityReceiptCommands: 0 });
  await prepareCaseReceipt(page, backend);
  const attempts: Array<{ body: string | null; key: string | undefined }> = [];
  let loseFirstResponse = true;
  await page.route("**/api/receiving/*/lines", async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    attempts.push({ body: route.request().postData(), key: route.request().headers()["idempotency-key"] });
    if (!loseFirstResponse) { await route.continue(); return; }
    loseFirstResponse = false;
    // The actual application commits before the response is deliberately lost.
    const response = await route.fetch({ maxRetries: 0 });
    expect(response.status(), await response.text()).toBe(201);
    await route.abort("connectionreset");
  });
  await page.getByTestId("btn-confirm-add-line").click();
  const retry = page.getByRole("button", { name: "Retry saved receiving entry", exact: true }).filter({ visible: true });
  await expect(retry).toBeEnabled();
  await expect.poll(async () => (await backend.state()).entryAudits).toBe(1);
  expect(await backend.state()).toMatchObject({ receiptStatus: "open", entryAudits: 1, receiptTransactions: 0, onHandBasePieces: 100,
    lines: [{ receivedQty: 5, unitsPerVariantSnapshot: 5, putawayLocationId: 100 }] });
  await page.reload();
  await expect(retry).toBeEnabled();
  await expect(page.getByTestId("btn-close-receipt")).toBeDisabled();
  await retry.click();
  await expect(retry).toHaveCount(0);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[0].key).toBeTruthy();
  await expect(page.getByTestId("btn-close-receipt")).toBeEnabled();
  await page.getByTestId("btn-close-receipt").click();
  await expect.poll(async () => (await backend.state()).receiptStatus).toBe("closed");
  const final = await backend.state();
  expect(final).toMatchObject({ entryAudits: 1, receiptTransactions: 1, stockReceivedBasePieces: 25,
    onHandBasePieces: 125, quantityReceiptCommands: 1 });
  expect(final.quantityReceiptEntries).toBeGreaterThan(0);
  const saved = attempts[0];
  const replay = await page.request.post(backend.url + "/api/receiving/" + backend.receivingOrderId + "/lines", {
    headers: { "Idempotency-Key": saved.key!, "Content-Type": "application/json" }, data: saved.body!,
  });
  expect(replay.status(), await replay.text()).toBe(201);
  const closeReplay = await page.request.post(backend.url + "/api/receiving/" + backend.receivingOrderId + "/close", {
    headers: { "Idempotency-Key": "connected-close-replay" }, data: {},
  });
  expect(closeReplay.ok(), await closeReplay.text()).toBe(true);
  const repeated = await backend.state();
  expect(repeated).toMatchObject({ lines: final.lines, entryAudits: 1, receiptTransactions: 1, stockReceivedBasePieces: 25,
    onHandBasePieces: 125, quantityReceiptCommands: 1, quantityReceiptEntries: final.quantityReceiptEntries });
  expect(pageErrors).toEqual([]);
  expect(await Promise.all(serverFailures)).toEqual([]);
  await info.attach("database-evidence", { body: JSON.stringify({ initial, final, repeated }, null, 2), contentType: "application/json" });
});



test("lost finalization response retries against the committed receipt without a second stock posting", async ({ page, backend }, info) => {
  await login(page, backend);
  await prepareCaseReceipt(page, backend);
  await page.getByTestId("btn-confirm-add-line").click();
  await expect(page.getByRole("dialog", { name: "Add Line", exact: true })).toBeHidden();
  const closeAttempts: string[] = [];
  let loseFirst = true;
  await page.route("**/api/receiving/*/close", async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    closeAttempts.push(route.request().headers()["idempotency-key"]);
    if (!loseFirst) { await route.continue(); return; }
    loseFirst = false;
    const response = await route.fetch({ maxRetries: 0 });
    expect(response.ok(), await response.text()).toBe(true);
    await route.abort("connectionreset");
  });
  await page.getByTestId("btn-close-receipt").click();
  await expect.poll(async () => (await backend.state()).receiptStatus).toBe("closed");
  const committed = await backend.state();
  expect(committed).toMatchObject({ entryAudits: 1, receiptTransactions: 1, stockReceivedBasePieces: 25,
    onHandBasePieces: 125, quantityReceiptCommands: 1 });
  await expect(page.getByTestId("btn-close-receipt")).toBeEnabled();
  await page.getByTestId("btn-close-receipt").click();
  await expect(page.getByTestId("btn-close-receipt")).toBeHidden();
  expect(closeAttempts).toHaveLength(2);
  expect(closeAttempts[1]).not.toBe(closeAttempts[0]);
  await page.goto(backend.url + "/receiving?open=" + backend.receivingOrderId);
  await expect(page.getByRole("heading", { name: /Receipt CONNECTED-RECEIPT/ })).toBeVisible();
  await expect(page.getByTestId("btn-close-receipt")).toHaveCount(0);
  expect(await backend.state()).toMatchObject({ lines: committed.lines, entryAudits: 1,
    receiptTransactions: 1, stockReceivedBasePieces: 25, onHandBasePieces: 125,
    quantityReceiptCommands: 1, quantityReceiptEntries: committed.quantityReceiptEntries });
  await info.attach("finalization-replay-database-evidence", {
    body: JSON.stringify({ committed, replayed: await backend.state() }, null, 2), contentType: "application/json",
  });
});
