import { expect, test, type Page } from "playwright/test";
import { resolve } from "node:path";

// Playwright's serviceWorkers:block init script reads navigator.serviceWorker in
// every frame, which throws in an opaque sandbox. This local-only harness
// registers no workers.
test.use({ serviceWorkers: "allow" });

const HARNESS_PATH = "/__wallet-test";
const STAMP = "2026-09-15T00:00:00.000Z";
const CARD = { fundingMethodId: 10, rail: "stripe_card", displayLabel: "Visa ending in 4242", isDefault: true, usdcWalletAddress: null, createdAt: STAMP, updatedAt: STAMP };
const BANK = { fundingMethodId: 30, rail: "stripe_ach", displayLabel: "Chase ending in 2222", isDefault: false, usdcWalletAddress: null, createdAt: STAMP, updatedAt: STAMP };
const DEPOSIT_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const LIVE_PROOF = { method: "email_mfa", verifiedAt: STAMP, expiresAt: "2999-01-01T00:00:00.000Z" };

type MethodStatus = "none" | "pending" | "active";

interface StubState {
  cardStatus: MethodStatus;
  bankStatus: MethodStatus;
  usdcMethods: Record<string, unknown>[];
  usdcDepositAddress: string | null;
  autoReload: Record<string, unknown> | null;
  balanceCents: number;
  proofs: Record<string, { method: string; verifiedAt: string; expiresAt: string }>;
  failChallenge: boolean;
  walletReads: number;
  setupSessions: Record<string, unknown>[];
  autoReloadWrites: Record<string, unknown>[];
  fundingSessions: Record<string, unknown>[];
  usdcRegistrations: Record<string, unknown>[];
  codesSent: string[];
  unexpected: string[];
  errors: string[];
  /** The vendor's standing as the onboarding state reports it; the page shows why selling stopped when paused. */
  vendorStatus: "onboarding" | "active" | "paused";
  vendorStandingReason: "card_declined" | "funding_returned" | null;
}

function onboardingJson(state: StubState) {
  return {
    vendor: { vendorId: 1, memberId: "m-1", businessName: "Vendor", contactName: null, email: "vendor@example.com", phone: null,
      status: state.vendorStatus, entitlementStatus: "active", membershipGraceEndsAt: null, includedStoreConnections: 1,
      standingReason: state.vendorStandingReason, pausedAt: state.vendorStatus === "paused" ? STAMP : null },
    entitlement: { memberId: "m-1", cardShellzEmail: "vendor@example.com", status: "active", planId: "ops", planName: "Ops", subscriptionId: "sub-1", includesDropship: true, reasonCode: "active" },
    storeConnections: { activeCount: 1, connectedCount: 1, launchReadyConnectedCount: 1, credentialAttentionCount: 0, needsAttentionCount: 0, totalCount: 1, includedLimit: 1, canConnectStore: false },
    catalog: { adminExposureRuleCount: 1, vendorSelectionRuleCount: 1, adminCatalogAvailable: true, hasVendorSelection: true },
    wallet: { availableBalanceCents: state.balanceCents, pendingBalanceCents: 0, activeFundingMethodCount: 1, activeStripeFundingMethodCount: 1, activeStripeCardFundingMethodCount: 1, activeUsdcBaseFundingMethodCount: 0,
      autoReloadEnabled: true, autoReloadFundingMethodId: 10, autoReloadFundingMethodActive: true, autoReloadFundingMethodReady: true, autoReloadFundingMethodIsCard: true },
    steps: [],
  };
}

function walletJson(state: StubState) {
  const fundingMethods = [
    ...(state.cardStatus === "none" ? [] : [{ ...CARD, status: state.cardStatus }]),
    ...(state.bankStatus === "none" ? [] : [{ ...BANK, status: state.bankStatus }]),
    ...state.usdcMethods,
  ];
  return { wallet: {
    account: { walletAccountId: 1, vendorId: 1, availableBalanceCents: state.balanceCents, pendingBalanceCents: 0, currency: "USD",
      status: "active", createdAt: STAMP, updatedAt: STAMP },
    autoReload: state.autoReload, fundingMethods, recentLedger: [], cardFundingFeeBps: 300, usdcBaseDepositAddress: state.usdcDepositAddress } };
}

