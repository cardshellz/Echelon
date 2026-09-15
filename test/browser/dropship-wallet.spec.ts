import { expect, test, type Page } from "playwright/test";
import { resolve } from "node:path";

// Playwright's serviceWorkers:block init script reads navigator.serviceWorker in
// every frame, which throws in an opaque sandbox. This local-only harness
// registers no workers.
test.use({ serviceWorkers: "allow" });

const HARNESS_PATH = "/__wallet-test";
const CARD = { fundingMethodId: 10, rail: "stripe_card", displayLabel: "Visa ending in 4242", isDefault: true, usdcWalletAddress: null,
  createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z" };

interface StubState {
  cardStatus: "none" | "pending" | "active";
  autoReload: Record<string, unknown> | null;
  balanceCents: number;
  proofs: Record<string, { method: string; verifiedAt: string; expiresAt: string }>;
  failChallenge: boolean;
  walletReads: number;
  setupSessions: Record<string, unknown>[];
  autoReloadWrites: Record<string, unknown>[];
  fundingSessions: Record<string, unknown>[];
  codesSent: string[];
  unexpected: string[];
  errors: string[];
}

function walletJson(state: StubState) {
  const fundingMethods = state.cardStatus === "none" ? [] : [{ ...CARD, status: state.cardStatus }];
  return { wallet: {
    account: { walletAccountId: 1, vendorId: 1, availableBalanceCents: state.balanceCents, pendingBalanceCents: 0, currency: "USD",
      status: "active", createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z" },
    autoReload: state.autoReload, fundingMethods, recentLedger: [] } };
}

async function setup(page: Page, initial: Partial<StubState> = {}, path = HARNESS_PATH) {
  const state: StubState = { cardStatus: "none", autoReload: null, balanceCents: 0, proofs: {}, failChallenge: false, walletReads: 0,
    setupSessions: [], autoReloadWrites: [], fundingSessions: [], codesSent: [], unexpected: [], errors: [], ...initial };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/dropship/auth/me") {
      return route.fulfill({ json: { principal: { authIdentityId: 1, memberId: "m-1", cardShellzEmail: "vendor@example.com", hasPasskey: false,
        authMethod: "password", entitlementStatus: "active", authenticatedAt: "2026-09-15T00:00:00.000Z" }, sensitiveProofs: state.proofs } });
    }
    if (url.pathname === "/api/dropship/auth/sensitive-actions/challenge/start") {
      const body = route.request().postDataJSON() as { action: string };
      state.codesSent.push(body.action);
      if (state.failChallenge) return route.fulfill({ status: 503, json: { error: { code: "DROPSHIP_AUTH_EMAIL_DELIVERY_FAILED", message: "Dropship auth verification email could not be sent." } } });
      return route.fulfill({ status: 202, json: { method: "email_mfa", challengeId: "c-1", expiresAt: "2026-09-15T00:10:00.000Z" } });
    }
    if (url.pathname === "/api/dropship/auth/sensitive-actions/challenge/verify") {
      const body = route.request().postDataJSON() as { action: string; verificationCode: string };
      if (body.verificationCode !== "123456") return route.fulfill({ status: 400, json: { error: { message: "That code is not right." } } });
      const proof = { method: "email_mfa", verifiedAt: "2026-09-15T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z" };
      state.proofs[body.action] = proof;
      return route.fulfill({ json: { action: body.action, ...proof } });
    }
    if (url.pathname === "/api/dropship/wallet" && method === "GET") {
      state.walletReads += 1;
      // The card activates two reads after Stripe returns, standing in for the webhook.
      if (state.cardStatus === "pending" && state.walletReads >= 3) state.cardStatus = "active";
      return route.fulfill({ json: walletJson(state) });
    }
    if (url.pathname === "/api/dropship/wallet/funding-methods/stripe/setup-session" && method === "POST") {
      state.setupSessions.push(route.request().postDataJSON());
      state.cardStatus = "pending"; state.walletReads = 0;
      return route.fulfill({ json: { setupSession: { checkoutUrl: `${path}?funding_setup=success`, providerSessionId: "cs_1", expiresAt: null } } });
    }
    if (url.pathname === "/api/dropship/wallet/auto-reload" && method === "PUT") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.autoReloadWrites.push(body);
      state.autoReload = { autoReloadSettingId: 5, updatedAt: "2026-09-15T00:00:00.000Z", ...body };
      return route.fulfill({ json: { autoReload: state.autoReload } });
    }
    if (url.pathname === "/api/dropship/wallet/funding/stripe/checkout-session" && method === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.fundingSessions.push(body);
      return route.fulfill({ json: { fundingSession: { checkoutUrl: `${path}?wallet_funding=success`, providerSessionId: "cs_2", amountCents: body.amountCents, currency: "USD", expiresAt: null } } });
    }
    state.unexpected.push(`${method} ${url.pathname}`);
    return route.fulfill({ status: 500, json: { error: { message: "Unexpected request" } } });
  });
  await page.route(`**${HARNESS_PATH}**`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><div id="root"></div>
    <script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/dropship-wallet-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto(path);
  return state;
}

async function enterCode(page: Page, code = "123456") {
  const prompt = page.getByTestId("wallet-verification");
  await expect(prompt).toBeVisible();
  await prompt.locator("input").first().fill(code);
  await prompt.getByRole("button", { name: "Continue" }).click();
}

