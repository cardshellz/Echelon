import { expect, test, type Page } from "playwright/test";
import { resolve } from "node:path";
import { contentCandidate, noContentProfile } from "../../server/modules/dropship/__tests__/fixtures/listing-content.fixture";
import { resolveListingContent, listingCatalogHash } from "../../server/modules/dropship/application/dropship-listing-content-resolver";
import type { ContentProfileState, SavedListingContent } from "../../shared/dropship/listing-content";
// Playwright's serviceWorkers:block init script reads navigator.serviceWorker in
// every frame, which throws in an opaque sandbox. This fresh local-only harness
// registers no workers. Keep the production iframe sandbox fully restrictive.
test.use({ serviceWorkers: "allow" });

async function setup(page: Page) {
  const state = { saved: null as SavedListingContent | null, profile: structuredClone(noContentProfile) as ContentProfileState,
    candidate: contentCandidate(), writes: [] as Record<string, unknown>[], templates: [] as Record<string, unknown>[],
    replay: new Set<string>(), abortOnce: false, conflict: false, failNextRead: false,
    previews: [] as Record<string, unknown>[], unexpected: [] as string[], errors: [] as string[] };
  function setting(saved = state.saved) { return { storeConnectionId: 22, productVariantId: 101, customText: saved?.customText ?? null,
    revisionId: saved?.revisionId ?? null, updatedAt: saved?.updatedAt ?? null,
    resolved: resolveListingContent({ candidate: state.candidate, profile: state.profile, saved }) }; }
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/content-profile/targets")) return route.fulfill({ json: { total: 1000, rows: [{ id: "101", name: "Armalope · Pack of 50 · ARM-50" }] } });
    if (path.endsWith("/content-profile")) {
      if (route.request().method() === "PUT") {
        const input = route.request().postDataJSON(); state.templates.push(input);
        state.profile = { revisionId: 1, profile: input.profile, updatedAt: "2026-09-07T12:00:00Z" };
        return route.fulfill({ json: { state: state.profile, idempotentReplay: false } });
      }
      return route.fulfill({ json: state.profile });
    }
    if (path.endsWith("/content/preview")) {
      const input = route.request().postDataJSON(); state.previews.push(input);
      return route.fulfill({ json: { content: setting({ revisionId: state.saved?.revisionId ?? 1, customText: input.customText,
        catalogHash: listingCatalogHash(state.candidate), updatedAt: "2026-09-07T12:00:00Z" }) } });
    }
    if (path.endsWith("/content")) {
      if (route.request().method() === "PUT") {
        const input = route.request().postDataJSON(); state.writes.push(input);
        if (state.conflict) return route.fulfill({ status: 409, json: { error: { code: "DROPSHIP_CONTENT_VERSION_CONFLICT", message: "Catalog facts changed. Reload to review." } } });
        const replay = state.replay.has(input.idempotencyKey);
        if (!replay) { state.replay.add(input.idempotencyKey); state.saved = { revisionId: (state.saved?.revisionId ?? 0) + 1,
          customText: input.customText, catalogHash: input.expectedCatalogHash, updatedAt: "2026-09-07T12:00:00Z" }; }
        if (state.abortOnce) { state.abortOnce = false; return route.abort("failed"); }
        return route.fulfill({ json: { content: setting(), idempotentReplay: replay } });
      }
      if (state.failNextRead) {
        state.failNextRead = false;
        return route.fulfill({ status: 503, json: { error: { message: "Description temporarily unavailable." } } });
      }
      return route.fulfill({ json: { content: setting() } });
    }
    state.unexpected.push(path); return route.fulfill({ status: 500, json: { error: { message: "Unexpected API" } } });
  });
  await page.route("**/__content-test", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><main id="root" style="max-width:1000px;margin:24px auto;padding:12px"></main>
    <script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/dropship-content-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto("/__content-test");
  await expect(page.getByRole("button", { name: "Edit", exact: true }), JSON.stringify(state.errors)).toBeVisible();
  return state;
}
test("places Edit and Reset below the description, then replaces the box with Save and Cancel editing", async ({ page }, testInfo) => {
  const state = await setup(page);
  const editor = page.getByRole("region", { name: "Listing description editor" });
  const frame = editor.locator('iframe[title="Description preview"]');
  await expect(editor.locator("button:visible")).toHaveCount(2);
  await expect(editor.getByRole("button", { name: "Reset", exact: true })).toBeDisabled();
  const box = await frame.boundingBox();
  const edit = await editor.getByRole("button", { name: "Edit", exact: true }).boundingBox();
  expect(box).not.toBeNull(); expect(edit).not.toBeNull();
  expect(edit!.y).toBeGreaterThanOrEqual(box!.y + box!.height);
  await page.screenshot({ path: testInfo.outputPath("description-view.png"), fullPage: true });
  await editor.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(frame).toHaveCount(0);
  await expect(editor.locator("button:visible")).toHaveCount(3);
  await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Description text", { exact: true })).toBeFocused();
  await page.getByLabel("Description text", { exact: false }).fill("My shop copy\n\nSafe <script>alert(1)</script>");
  await page.screenshot({ path: testInfo.outputPath("description-edit.png"), fullPage: true });
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor.getByRole("status")).toContainText("Draft saved and preview refreshed");
  await expect(editor.getByRole("button", { name: "Edit", exact: true })).toBeFocused();
  await expect(page.getByLabel("Description text", { exact: true })).toHaveCount(0);
  await expect(editor.locator("button:visible")).toHaveCount(2);
  await expect(page.frameLocator('iframe[title="Description preview"]').locator("body")).toContainText("My shop copy");
  await expect(page.frameLocator('iframe[title="Description preview"]').locator("script")).toHaveCount(0);
  await expect(frame).toHaveAttribute("sandbox", "");
  expect(state.writes).toHaveLength(1); expect(state.saved?.customText).toContain("My shop copy");
  expect(state.previews).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("opening Edit and cancelling never converts inherited formatting or writes a draft", async ({ page }) => {
  const state = await setup(page);
  const frame = page.locator('iframe[title="Description preview"]');
  const original = await frame.getAttribute("srcdoc");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByLabel("Description text", { exact: true })).toHaveValue(
    resolveListingContent({ candidate: state.candidate, profile: state.profile, saved: null }).catalogText,
  );
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.getByLabel("Description text", { exact: true }).fill("Discard this local edit");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(frame).toHaveAttribute("srcdoc", original!);
  await expect(page.getByRole("button", { name: "Reset", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByLabel("Description text", { exact: true })).not.toHaveValue("Discard this local edit");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  expect(state.writes).toHaveLength(0); expect(state.saved).toBeNull(); expect(state.errors).toEqual([]);
});

test("Reset stages the catalog body and supports Cancel or Save without publishing", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Description text", { exact: true }).fill("My saved description");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByText("Catalog description restored in this draft.", { exact: false })).toBeVisible();
  expect(state.writes).toHaveLength(1); expect(state.saved?.customText).toBe("My saved description");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.frameLocator('iframe[title="Description preview"]').locator("body")).toContainText("My saved description");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByLabel("Description text", { exact: true })).toHaveValue("My saved description");
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Draft saved");
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset", exact: true })).toBeDisabled();
  const catalogHtml = resolveListingContent({ candidate: state.candidate, profile: state.profile, saved: null }).descriptionHtml;
  expect(await page.locator('iframe[title="Description preview"]').getAttribute("srcdoc")).toContain(catalogHtml);
  expect(state.writes).toHaveLength(2);
  expect(state.saved?.customText).toBeNull(); expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});
