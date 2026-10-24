import { expect, test, type Page } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";

const REVIEWED_AT = "2026-10-23T12:00:00.000Z";
const SAVED_AT = "2026-10-23T12:01:00.000Z";
const LINES_FINGERPRINT = "a".repeat(64);
type Mode = "success" | "lost" | "malformed" | "stale" | "delayed";
async function setup(page: Page, mode: Mode) {
  const failures = await installFixtures(page);
  const purchases = new Map([17, 99].map(id => [id, { ...po(id), status: "pending_approval", physicalStatus: "draft", updatedAt: REVIEWED_AT, approvalLinesFingerprint: LINES_FINGERPRINT }]));
  const commands: Array<{ id: number; key: string | undefined; body: Record<string, unknown> }> = [];
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const state = { actor: "test-user", allowed: true, offline: false, detailFailure: 0, postings: 0 };
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: state.actor, username: state.actor, role: "admin" }, roles: ["admin"], permissions: state.allowed ? ["purchasing:approve"] : [] } });
    const match = /^\/api\/purchase-orders\/(17|99)(\/approve|\/workspace)?$/.exec(path);
    if (!match) return route.fallback();
    const id = Number(match[1]), purchase = purchases.get(id)!;
    if (request.method() === "GET" && match[2] === "/workspace") return route.fulfill({ json: {
      purchase: { ...purchase, currency: "USD", vendorName: "Test vendor", invoicedTotalCents: 0, paidTotalCents: 0, outstandingCents: 0, expectedDeliveryDate: null, confirmedDeliveryDate: null, actualDeliveryDate: null },
      shipments: [], receipts: [], invoices: [], edges: [], limitations: [],
    } });
    if (request.method() === "GET" && !match[2]) return route.fulfill(state.detailFailure ? { status: state.detailFailure, json: { error: "Purchase detail unavailable" } } : { json: purchase });
    if (request.method() !== "POST" || match[2] !== "/approve") return route.fallback();
    const body = request.postDataJSON(), key = request.headers()["idempotency-key"];
    commands.push({ id, key, body });
    if (state.offline) return route.abort("internetdisconnected");
    if (mode === "stale" && commands.length === 1) {
      Object.assign(purchase, { totalCents: 100000, subtotalCents: 100000, updatedAt: SAVED_AT });
      return route.fulfill({ status: 409, json: { error: "Purchase order changed since your review. Reload and review the current terms before approving.", details: { code: "PO_APPROVAL_REVIEW_STALE", purchaseApprovalOutcome: "rejected", idempotencyKey: key } } });
    }
    Object.assign(purchase, { status: "approved", updatedAt: SAVED_AT });
    state.postings++;
    if (mode === "delayed") await gate;
    if (mode === "lost" && commands.length === 1) return route.abort("failed");
    const result = { id, status: "approved", totalCents: body.expectedTotalCents, approvedBy: state.actor, updatedAt: SAVED_AT, reviewedUpdatedAt: body.expectedUpdatedAt, reviewedLinesFingerprint: body.expectedLinesFingerprint, approvalCommand: { name: "procurement.purchase_order.approve", idempotencyKey: key } };
    return route.fulfill({ json: mode === "malformed" && commands.length === 1 ? { ...result, id: 999 } : result });
  });
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(page.getByRole("heading", { name: "TEST-PO-17", exact: true })).toBeVisible();
  return { failures, commands, release, state, setActor: (value: string) => { state.actor = value; } };
}
const approve = (page: Page) => page.getByRole("button", { name: "Approve", exact: true }).first();
async function navigate(page: Page, id: number) {
  await page.evaluate(target => { history.pushState(null, "", `/purchase-orders/${target}?tab=lines`); dispatchEvent(new PopStateEvent("popstate")); }, id);
  await expect(page.getByRole("heading", { name: `TEST-PO-${id}`, exact: true })).toBeVisible();
}

test("approves the displayed version and total with a saved command identity", async ({ page }) => {
  const { commands, failures } = await setup(page, "success");
  await approve(page).click();
  await expect(page.getByText("Purchase approval confirmed", { exact: true })).toBeVisible();
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ id: 17, body: { expectedUpdatedAt: REVIEWED_AT, expectedTotalCents: 10000 } });
  expect(commands[0].key).toBeTruthy();
  expect(failures).toEqual([]);
});