test("walks a new vendor from an empty wallet to a launch-ready one with one emailed code", async ({ page }) => {
  const state = await setup(page);
  const setupCard = page.getByTestId("wallet-setup");
  await expect(setupCard).toContainText("Set up your wallet");
  await expect(setupCard.getByRole("button", { name: "Add a card" })).toBeVisible();
  // The launch-only settings are not on the setup step at all.
  await expect(page.getByRole("heading", { name: "Payment hold timeout" })).toHaveCount(0);
  await expect(page.getByTestId("wallet-balance")).toHaveCount(0);

  await setupCard.getByRole("button", { name: "Add a card" }).click();
  // The code prompt appears inside the setup card, not at the top of the page.
  await expect(setupCard.getByTestId("wallet-verification")).toBeVisible();
  await expect(setupCard.getByRole("status")).toContainText("emailed you a 6-digit code");
  expect(state.codesSent).toEqual(["add_funding_method"]);

  await enterCode(page);
  // Stripe's hosted page is stood in for by a same-origin return URL. While the
  // webhook is pending the page says so and keeps asking.
  await expect(page.getByTestId("wallet-setup").getByRole("status")).toContainText("Confirming your card");
  expect(state.setupSessions).toEqual([{ rail: "stripe_card", returnTo: HARNESS_PATH }]);
  // The marker is cleared from the address bar once read.
  expect(new URL(page.url()).search).toBe("");
  await expect(page.getByRole("heading", { name: "Keep it funded automatically" })).toBeVisible();
  await expect(page.getByText("Charged to")).toContainText("Visa ending in 4242");

  // No second code: the proof from the first one is still live after the return.
  await page.getByRole("radiogroup", { name: "Reload when my balance drops below" }).getByRole("radio", { name: "$50", exact: true }).click();
  await page.getByRole("radiogroup", { name: "Add this much each time" }).getByRole("radio", { name: "$100", exact: true }).click();
  await page.getByRole("button", { name: "Turn on auto-reload" }).click();
  await expect(page.getByTestId("wallet-balance")).toBeVisible();
  expect(state.autoReloadWrites).toEqual([{ enabled: true, fundingMethodId: 10, minimumBalanceCents: 5000, maxSingleReloadCents: 10_000, paymentHoldTimeoutMinutes: 2880 }]);
  expect(state.codesSent).toEqual(["add_funding_method"]);

  await expect(page.getByTestId("wallet-available")).toHaveText("$0.00");
  await expect(page.getByTestId("wallet-auto-reload-summary")).toHaveText("Below $50.00, add $100.00 from Visa ending in 4242.");
  await expect(page.getByRole("button", { name: "Back to onboarding" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Payment hold timeout" })).toHaveCount(0);
  await page.getByRole("button", { name: /Advanced/ }).click();
  await expect(page.getByRole("heading", { name: "Payment hold timeout" })).toBeVisible();
  await expect(page.getByLabel("Minutes")).toHaveValue("2880");
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("a cancelled card setup changes nothing and says so next to the step", async ({ page }) => {
  const state = await setup(page, {}, `${HARNESS_PATH}?funding_setup=cancelled`);
  await expect(page.getByText("Card setup was cancelled. Nothing was saved.")).toBeVisible();
  await expect(page.getByTestId("wallet-setup").getByRole("button", { name: "Add a card" })).toBeVisible();
  // The marker is cleared so a reload does not repeat the banner.
  expect(new URL(page.url()).search).toBe("");
  expect(state.setupSessions).toEqual([]);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("a failed code email is reported inside the setup card and nothing is saved", async ({ page }) => {
  const state = await setup(page, { failChallenge: true });
  const setupCard = page.getByTestId("wallet-setup");
  await setupCard.getByRole("button", { name: "Add a card" }).click();
  await expect(setupCard.getByRole("alert")).toContainText("verification email could not be sent");
  await expect(setupCard.getByTestId("wallet-verification")).toHaveCount(0);
  await expect(setupCard.getByRole("button", { name: "Add a card" })).toBeEnabled();
  expect(state.setupSessions).toEqual([]);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("a ready wallet leads with the balance and adds funds from a preset after one code", async ({ page }) => {
  const state = await setup(page, { cardStatus: "active", balanceCents: 4_250,
    autoReload: { autoReloadSettingId: 5, enabled: true, minimumBalanceCents: 5000, maxSingleReloadCents: 25_000, paymentHoldTimeoutMinutes: 2880, fundingMethodId: 10, updatedAt: "2026-09-15T00:00:00.000Z" } });
  await expect(page.getByTestId("wallet-setup")).toHaveCount(0);
  await expect(page.getByTestId("wallet-available")).toHaveText("$42.50");
  await expect(page.getByTestId("wallet-auto-reload-summary")).toHaveText("Below $50.00, add $250.00 from Visa ending in 4242.");

  await page.getByRole("button", { name: "Add funds" }).click();
  await page.getByRole("radiogroup", { name: "Amount" }).getByRole("radio", { name: "$100", exact: true }).click();
  await page.getByRole("button", { name: "Continue to payment" }).click();
  const balance = page.getByTestId("wallet-balance");
  await expect(balance.getByTestId("wallet-verification")).toBeVisible();
  expect(state.codesSent).toEqual(["wallet_funding_high_value"]);
  await enterCode(page);
  await expect(page.getByText("Payment received.")).toBeVisible();
  expect(state.fundingSessions).toEqual([{ fundingMethodId: 10, amountCents: 10_000, returnTo: HARNESS_PATH }]);
  expect(new URL(page.url()).search).toBe("");
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("a wrong code is rejected in place and can be retried", async ({ page }) => {
  const state = await setup(page);
  const setupCard = page.getByTestId("wallet-setup");
  await setupCard.getByRole("button", { name: "Add a card" }).click();
  await enterCode(page, "000000");
  await expect(setupCard.getByRole("alert")).toContainText("That code is not right.");
  await expect(setupCard.getByTestId("wallet-verification")).toBeVisible();
  expect(state.setupSessions).toEqual([]);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});