test("preserves text and retry identity after an ambiguous save", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Description text", { exact: false }).fill("Keep this draft");
  state.abortOnce = true;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry save", exact: true })).toBeVisible();
  await expect(page.getByLabel("Description text", { exact: false })).toHaveValue("Keep this draft");
  await expect(page.getByLabel("Description text", { exact: false })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reset", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Draft saved");
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(2); expect(state.writes[0]).toEqual(state.writes[1]); expect(state.saved?.revisionId).toBe(1);
});
test("requires reconciliation on conflicts rather than overwriting a newer description", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Description text", { exact: false }).fill("Unsaved text to reconcile"); state.conflict = true;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Catalog facts changed");
  await expect(page.getByLabel("Description text", { exact: false })).toHaveValue("Unsaved text to reconcile");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  expect(state.saved).toBeNull();
  state.conflict = false;
  state.saved = { revisionId: 2, customText: "A newer saved description", catalogHash: listingCatalogHash(state.candidate), updatedAt: "2026-09-07T12:00:00Z" };
  await page.getByRole("button", { name: "Review latest", exact: true }).click();
  await expect(page.getByLabel("Description text", { exact: true })).toHaveValue("Unsaved text to reconcile");
  await expect(page.frameLocator('iframe[title="Latest saved description"]').locator("body")).toContainText("A newer saved description");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  expect(state.writes[1]).toMatchObject({ expectedRevisionId: 2, customText: "Unsaved text to reconcile" });
  expect(state.errors).toEqual([]);
});

test("recovers a saved description after refresh failure without issuing another write", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Description text", { exact: true }).fill("Saved before refresh failed");
  state.failNextRead = true;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry preview refresh", exact: true })).toBeVisible();
  await expect(page.getByLabel("Description text", { exact: true })).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  await page.getByRole("button", { name: "Retry preview refresh", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  await expect(page.frameLocator('iframe[title="Description preview"]').locator("body")).toContainText("Saved before refresh failed");
  expect(state.writes).toHaveLength(1); expect(state.errors).toEqual([]);
});
test("applies reusable templates, keeps hidden drafts, and refreshes the open listing", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Edit templates", exact: true }).click();
  await page.getByLabel("Introduction (optional)", { exact: false }).fill("Welcome to my store");
  await page.getByRole("button", { name: "Hide templates" }).click();
  await page.getByRole("button", { name: "Edit templates", exact: true }).click();
  await expect(page.getByLabel("Introduction (optional)", { exact: false })).toHaveValue("Welcome to my store");
  await page.getByRole("button", { name: "Save description templates" }).click();
  await expect(page.getByRole("status")).toContainText("Draft saved");
  await expect(page.frameLocator('iframe[title="Description preview"]').locator("body")).toContainText("Welcome to my store");
  expect(state.templates).toHaveLength(1); expect(state.writes).toHaveLength(0);
  await page.getByRole("button", { name: "Add template group" }).click();
  await page.locator("summary").filter({ hasText: "New group" }).click();
  await expect(page.getByRole("checkbox", { name: "Armalope · Pack of 50 · ARM-50" })).toBeVisible();
  await page.getByRole("checkbox", { name: "Armalope · Pack of 50 · ARM-50" }).check();
  await page.getByLabel("Group name", { exact: true }).fill("Mailer branding");
  await page.getByRole("button", { name: "Save description templates" }).click();
  await expect(page.getByRole("status")).toContainText("Draft saved");
  expect(state.templates[1]).toMatchObject({ profile: { groups: [{ name: "Mailer branding", scope: { type: "listings", productVariantIds: [101] } }] } });
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});
