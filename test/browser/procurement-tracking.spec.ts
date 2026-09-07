import { expect, test, type Page } from "@playwright/test";
import type { InboundTrackingConfig, InboundTrackingReference, InboundTrackingSnapshot, InboundTrackingView } from "../../shared/procurement/inbound-tracking";
import { installFixtures, po } from "./procurement-fixtures";
const config: InboundTrackingConfig = { identity: { provider: "searates", referenceType: "container", reference: "TEST1234567", carrierCode: "" }, enabled: true, includeVesselPosition: true };
function snapshot(): InboundTrackingSnapshot {
  return { version: 1, provider: "searates", reference: "TEST1234567", status: "IN_TRANSIT", statusSource: "carrier", sourceUpdatedAt: "2026-09-07T10:00:00.000Z", latestActualEventAt: null, fromCache: true, carrierName: "Fictional ocean carrier", arrival: { kind: "port", dateText: "2026-10-01 08:00:00", occurredAt: null, timezone: "America/New_York", location: "Destination port", actual: false }, vesselPosition: { latitude: 0, longitude: -10.5, observedAt: "2026-09-07T09:00:00.000Z", vessel: "Fictional vessel" }, positionStatus: "OK", events: [{ key: "TEST1234567:1", container: "TEST1234567", sequence: 1, description: "Vessel departed", code: "VDL", dateText: "2026-09-01 09:30:00", occurredAt: null, timezone: "Asia/Shanghai", actual: true, location: "Origin port", vessel: "Fictional vessel", voyage: "TEST-01", source: "carrier", mirrored: false }, { key: "TEST1234567:2", container: "TEST1234567", sequence: 2, description: "Vessel arrival", code: "VAD", dateText: "2026-10-01 08:00:00", occurredAt: null, timezone: "America/New_York", actual: false, location: "Destination port", vessel: "Fictional vessel", voyage: "TEST-01", source: "provider_calculated", mirrored: false }] };
}
function reference(): InboundTrackingReference { return { id: 7, revision: 1, config: structuredClone(config), lastAttemptAt: "2026-09-07T12:00:00.000Z", lastSuccessAt: "2026-09-07T11:00:00.000Z", nextPollAt: "2026-09-07T18:00:00.000Z", failureCount: 1, lastErrorCode: "SEARATES_TIMEOUT", lastErrorMessage: "SeaRates tracking request timed out.", leaseUntil: null, reviewRequired: false, current: snapshot() }; }
function view(ready = true): InboundTrackingView { return { pollingEnabled: ready, providers: [{ provider: "searates", configured: ready, setup: "Requires SeaRates subscription and credentials." }, { provider: "shipstation", configured: ready, setup: "Requires ShipStation carrier tracking access." }], references: ready ? [reference()] : [] }; }
async function setup(page: Page, options: { ready?: boolean; canEdit?: boolean } = {}) {
  const failures = await installFixtures(page);
  const data = view(options.ready ?? true);
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: "tracking-operator", username: "test", role: "admin" }, permissions: options.canEdit === false ? ["purchasing:view"] : ["purchasing:view", "purchasing:edit"], roles: ["admin"] } }));
  await page.route("**/api/inbound-shipments/42/tracking", (route) => route.request().method() === "GET" ? route.fulfill({ json: data }) : route.fallback());
  await page.route("**/api/inbound-shipments/42/tracking/7/history**", (route) => route.fulfill({ json: { observations: [{ id: "1", observedAt: "2026-09-07T11:00:00.000Z", snapshot: snapshot() }], attempts: [{ startedAt: "2026-09-07T12:00:00.000Z", completedAt: "2026-09-07T12:00:20.000Z", outcome: "retry", errorCode: "SEARATES_TIMEOUT", message: "SeaRates tracking request timed out." }], changes: [{ revision: 1, actorId: "tracking-operator", recordedAt: "2026-09-07T08:00:00.000Z", before: null, after: config }], nextObservationCursor: null } }));
  return { failures, data };
}
const panel = (page: Page) => page.getByTestId("inbound-shipment-tracking");
test("tracking deep link shows port ETA, actual versus estimated events and retained evidence on desktop and mobile", async ({ page }, testInfo) => {
  const { failures } = await setup(page);
  await page.goto("/shipments/42?tab=tracking");
  await expect(page.getByRole("tab", { name: "Tracking", exact: true })).toHaveAttribute("data-state", "active");
  await expect(panel(page)).toContainText("Destination port arrival");
  await expect(panel(page)).toContainText("Warehouse receiving and putaway determine availability");
  await expect(panel(page)).toContainText("Last refresh attempt");
  await expect(panel(page)).toContainText("Last successful response");
  await expect(panel(page).getByRole("alert")).toContainText("SeaRates tracking request timed out");
  await expect(panel(page).getByRole("list", { name: "Carrier tracking events" })).toContainText("Actual");
  await expect(panel(page).getByRole("list", { name: "Carrier tracking events" })).toContainText("Estimated");
  await expect(panel(page).getByRole("link", { name: "Open reported vessel position on map" })).toHaveAttribute("href", "https://www.openstreetmap.org/?mlat=0&mlon=-10.5#map=5/0/-10.5");
  await panel(page).getByRole("button", { name: "View retained history" }).click();
  await expect(panel(page)).toContainText("Retained observations");
  await panel(page).getByText("Recent refresh attempts (1)", { exact: true }).click();
  await expect(panel(page)).toContainText("retry");
  await page.reload();
  await expect(panel(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("inbound-tracking.png"), fullPage: true });
  expect(failures).toEqual([]);
});
test("unconfigured feeds explain required setup without inventing a status or map", async ({ page }) => {
  const { failures } = await setup(page, { ready: false });
  await page.goto("/shipments/42?tab=tracking");
  await expect(panel(page)).toContainText("Tracking refresh is paused in deployment settings");
  await expect(panel(page)).toContainText("Connect a SeaRates Container Tracking subscription");
  await expect(panel(page)).toContainText("No tracking references linked yet");
  await expect(panel(page).getByRole("link", { name: "Open reported vessel position on map" })).toHaveCount(0);
  expect(failures).toEqual([]);
});
test("a failed save retries the identical request key and only shows saved configuration after confirmation", async ({ page }) => {
  const { data, failures } = await setup(page, { ready: false });
  const writes: Array<{ requestKey: string; config: InboundTrackingConfig }> = [];
  await page.route("**/api/inbound-shipments/42/tracking", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    const body = route.request().postDataJSON(); writes.push(body);
    if (writes.length === 1) return route.fulfill({ status: 503, json: { error: "Response interrupted. Retry the same request key." } });
    data.references = [{ ...reference(), config: body.config, current: null, lastAttemptAt: null, lastSuccessAt: null, lastErrorCode: null, lastErrorMessage: null, failureCount: 0 }];
    return route.fulfill({ json: { referenceId: 7, revision: 1, queued: true } });
  });
  await page.goto("/shipments/42?tab=tracking");
  await panel(page).getByLabel("Tracking reference", { exact: true }).fill("TEST1234567");
  await panel(page).getByRole("button", { name: "Add tracking reference", exact: true }).click();
  await expect(panel(page).getByRole("alert")).toContainText("Response interrupted");
  await panel(page).getByRole("button", { name: "Retry same tracking request" }).click();
  await expect(panel(page)).toContainText("Tracking request saved");
  expect(writes).toHaveLength(2); expect(writes[0]).toEqual(writes[1]);
  await expect(panel(page)).toContainText("No carrier observation received");
  expect(failures).toEqual([]);
});
test("read-only users inspect tracking but cannot configure or request paid provider refreshes", async ({ page }) => {
  const { failures } = await setup(page, { canEdit: false });
  await page.goto("/shipments/42?tab=tracking");
  await expect(panel(page)).toBeVisible();
  for (const name of ["Add tracking reference", "Request refresh", "Pause tracking", "Stop requesting vessel position"]) await expect(panel(page).getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(panel(page).getByRole("button", { name: "View retained history" })).toBeVisible();
  expect(failures).toEqual([]);
});
test("a tracking read failure stays separate from operational shipment details and is retryable", async ({ page }) => {
  const { failures } = await setup(page);
  let fail = true;
  await page.route("**/api/inbound-shipments/42/tracking", (route) => fail ? route.fulfill({ status: 503, json: { error: "Unavailable" } }) : route.fulfill({ json: view() }));
  await page.goto("/shipments/42?tab=tracking");
  await expect(page.getByRole("alert")).toContainText("Shipment tracking could not be loaded");
  fail = false; await page.getByRole("button", { name: "Retry tracking" }).click();
  await expect(panel(page)).toContainText("TEST1234567");
  await page.getByRole("tab", { name: "Lines (1)", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Lines (1)", exact: true })).toHaveAttribute("data-state", "active");
  expect(failures).toEqual([]);
});
test("purchase lifecycle opens carrier tracking inside its selected shipment without losing the purchase", async ({ page }) => {
  const { failures } = await setup(page, { ready: false });
  await page.route("**/api/purchase-orders/17/workspace", (route) => route.fulfill({ json: {
    purchase: { ...po(17), vendorName: "Fixture supplier", currency: "USD", invoicedTotalCents: 0, paidTotalCents: 0, outstandingCents: 10000, expectedDeliveryDate: null, confirmedDeliveryDate: null, actualDeliveryDate: null },
    shipments: [{ id: 42, shipmentNumber: "TEST-SHIP-42", status: "in_transit", mode: "sea_fcl", containerNumber: "TEST1234567", eta: "2026-10-01T12:00:00Z", deliveredDate: null, estimatedTotalCostCents: null, actualTotalCostCents: null, amountScope: "whole_shipment", purchaseOrderIds: [17], unlinkedLineCount: 0, lines: [] }],
    receipts: [], invoices: [], edges: [{ from: { kind: "purchase", id: 17 }, to: { kind: "shipment", id: 42 }, relationship: "purchase_shipment" }], limitations: [],
  } }));
  await page.goto("/purchase-orders/17?tab=lifecycle&inspect=shipment:42");
  const inspector = page.getByTestId("purchase-record-inspector");
  await inspector.getByRole("button", { name: "View carrier tracking", exact: true }).click();
  await expect(inspector.getByTestId("inbound-shipment-tracking")).toBeVisible();
  await expect(inspector).toContainText("Following TEST-PO-17");
  await expect(page).toHaveURL(/\/purchase-orders\/17\?tab=lifecycle&inspect=shipment:42/);
  expect(failures).toEqual([]);
});