async function setup(page: Page, initial: Partial<StubState> = {}, path = HARNESS_PATH) {
  const state: StubState = { cardStatus: "none", bankStatus: "none", usdcMethods: [], usdcDepositAddress: null, autoReload: null, balanceCents: 0,
    proofs: {}, failChallenge: false, walletReads: 0, setupSessions: [], autoReloadWrites: [], fundingSessions: [], usdcRegistrations: [],
    codesSent: [], unexpected: [], errors: [], vendorStatus: "active", vendorStandingReason: null, ...initial };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/dropship/auth/me") {
      return route.fulfill({ json: { principal: { authIdentityId: 1, memberId: "m-1", cardShellzEmail: "vendor@example.com", hasPasskey: false,
        authMethod: "password", entitlementStatus: "active", authenticatedAt: STAMP }, sensitiveProofs: state.proofs } });
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
      state.proofs[body.action] = LIVE_PROOF;
      return route.fulfill({ json: { action: body.action, ...LIVE_PROOF } });
    }
    if (url.pathname === "/api/dropship/onboarding/state" && method === "GET") {
      return route.fulfill({ json: onboardingJson(state) });
    }
    if (url.pathname === "/api/dropship/wallet" && method === "GET") {
      state.walletReads += 1;
      // A method activates two reads after Stripe returns, standing in for the webhook.
      if (state.cardStatus === "pending" && state.walletReads >= 3) state.cardStatus = "active";
      if (state.bankStatus === "pending" && state.walletReads >= 3) state.bankStatus = "active";
      return route.fulfill({ json: walletJson(state) });
    }
    if (url.pathname === "/api/dropship/wallet/funding-methods/stripe/setup-session" && method === "POST") {
      const body = route.request().postDataJSON() as { rail: string };
      state.setupSessions.push(body);
      if (body.rail === "stripe_ach") state.bankStatus = "pending";
      else state.cardStatus = "pending";
      state.walletReads = 0;
      return route.fulfill({ json: { setupSession: { checkoutUrl: `${path}?funding_setup=success`, providerSessionId: "cs_1", expiresAt: null } } });
    }
    if (url.pathname === "/api/dropship/wallet/auto-reload" && method === "PUT") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.autoReloadWrites.push(body);
      state.autoReload = { autoReloadSettingId: 5, updatedAt: STAMP, ...body };
      return route.fulfill({ json: { autoReload: state.autoReload } });
    }
    if (url.pathname === "/api/dropship/wallet/funding/stripe/checkout-session" && method === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.fundingSessions.push(body);
      const amountCents = Number(body.amountCents);
      const cardFeeCents = Number(body.fundingMethodId) === CARD.fundingMethodId ? Math.floor((amountCents * 300 + 5_000) / 10_000) : 0;
      return route.fulfill({ json: { fundingSession: { checkoutUrl: `${path}?wallet_funding=success`, providerSessionId: "cs_2", amountCents,
        cardFeeCents, chargedCents: amountCents + cardFeeCents, currency: "USD", expiresAt: null } } });
    }
    if (url.pathname === "/api/dropship/wallet/funding-methods/usdc-base" && method === "POST") {
      const body = route.request().postDataJSON() as { walletAddress: string; displayLabel: string };
      state.usdcRegistrations.push(body);
      const fundingMethod = { fundingMethodId: 20, rail: "usdc_base", status: "active", displayLabel: body.displayLabel, isDefault: false,
        usdcWalletAddress: body.walletAddress, createdAt: STAMP, updatedAt: STAMP };
      state.usdcMethods = [fundingMethod];
      return route.fulfill({ json: { fundingMethod } });
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

function checked(page: Page, group: string, name: string) {
  return expect(page.getByRole("radiogroup", { name: group }).getByRole("radio", { name, exact: true })).toHaveAttribute("aria-checked", "true");
}

test("walks a new vendor to a launch-ready wallet: backup card, then a bank account for top-ups, with one emailed code", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "onboarding" });
  const setupCard = page.getByTestId("wallet-setup");
  await expect(setupCard).toContainText("Set up your wallet");
  await expect(setupCard.getByRole("button", { name: "Add a card" })).toBeVisible();
  // The card's role and the fee policy are stated before the card is ever added.
  await expect(setupCard.getByTestId("wallet-backup-card-role")).toContainText("The card is the backup, not your main way to pay.");
  await expect(setupCard.getByTestId("wallet-card-fee-note")).toHaveText("Card charges carry a 3% fee on top of the amount added. Bank accounts and USDC carry no fee.");
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
  await expect(page.getByTestId("wallet-card-confirmation")).toContainText("Confirming your card");
  expect(state.setupSessions).toEqual([{ rail: "stripe_card", returnTo: HARNESS_PATH }]);
  // The marker is cleared from the address bar once read.
  expect(new URL(page.url()).search).toBe("");

  // Step two: the bank account is offered first; with none yet the card is the selection.
  await expect(page.getByRole("heading", { name: "Choose how to top up" })).toBeVisible();
  const topUpFrom = page.getByRole("radiogroup", { name: "Top up from" });
  await expect(topUpFrom.getByRole("radio", { name: "Bank account" })).toBeDisabled();
  await checked(page, "Top up from", "Card");
  await expect(topUpFrom).toContainText("Visa ending in 4242");
  await checked(page, "Keep my balance at", "$250");
  await checked(page, "Largest single top-up", "$500");
  await expect(page.getByTestId("wallet-auto-reload-fee")).toHaveText("Card top-ups carry a 3% fee on top of the amount added: a $500.00 top-up charges $515.00.");

  // Adding the bank account needs no second code: the proof from the first one is still live.
  await topUpFrom.getByRole("button", { name: "Add a bank account" }).click();
  await expect(page.getByTestId("wallet-bank-confirmation")).toContainText("Confirming your bank account");
  expect(state.setupSessions).toEqual([{ rail: "stripe_card", returnTo: HARNESS_PATH }, { rail: "stripe_ach", returnTo: HARNESS_PATH }]);
  expect(state.codesSent).toEqual(["add_funding_method"]);
  // Once it lands it becomes the selection, and the copy says exactly what is being agreed to.
  await checked(page, "Top up from", "Bank account");
  await expect(topUpFrom).toContainText("Chase ending in 2222");
  await expect(page.getByTestId("wallet-top-up-rule")).toHaveText(
    "We keep your balance at $250.00: once a day, and after any order that takes it lower, we top it back up from Chase ending in 2222. One top-up never charges more than $500.00.",
  );
  await expect(page.getByTestId("wallet-auto-reload-fee")).toHaveText(
    "Bank top-ups carry no fee and take a few days to land. An order that cannot wait is charged to Visa ending in 4242 plus the 3% card fee.",
  );
  await expect(page.getByTestId("wallet-auto-reload-mandate")).toHaveText(
    "By turning this on, you authorize Card Shellz to debit Chase ending in 2222 to keep your balance at $250.00, up to $500.00 per charge, and to charge Visa ending in 4242 plus the 3% card fee for any order your balance cannot cover.",
  );
  await expect(page.getByTestId("wallet-pause-note")).toContainText("selling pauses");

  await page.getByRole("button", { name: "Turn on auto-reload" }).click();
  await expect(page.getByTestId("wallet-balance")).toBeVisible();
  expect(state.autoReloadWrites).toEqual([{ enabled: true, fundingMethodId: 30, minimumBalanceCents: 25_000, maxSingleReloadCents: 50_000, paymentHoldTimeoutMinutes: 2880,
    acknowledgedCardFeeBps: 300 }]);
  expect(state.codesSent).toEqual(["add_funding_method"]);

  await expect(page.getByTestId("wallet-available")).toHaveText("$0.00");
  await expect(page.getByTestId("wallet-auto-reload-summary")).toHaveText(
    "Keeps your balance at $250.00 from Chase ending in 2222, no fee, up to $500.00 per top-up. Visa ending in 4242 covers any order that cannot wait, plus the 3% card fee.",
  );
  await expect(page.getByRole("button", { name: "Back to onboarding" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Payment hold timeout" })).toHaveCount(0);
  await page.getByRole("button", { name: /Advanced/ }).click();
  await expect(page.getByRole("heading", { name: "Payment hold timeout" })).toBeVisible();
  await expect(page.getByLabel("Minutes")).toHaveValue("2880");
  await expect(page.getByTestId("wallet-advanced")).toContainText("Chase ending in 2222");
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("a vendor who tops up from the card sees the fee on the cap, and the cap never sits below the balance kept", async ({ page }) => {
  const state = await setup(page, { cardStatus: "active", proofs: { add_funding_method: LIVE_PROOF } });
  await checked(page, "Top up from", "Card");
  const keep = page.getByRole("radiogroup", { name: "Keep my balance at" });
  const cap = page.getByRole("radiogroup", { name: "Largest single top-up" });

  // Raising the balance kept lifts the cap with it and greys out what no longer fits.
  await keep.getByRole("radio", { name: "$1,000", exact: true }).click();
  await checked(page, "Largest single top-up", "$1,000");
  await expect(cap.getByRole("radio", { name: "$250", exact: true })).toBeDisabled();
  await expect(cap.getByRole("radio", { name: "$500", exact: true })).toBeDisabled();

  await keep.getByRole("radio", { name: "$100", exact: true }).click();
  await expect(cap.getByRole("radio", { name: "$250", exact: true })).toBeEnabled();
  await cap.getByRole("radio", { name: "$250", exact: true }).click();
  await expect(page.getByTestId("wallet-top-up-rule")).toHaveText(
    "We keep your balance at $100.00: once a day, and after any order that takes it lower, we top it back up from Visa ending in 4242. One top-up never charges more than $250.00.",
  );
  await expect(page.getByTestId("wallet-auto-reload-fee")).toHaveText("Card top-ups carry a 3% fee on top of the amount added: a $250.00 top-up charges $257.50.");
  await expect(page.getByTestId("wallet-auto-reload-mandate")).toHaveText(
    "By turning this on, you authorize Card Shellz to charge Visa ending in 4242, plus the 3% card fee, to keep your balance at $100.00 and to cover any order your balance cannot, up to $250.00 per charge.",
  );

  await page.getByRole("button", { name: "Turn on auto-reload" }).click();
  await expect(page.getByTestId("wallet-balance")).toBeVisible();
  expect(state.autoReloadWrites).toEqual([{ enabled: true, fundingMethodId: 10, minimumBalanceCents: 10_000, maxSingleReloadCents: 25_000, paymentHoldTimeoutMinutes: 2880,
    acknowledgedCardFeeBps: 300 }]);
  expect(state.codesSent).toEqual([]);
  await expect(page.getByTestId("wallet-auto-reload-summary")).toHaveText("Keeps your balance at $100.00 from Visa ending in 4242, plus the 3% card fee, up to $250.00 per top-up.");
  // An active vendor is not sent back to a page that no longer applies to them.
  await expect(page.getByRole("button", { name: "Back to onboarding" })).toHaveCount(0);
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

test("a ready wallet leads with the balance and adds funds from the card after one code", async ({ page }) => {
  const state = await setup(page, { cardStatus: "active", balanceCents: 4_250,
    autoReload: { autoReloadSettingId: 5, enabled: true, minimumBalanceCents: 5000, maxSingleReloadCents: 25_000, paymentHoldTimeoutMinutes: 2880, fundingMethodId: 10, updatedAt: STAMP } });
  await expect(page.getByTestId("wallet-setup")).toHaveCount(0);
  await expect(page.getByTestId("wallet-available")).toHaveText("$42.50");
  await expect(page.getByTestId("wallet-auto-reload-summary")).toHaveText("Keeps your balance at $50.00 from Visa ending in 4242, plus the 3% card fee, up to $250.00 per top-up.");

  await page.getByRole("button", { name: "Add funds" }).click();
  await checked(page, "Pay with", "Visa ending in 4242");
  await page.getByRole("radiogroup", { name: "Amount" }).getByRole("radio", { name: "$100", exact: true }).click();
  // The fee and the total are on screen before the vendor is sent to pay.
  await expect(page.getByTestId("wallet-funding-quote")).toHaveText("Card fee (3%): $3.00. Your card is charged $103.00 and $100.00 goes into your wallet.");
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

test("a ready wallet adds funds from the bank account for free, and shows where to send USDC once a deposit address is published", async ({ page }) => {
  const state = await setup(page, { cardStatus: "active", bankStatus: "active", balanceCents: 30_000, usdcDepositAddress: DEPOSIT_ADDRESS,
    proofs: { add_funding_method: LIVE_PROOF, wallet_funding_high_value: LIVE_PROOF },
    autoReload: { autoReloadSettingId: 5, enabled: true, minimumBalanceCents: 25_000, maxSingleReloadCents: 50_000, paymentHoldTimeoutMinutes: 2880, fundingMethodId: 30, updatedAt: STAMP } });
  await expect(page.getByTestId("wallet-auto-reload-summary")).toHaveText(
    "Keeps your balance at $250.00 from Chase ending in 2222, no fee, up to $500.00 per top-up. Visa ending in 4242 covers any order that cannot wait, plus the 3% card fee.",
  );

  await page.getByRole("button", { name: "Add funds" }).click();
  // The free rail is selected first; the card is offered with its fee; USDC is offered because an address is published.
  await checked(page, "Pay with", "Chase ending in 2222");
  await expect(page.getByRole("radiogroup", { name: "Pay with" }).getByRole("radio", { name: "Visa ending in 4242" })).toContainText("3% fee");
  await page.getByRole("radiogroup", { name: "Amount" }).getByRole("radio", { name: "$100", exact: true }).click();
  await expect(page.getByTestId("wallet-funding-quote")).toHaveText("No fee. $100.00 goes into your wallet once the bank transfer settles, usually within a few days.");

  await page.getByRole("radiogroup", { name: "Pay with" }).getByRole("radio", { name: "USDC on Base" }).click();
  const usdc = page.getByTestId("wallet-usdc-funding");
  await expect(usdc).toContainText("Register the wallet address you will send from");
  await expect(page.getByRole("button", { name: "Continue to payment" })).toHaveCount(0);
  await usdc.getByLabel("Wallet address you send from").fill("0x1234567890abcdef1234567890abcdef12345678");
  await usdc.getByRole("button", { name: "Save USDC address" }).click();
  expect(state.usdcRegistrations).toEqual([{ walletAddress: "0x1234567890abcdef1234567890abcdef12345678", displayLabel: "USDC on Base", isDefault: false }]);
  await expect(page.getByTestId("wallet-usdc-deposit-address")).toHaveText(DEPOSIT_ADDRESS);
  await expect(usdc).toContainText("Sending from 0x1234...5678");

  // Back to the bank account: the amount chosen earlier goes through as a bank transfer.
  await page.getByRole("radiogroup", { name: "Pay with" }).getByRole("radio", { name: "Chase ending in 2222" }).click();
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await expect(page.getByText("Payment received.")).toBeVisible();
  expect(state.fundingSessions).toEqual([{ fundingMethodId: 30, amountCents: 10_000, returnTo: HARNESS_PATH }]);
  expect(state.codesSent).toEqual([]);
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
