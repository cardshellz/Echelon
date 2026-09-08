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
    replay: new Set<string>(), abortOnce: false, conflict: false, unexpected: [] as string[], errors: [] as string[] };
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
      const input = route.request().postDataJSON();
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
      return route.fulfill({ json: { content: setting() } });
    }
    state.unexpected.push(path); return route.fulfill({ status: 500, json: { error: { message: "Unexpected API" } } });
  });
  await page.route("**/__content-test", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><main id="root" style="max-width:1000px;margin:24px auto;padding:12px"></main>
    <script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/dropship-content-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto("/__content-test");
  await expect(page.getByText("Inheriting catalog description", { exact: true }), JSON.stringify(state.errors)).toBeVisible();
  return state;
}
test("edits, previews, saves and resets a description without publishing", async ({ page }, testInfo) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Copy catalog as editable text" }).click();
  await page.getByLabel("Description text", { exact: false }).fill("My shop copy\n\nSafe <script>alert(1)</script>");
  await page.getByRole("button", { name: "Preview description draft" }).click();
  await expect(page.getByText("Unsaved description preview")).toBeVisible();
  await expect(page.frameLocator('iframe[title="Description preview"]').locator("body")).toContainText("My shop copy");
  await expect(page.frameLocator('iframe[title="Description preview"]').locator("script")).toHaveCount(0);
  await page.getByRole("button", { name: "Save description draft" }).click();
  await expect(page.getByRole("status")).toContainText("Draft saved and preview refreshed");
  expect(state.writes).toHaveLength(1); expect(state.saved?.customText).toContain("My shop copy");
  await page.screenshot({ path: testInfo.outputPath("description-editor.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Reset to catalog", exact: true }).click();
  await page.getByRole("button", { name: "Save description draft" }).click();
  await expect(page.getByRole("status")).toContainText("Draft saved");
  expect(state.saved?.customText).toBeNull(); expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});
test("preserves text and retry identity after an ambiguous save", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Copy catalog as editable text" }).click();
  await page.getByLabel("Description text", { exact: false }).fill("Keep this draft");
  state.abortOnce = true;
  await page.getByRole("button", { name: "Save description draft" }).click();
  await expect(page.getByRole("button", { name: "Retry same description save" })).toBeVisible();
  await expect(page.getByLabel("Description text", { exact: false })).toHaveValue("Keep this draft");
  await expect(page.getByLabel("Description text", { exact: false })).toBeDisabled();
  await page.getByRole("button", { name: "Retry same description save" }).click();
  await expect(page.getByRole("status")).toContainText("Draft saved");
  expect(state.writes).toHaveLength(2); expect(state.writes[0]).toEqual(state.writes[1]); expect(state.saved?.revisionId).toBe(1);
});
test("requires reconciliation on conflicts rather than overwriting a newer description", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Copy catalog as editable text" }).click();
  await page.getByLabel("Description text", { exact: false }).fill("Unsaved text to reconcile"); state.conflict = true;
  await page.getByRole("button", { name: "Save description draft" }).click();
  await expect(page.getByRole("alert")).toContainText("Catalog facts changed");
  await expect(page.getByLabel("Description text", { exact: false })).toHaveValue("Unsaved text to reconcile");
  await expect(page.getByRole("button", { name: "Save description draft" })).toBeDisabled();
  expect(state.saved).toBeNull();
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