for (const mode of ["lost", "malformed"] as const) {
  test(`${mode} response recovers the original approval after reload even when the PO is now approved`, async ({ page }) => {
    const { commands, failures } = await setup(page, mode);
    await approve(page).click();
    await expect(page.getByText("Purchase approval needs confirmation", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("Purchase approval needs confirmation", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Recover purchase approval", exact: true }).click();
    await expect(page.getByText("Purchase approval confirmed", { exact: true })).toBeVisible();
    await expect(page.getByText("Purchase approval needs confirmation", { exact: true })).toHaveCount(0);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(failures).toEqual([]);
  });
}

test("stale review rejection requires refreshed visible terms and a new intentional approval", async ({ page }) => {
  const { commands, failures } = await setup(page, "stale");
  await approve(page).click();
  await expect(page.getByText("Purchase approval was not confirmed", { exact: true })).toBeVisible();
  await expect(page.getByText("Purchase approval needs confirmation", { exact: true })).toHaveCount(0);
  await expect(page.getByText("$1,000.00", { exact: true }).first()).toBeVisible();
  await approve(page).click();
  await expect(page.getByText("Purchase approval confirmed", { exact: true })).toBeVisible();
  expect(commands[1].body).toEqual({ expectedUpdatedAt: SAVED_AT, expectedTotalCents: 100000, expectedLinesFingerprint: LINES_FINGERPRINT });
  expect(commands[1].key).not.toBe(commands[0].key);
  expect(failures).toEqual([]);
});

test("unresolved approval blocks a different purchase while preserving recovery of the original", async ({ page }) => {
  const { commands, failures } = await setup(page, "lost");
  await approve(page).click();
  await expect(page.getByText("Purchase approval needs confirmation", { exact: true })).toBeVisible();
  await navigate(page, 99);
  await expect(approve(page)).toBeDisabled();
  await expect(page.getByRole("alert").filter({ hasText: "Purchase approval needs confirmation" })).toContainText("purchase #17");
  await page.getByRole("button", { name: "Recover purchase approval", exact: true }).click();
  await expect(approve(page)).toBeEnabled();
  expect(commands.map(command => command.id)).toEqual([17, 17]);
  expect(commands[1]).toEqual(commands[0]);
  expect(failures).toEqual([]);
});

test("late approval result cannot claim success for the newly selected purchase", async ({ page }) => {
  const { commands, failures, release } = await setup(page, "delayed");
  await approve(page).click();
  await expect.poll(() => commands.length).toBe(1);
  await navigate(page, 99);
  const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/purchase-orders/17/approve");
  release(); await (await response).finished();
  await expect(page.getByText("Purchase approval confirmed", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "TEST-PO-99", exact: true })).toBeVisible();
  expect(commands).toHaveLength(1);
  expect(failures).toEqual([]);
});

test("a changed authenticated operator cannot submit the previous operator's recovery", async ({ page }) => {
  const { commands, failures, setActor } = await setup(page, "lost");
  await approve(page).click();
  await expect(page.getByText("Purchase approval needs confirmation", { exact: true })).toBeVisible();
  setActor("other-operator"); await page.reload();
  await expect(page.getByRole("heading", { name: "TEST-PO-17", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Recover purchase approval", exact: true })).toHaveCount(0);
  setActor("test-user"); await page.reload();
  await page.getByRole("button", { name: "Recover purchase approval", exact: true }).click();
  await expect(page.getByText("Purchase approval confirmed", { exact: true })).toBeVisible();
  expect(commands[1]).toEqual(commands[0]);
  expect(failures).toEqual([]);
});

test("offline approval persists immediately and reconnecting never sends it without recovery", async ({ page }) => {
  const { commands, failures, state } = await setup(page, "success");
  state.offline = true; await page.context().setOffline(true);
  await approve(page).click();
  await expect(page.getByRole("button", { name: "Recover purchase approval", exact: true })).toBeEnabled();
  const original = await page.evaluate(() => JSON.parse(sessionStorage.getItem("echelon:purchase-approval:v1:test-user")!));
  expect(original.body).toEqual({ purchaseOrderId: 17, expectedUpdatedAt: REVIEWED_AT, expectedTotalCents: 10000, expectedLinesFingerprint: LINES_FINGERPRINT });
  expect(state.postings).toBe(0);
  state.offline = false; await page.context().setOffline(false); await page.waitForLoadState("networkidle");
  expect(state.postings).toBe(0);
  await page.getByRole("button", { name: "Recover purchase approval", exact: true }).click();
  await expect(page.getByText("Purchase approval confirmed", { exact: true })).toBeVisible();
  expect(commands.at(-1)?.key).toBe(original.key);
  expect(state.postings).toBe(1); expect(failures).toEqual([]);
});

for (const detailFailure of [404, 503]) test(`saved approval can recover while purchase detail returns ${detailFailure}`, async ({ page }) => {
  const { commands, failures, state } = await setup(page, "lost");
  await approve(page).click();
  await expect(page.getByRole("button", { name: "Recover purchase approval", exact: true })).toBeEnabled();
  state.detailFailure = detailFailure; await page.reload();
  await page.getByRole("button", { name: "Recover purchase approval", exact: true }).click();
  await expect(page.getByText("Purchase approval confirmed", { exact: true })).toBeVisible();
  expect(commands[1]).toEqual(commands[0]); expect(failures).toEqual([]);
});

test("revoked approval permission leaves recovery visible and disabled until restored", async ({ page }) => {
  const { commands, failures, state } = await setup(page, "lost");
  await approve(page).click();
  await expect(page.getByRole("button", { name: "Recover purchase approval", exact: true })).toBeEnabled();
  state.allowed = false; await page.reload();
  await expect(page.getByRole("button", { name: "Recover purchase approval", exact: true })).toBeDisabled();
  await expect(page.getByText("Approval permission is required to recover this saved request.", { exact: true })).toBeVisible();
  expect(commands).toHaveLength(1);
  state.allowed = true; await page.reload();
  await page.getByRole("button", { name: "Recover purchase approval", exact: true }).click();
  await expect(page.getByText("Purchase approval confirmed", { exact: true })).toBeVisible();
  expect(commands[1]).toEqual(commands[0]); expect(failures).toEqual([]);
});
