import { expect, test, type Page } from "playwright/test";
import { resolve } from "node:path";
import { DEFAULT_DROPSHIP_COST_CHANGE_POLICY } from "../../shared/dropship/cost-change-policy";

const POLICY_URL = "/api/dropship/admin/cost-changes/policy";
const DETECTION_URL = "/api/dropship/admin/cost-changes/detection";
const LOG_URL = "/api/dropship/admin/cost-changes/log";
const defaults = { ...DEFAULT_DROPSHIP_COST_CHANGE_POLICY };
const noneLive = { detection: false, priceProtection: false, vendorNotices: false, listingActions: false };

interface DetectionState {
  passNumber: number;
  passStartedAt: string | null;
  passCompletedAt: string | null;
  cursorVendorId: number | null;
  policyId: number | null;
  passVendorsProcessed: number;
  passVariantsRead: number;
  passUnavailableReadings: number;
  passChangesRecorded: number;
  lastTickAt: string | null;
}

interface PendingChange {
  entryId: number;
  vendorId: number;
  vendorBusinessName: string | null;
  productVariantId: number;
  variantSku: string | null;
  variantName: string;
  productName: string;
  policyId: number | null;
  costSource: "variant_fixed_price" | "variant_percent" | "plan_percent" | "retail";
  effectiveAt: string;
  observedAt: string;
  kind: "baseline" | "increase" | "decrease";
  fromCents: number | null;
  unitCostCents: number;
}

interface LogRow extends Omit<PendingChange, "kind" | "fromCents" | "unitCostCents"> {
  logId: number;
  eventType: "baseline" | "increase_announced" | "increase_applied" | "decrease_announced" | "decrease_applied" | "increase_reduced" | "change_withdrawn";
  fromCents: number | null;
  toCents: number | null;
  retailDriven: boolean;
  createdAt: string;
}

const idleDetection: DetectionState = {
  passNumber: 0, passStartedAt: null, passCompletedAt: null, cursorVendorId: null, policyId: null,
  passVendorsProcessed: 0, passVariantsRead: 0, passUnavailableReadings: 0, passChangesRecorded: 0, lastTickAt: null,
};

interface VersionRecord {
  policyId: number;
  version: number;
  settings: typeof defaults;
  isActive: boolean;
  changeNote: string;
  createdAt: string;
  createdBy: { actorType: "admin" | "system"; actorId: string | null };
  deactivatedAt: string | null;
}

const seed: VersionRecord = {
  policyId: 1,
  version: 1,
  settings: defaults,
  isActive: true,
  changeNote: "Initial defaults from migration 0710. Confirm or change them in Dropship, Cost changes.",
  createdAt: "2026-09-27T10:00:00.000Z",
  createdBy: { actorType: "system", actorId: "migration:0710" },
  deactivatedAt: null,
};

interface PostedBody {
  settings: typeof defaults;
  changeNote: string;
  idempotencyKey: string;
}

/**
 * A fake of the admin route with the server's replay rule: a key seen before
 * with the same body answers the stored version (200, idempotentReplay), and
 * a new key publishes the next version (201). `respond` can override one POST.
 */
async function mount(page: Page, options: {
  canEdit?: boolean;
  versions?: VersionRecord[];
  enforcement?: typeof noneLive;
  detection?: { workerEnabled: boolean; state: DetectionState; pending: PendingChange[] };
  log?: LogRow[];
} = {}) {
  const state = {
    versions: [...(options.versions ?? [seed])],
    posts: [] as PostedBody[],
    reads: 0,
    logReads: [] as string[],
    respond: [] as Array<"lost" | "conflict">,
    /** Holds each POST open this long, so a second click lands while the first is in flight. */
    postDelayMs: 0,
    keys: new Map<string, VersionRecord>(),
    unexpected: [] as string[],
    pageErrors: [] as string[],
  };
  const detection = options.detection ?? { workerEnabled: true, state: idleDetection, pending: [] };
  const log = [...(options.log ?? [])].sort((a, b) => b.logId - a.logId);
  page.on("pageerror", (error) => state.pageErrors.push(error.message));
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "GET" && path === DETECTION_URL) {
      return route.fulfill({ json: { ...detection, pendingLimit: 200, generatedAt: "2026-09-28T09:00:00.000Z" } });
    }
    if (request.method() === "GET" && path === LOG_URL) {
      // The server's paging rule: `limit` rows before `beforeId`, and a cursor when more remain.
      state.logReads.push(url.search);
      const limit = Number(url.searchParams.get("limit"));
      const beforeId = url.searchParams.get("beforeId");
      const rows = log.filter((row) => beforeId === null || row.logId < Number(beforeId));
      const items = rows.slice(0, limit);
      return route.fulfill({ json: {
        items,
        nextBeforeId: rows.length > limit ? items[items.length - 1]!.logId : null,
        generatedAt: "2026-09-28T09:00:00.000Z",
      } });
    }
    if (path !== POLICY_URL) {
      state.unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 500, json: {} });
    }
    if (request.method() === "GET") {
      state.reads += 1;
      const active = state.versions.find((version) => version.isActive) ?? null;
      return route.fulfill({
        json: {
          policy: active,
          settings: active?.settings ?? defaults,
          settingsSource: active ? "policy" : "defaults",
          defaults,
          versions: [...state.versions].sort((a, b) => b.version - a.version),
          enforcement: options.enforcement ?? noneLive,
          generatedAt: "2026-09-28T09:00:00.000Z",
        },
      });
    }
    const body = request.postDataJSON() as PostedBody;
    state.posts.push(body);
    if (state.postDelayMs > 0) await new Promise((done) => setTimeout(done, state.postDelayMs));
    const override = state.respond.shift();
    if (override === "conflict") {
      return route.fulfill({
        status: 409,
        json: { error: { code: "DROPSHIP_COST_CHANGE_POLICY_CONFLICT", message: "Another version was published." } },
      });
    }
    const replayed = state.keys.get(body.idempotencyKey);
    if (replayed) {
      return route.fulfill({ status: 200, json: { policy: replayed, previousPolicy: null, idempotentReplay: true } });
    }
    const previous = state.versions.find((version) => version.isActive) ?? null;
    const next: VersionRecord = {
      policyId: state.versions.length + 1,
      version: state.versions.length + 1,
      settings: body.settings,
      isActive: true,
      changeNote: body.changeNote,
      createdAt: "2026-09-28T09:30:00.000Z",
      createdBy: { actorType: "admin", actorId: "admin-1" },
      deactivatedAt: null,
    };
    state.versions = state.versions.map((version) =>
      version.isActive ? { ...version, isActive: false, deactivatedAt: next.createdAt } : version);
    state.versions.push(next);
    state.keys.set(body.idempotencyKey, next);
    // "lost": the version is published, but the answer never reaches the browser.
    if (override === "lost") {
      return route.fulfill({ status: 503, contentType: "text/html", body: "<html>Service Unavailable</html>" });
    }
    return route.fulfill({ status: 201, json: { policy: next, previousPolicy: previous, idempotentReplay: false } });
  });
  await page.route("**/__cost-change-policy-test*", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><div id="root"></div><script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/dropship-cost-change-policy-harness.tsx").replaceAll("\\", "/")}"></script></body></html>`,
  }));
  await page.goto(`/__cost-change-policy-test${options.canEdit === false ? "?canEdit=false" : ""}`);
  return state;
}

const form = (page: Page) => page.getByTestId("cost-change-policy-form");
const publishButton = (page: Page) => page.getByTestId("cost-change-policy-publish");

test("confirms the migration's seed as a staff version, and a lost answer is retried without publishing twice", async ({ page }, testInfo) => {
  const state = await mount(page);

  // Nothing acts yet, and the page says what happens to a cost change today.
  await expect(page.getByTestId("cost-change-policy-today")).toContainText("charged on the next order accepted");
  await expect(page.getByTestId("cost-change-policy-enforcement").getByText("Not live yet")).toHaveCount(4);
  await expect(page.getByTestId("cost-change-policy-in-force")).toContainText("System (migration:0710)");
  await expect(page.getByTestId("cost-change-detection")).toContainText("No detection pass has run yet.");
  await expect(page.getByTestId("cost-change-pending-empty")).toHaveText("No cost change is announced.");
  await expect(page.getByTestId("cost-change-log-empty")).toHaveText("Nothing has been recorded yet.");

  // The seed may be confirmed as is, but only with a note saying why.
  await expect(publishButton(page)).toHaveText("Confirm these settings");
  await expect(publishButton(page)).toBeDisabled();
  await expect(page.getByTestId("cost-change-policy-publish-hint")).toHaveText("Add a change note to publish.");
  await page.getByLabel("Change note").fill("  Owner approved the defaults.  ");
  await expect(publishButton(page)).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath(`cost-changes-confirm-${testInfo.project.name}.png`), fullPage: true });

  // The version is published but the answer is lost: the page says so and keeps the key.
  state.respond.push("lost");
  await publishButton(page).click();
  await expect(page.getByTestId("cost-change-policy-error")).toContainText(
    "The server did not confirm the save, so it may or may not have been published.",
  );

  // The retry sends the same key, so the server replays instead of publishing version 3.
  await publishButton(page).click();
  await expect(page.getByTestId("cost-change-policy-message")).toHaveText(
    "Version 2 was already published; nothing changed.",
  );
  expect(state.posts).toHaveLength(2);
  expect(state.posts[1]!.idempotencyKey).toBe(state.posts[0]!.idempotencyKey);
  expect(state.posts[0]!.idempotencyKey).toMatch(/^dropship-cost-change-policy:/);
  expect(state.posts[0]).toEqual({
    settings: defaults,
    changeNote: "Owner approved the defaults.",
    idempotencyKey: state.posts[0]!.idempotencyKey,
  });
  expect(state.versions.map((version) => version.version)).toEqual([1, 2]);

  // The page reloaded the policy: staff now own version 2, and nothing is left to confirm.
  await expect(page.getByTestId("cost-change-policy-in-force")).toContainText("Staff user admin-1");
  await expect(page.getByTestId("cost-change-policy-version-2")).toContainText("No setting changed (confirmed as is)");
  await expect(publishButton(page)).toHaveText("Publish new version");
  await expect(publishButton(page)).toBeDisabled();
  expect(state.unexpected).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("publishes a changed policy through every kind of control and records what changed", async ({ page }, testInfo) => {
  const staff: VersionRecord = {
    ...seed,
    policyId: 2,
    version: 2,
    changeNote: "Owner approved the defaults.",
    createdAt: "2026-09-27T12:00:00.000Z",
    createdBy: { actorType: "admin", actorId: "admin-1" },
  };
  const state = await mount(page, {
    versions: [{ ...seed, isActive: false, deactivatedAt: staff.createdAt }, staff],
  });
  await expect(page.getByTestId("cost-change-policy-publish-hint")).toHaveText("These settings match the version in force.");
  await expect(publishButton(page)).toBeDisabled();

  // An out-of-range box is named and blocks publishing.
  const noticeDays = page.getByLabel("Notice before a higher cost is charged (days)");
  await noticeDays.fill("91");
  await expect(form(page).getByText("Enter whole days from 0 to 90.")).toBeVisible();
  await noticeDays.fill("21");
  await expect(form(page).getByText("Enter whole days from 0 to 90.")).toHaveCount(0);

  await page.getByRole("switch", { name: /Also tell vendors when a cost goes down/ }).click();
  await page.getByRole("radio", { name: "Pause the listing" }).click();
  await page.getByLabel("Skip notices for changes under ($ per unit)").fill("0.29");
  await expect(page.getByTestId("cost-change-policy-publish-hint")).toHaveText("Add a change note to publish.");
  await page.getByLabel("Change note").fill("Three weeks for the holiday catalog.");
  await expect(page.getByTestId("cost-change-policy-publish-hint")).toHaveText("Ready to publish.");
  await page.screenshot({ path: testInfo.outputPath(`cost-changes-edit-${testInfo.project.name}.png`), fullPage: true });

  await publishButton(page).click();
  await expect(page.getByTestId("cost-change-policy-message")).toHaveText("Version 3 published.");
  expect(state.posts).toHaveLength(1);
  expect(state.posts[0]!.settings).toEqual({
    ...defaults,
    increaseNoticeDays: 21,
    notifyOnDecrease: false,
    belowCostFixedListings: "pause_listing",
    // Typed as 0.29: read digit by digit, never as 28.999… through a float.
    noticeMinimumChangeCents: 29,
  });

  const latest = page.getByTestId("cost-change-policy-version-3");
  await expect(latest).toContainText("Notice before a higher cost is charged: 14 days → 21 days");
  await expect(latest).toContainText("Also tell vendors when a cost goes down: On → Off");
  await expect(latest).toContainText("Skip notices for changes under: No minimum → $0.29");
  await expect(latest).toContainText("Fixed-price listings the new cost puts below cost: Warn the vendor → Pause the listing");
  await expect(latest).toContainText("In force");
  await expect(page.getByTestId("cost-change-policy-version-2")).toContainText("Retired");
  await expect(page.getByTestId("cost-change-policy-in-force-increaseNoticeDays")).toContainText("21 days");
  await expect(page.getByLabel("Change note")).toHaveValue("");
  await page.screenshot({ path: testInfo.outputPath(`cost-changes-published-${testInfo.project.name}.png`), fullPage: true });
  expect(state.unexpected).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("a refused save is explained, and a different change gets a new key", async ({ page }) => {
  const state = await mount(page);
  await page.getByLabel("Notice before a higher cost is charged (days)").fill("30");
  await page.getByLabel("Change note").fill("A month of notice.");
  state.respond.push("conflict");
  await publishButton(page).click();
  await expect(page.getByTestId("cost-change-policy-error")).toContainText(
    "Another version was published at the same moment, so nothing was saved.",
  );

  await page.getByLabel("Change note").fill("A month of notice for every vendor.");
  await publishButton(page).click();
  await expect(page.getByTestId("cost-change-policy-message")).toHaveText("Version 2 published.");
  expect(state.posts).toHaveLength(2);
  expect(state.posts[1]!.idempotencyKey).not.toBe(state.posts[0]!.idempotencyKey);
  expect(state.pageErrors).toEqual([]);
});

test("a double click while the save is in flight sends one request", async ({ page }) => {
  const state = await mount(page);
  await page.getByLabel("Change note").fill("Owner approved the defaults.");
  state.postDelayMs = 500;
  await publishButton(page).dblclick();
  await expect(page.getByTestId("cost-change-policy-message")).toHaveText("Version 2 published.");
  expect(state.posts).toHaveLength(1);
  expect(state.versions.map((version) => version.version)).toEqual([1, 2]);
  expect(state.pageErrors).toEqual([]);
});

test("a viewer without manage-operations sees the policy but can change nothing", async ({ page }) => {
  const state = await mount(page, { canEdit: false });
  await expect(form(page)).toContainText("The dropship manage-operations permission is required to change these settings.");
  await expect(page.getByTestId("cost-change-policy-in-force")).toContainText("14 days");
  for (const control of await form(page).locator("input:not([aria-hidden]), textarea, button").all()) {
    await expect(control).toBeDisabled();
  }
  await expect(page.getByTestId("cost-change-policy-publish-hint")).toHaveCount(0);
  expect(state.posts).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("shows what detection found: the last pass, the announced changes, and the log a page at a time", async ({ page }, testInfo) => {
  const subject = {
    vendorId: 5, vendorBusinessName: "Shellz Vendor", productVariantId: 66, variantSku: "ARM-ENV-SGL-P50",
    variantName: "Single pack", productName: "Armor Envelope", policyId: 1, costSource: "plan_percent" as const,
    effectiveAt: "2026-10-13T00:00:00.000Z", observedAt: "2026-09-28T08:05:00.000Z",
  };
  const rows: LogRow[] = Array.from({ length: 53 }, (_, index) => ({
    ...subject,
    logId: index + 1,
    entryId: index + 1,
    eventType: index === 52 ? "increase_announced" : index === 51 ? "change_withdrawn" : "baseline",
    fromCents: index === 52 ? 809 : index === 51 ? 1099 : null,
    toCents: index === 52 ? 999 : index === 51 ? null : 809,
    retailDriven: index === 51,
    createdAt: "2026-09-28T08:05:00.000Z",
  }));
  const state = await mount(page, {
    enforcement: { ...noneLive, detection: true },
    detection: {
      workerEnabled: true,
      state: {
        ...idleDetection, passNumber: 3, passStartedAt: "2026-09-28T08:00:00.000Z", passCompletedAt: "2026-09-28T08:06:00.000Z",
        policyId: 1, passVendorsProcessed: 4, passVariantsRead: 120, passUnavailableReadings: 1, passChangesRecorded: 2,
        lastTickAt: "2026-09-28T08:59:00.000Z",
      },
      pending: [{ ...subject, entryId: 53, kind: "increase", fromCents: 809, unitCostCents: 999 }],
    },
    log: rows,
  });

  // Detection is live, so the today summary says changes are recorded but still charged at once.
  await expect(page.getByTestId("cost-change-policy-today")).toContainText("found and recorded on the schedule below");
  await expect(page.getByTestId("cost-change-policy-part-detection")).toContainText("Live");
  await expect(page.getByTestId("cost-change-policy-in-force-detectionIntervalMinutes")).not.toContainText("Not yet");

  const detection = page.getByTestId("cost-change-detection");
  await expect(detection).toContainText("Last detection pass completed");
  await expect(detection).toContainText("Pass 3: 4 vendors, 120 variant readings, 2 changes recorded, 1 reading unavailable.");
  const announced = page.getByTestId("cost-change-pending-53");
  await expect(announced).toContainText("Shellz Vendor");
  await expect(announced).toContainText("ARM-ENV-SGL-P50 · Armor Envelope");
  await expect(announced).toContainText("Increase");
  await expect(announced).toContainText("$8.09 → $9.99");
  await expect(announced).toContainText("Plan percentage of retail");

  // The first page holds the newest 50 rows; "Show older" fetches the 3 before the last one shown.
  const log = page.getByTestId("cost-change-log");
  await expect(log.locator("li")).toHaveCount(50);
  await expect(page.getByTestId("cost-change-log-53")).toContainText("Increase announced");
  await expect(page.getByTestId("cost-change-log-53")).toContainText("$8.09 → $9.99");
  await expect(page.getByTestId("cost-change-log-52")).toContainText("Announced change withdrawn");
  await expect(page.getByTestId("cost-change-log-52")).toContainText("$10.99 withdrawn");
  await expect(page.getByTestId("cost-change-log-52")).toContainText("Retail price move");
  await page.screenshot({ path: testInfo.outputPath(`cost-changes-activity-${testInfo.project.name}.png`), fullPage: true });
  await page.getByTestId("cost-change-log-older").click();
  await expect(log.locator("li")).toHaveCount(53);
  await expect(page.getByTestId("cost-change-log-1")).toContainText("Schedule started");
  await expect(page.getByTestId("cost-change-log-older")).toHaveCount(0);
  expect(state.logReads).toEqual(["?limit=50", "?limit=50&beforeId=4"]);
  expect(state.unexpected).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});
