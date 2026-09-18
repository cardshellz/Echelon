import { expect, test, type Page } from "playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Playwright's serviceWorkers:block init script reads navigator.serviceWorker in
// every frame, which throws in an opaque sandbox. This local-only harness
// registers no workers.
test.use({ serviceWorkers: "allow" });

const HARNESS_PATH = "/__wallet-test";
const STAMP = "2026-09-15T00:00:00.000Z";
const LATER = "2026-09-16T00:00:00.000Z";
const DEPOSIT_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const LIVE_PROOF = { method: "email_mfa", verifiedAt: STAMP, expiresAt: "2999-01-01T00:00:00.000Z" };
const ALL_PROOFS = { add_funding_method: LIVE_PROOF, wallet_funding_high_value: LIVE_PROOF, remove_funding_method: LIVE_PROOF };
/** Where step screenshots go when WALLET_SHOTS_DIR is set (never in CI). */
const SHOTS_DIR = process.env.WALLET_SHOTS_DIR ?? null;
const PUT_KEYS = ["enabled", "fundingMethodId", "backstopFundingMethodId", "minimumBalanceCents", "maxSingleReloadCents", "paymentHoldTimeoutMinutes", "acknowledgedCardFeeBps"].sort();

interface StubMethod {
  fundingMethodId: number;
  rail: "stripe_card" | "stripe_ach" | "usdc_base";
  status: "active" | "pending" | "archived";
  displayLabel: string;
  isDefault: boolean;
  usdcWalletAddress: string | null;
  createdAt: string;
  updatedAt: string;
  card?: { brand: string; last4: string; expMonth: number; expYear: number };
  bankAccount?: { bankName: string; last4: string; accountType: string };
  /** When set, served as the §4.1 roles block instead of letting the client derive them. */
  roles?: { isAutoReloadSource: boolean; isBackupCard: boolean; chargeable: boolean };
  /** Reads left before the webhook "activates" a pending row. */
  activatesAfterReads?: number;
}

const CARD: StubMethod = { fundingMethodId: 10, rail: "stripe_card", status: "active", displayLabel: "Visa ending in 4242", isDefault: true, usdcWalletAddress: null, createdAt: STAMP, updatedAt: STAMP, card: { brand: "Visa", last4: "4242", expMonth: 12, expYear: 2027 } };
const BANK: StubMethod = { fundingMethodId: 30, rail: "stripe_ach", status: "active", displayLabel: "Chase ending in 1234", isDefault: false, usdcWalletAddress: null, createdAt: STAMP, updatedAt: STAMP, bankAccount: { bankName: "Chase", last4: "1234", accountType: "checking" } };

interface StubState {
  methods: StubMethod[];
  usdcDepositAddress: string | null;
  autoReload: Record<string, unknown> | null;
  balanceCents: number;
  pendingCents: number;
  ledger: Record<string, unknown>[];
  cardFundingFeeBps: number;
  limits: Record<string, number> | null;
  proofs: Record<string, { method: string; verifiedAt: string; expiresAt: string }>;
  failChallenge: boolean;
  deleteRefusal: string | null;
  detachOutcome: string;
  putRefusalOnce: { status: number; code: string; context?: Record<string, unknown> } | null;
  vendorStatus: "onboarding" | "active" | "paused" | "closed";
  vendorStandingReason: "card_declined" | "funding_returned" | null;
  walletReads: number;
  nextCardId: number;
  nextBankId: number;
  setupSessions: Record<string, unknown>[];
  autoReloadWrites: Record<string, unknown>[];
  fundingSessions: Record<string, unknown>[];
  usdcRegistrations: Record<string, unknown>[];
  deletes: string[];
  bodies: string[];
  codesSent: string[];
  unexpected: string[];
  errors: string[];
}

function doneAutoReload(overrides: Record<string, unknown> = {}) {
  return { autoReloadSettingId: 5, enabled: true, minimumBalanceCents: 25_000, maxSingleReloadCents: 50_000, paymentHoldTimeoutMinutes: 2880, fundingMethodId: 30, updatedAt: STAMP,
    backstopFundingMethodId: 10, acknowledgedCardFeeBps: 300, acknowledgedAt: STAMP, ...overrides };
}

function onboardingJson(state: StubState) {
  return {
    vendor: { vendorId: 1, memberId: "m-1", businessName: "Vendor", contactName: null, email: "vendor@example.com", phone: null,
      status: state.vendorStatus, entitlementStatus: "active", membershipGraceEndsAt: null, includedStoreConnections: 1,
      standingReason: state.vendorStandingReason, pausedAt: state.vendorStatus === "paused" ? STAMP : null },
    entitlement: { memberId: "m-1", cardShellzEmail: "vendor@example.com", status: "active", planId: "ops", planName: "Ops", subscriptionId: "sub-1", includesDropship: true, reasonCode: "active" },
    storeConnections: { activeCount: 1, connectedCount: 1, launchReadyConnectedCount: 1, credentialAttentionCount: 0, needsAttentionCount: 0, totalCount: 1, includedLimit: 1, canConnectStore: false },
    catalog: { adminExposureRuleCount: 1, vendorSelectionRuleCount: 1, adminCatalogAvailable: true, hasVendorSelection: true },
    wallet: { availableBalanceCents: state.balanceCents, pendingBalanceCents: state.pendingCents, activeFundingMethodCount: 1, activeStripeFundingMethodCount: 1, activeStripeCardFundingMethodCount: 1, activeUsdcBaseFundingMethodCount: 0,
      autoReloadEnabled: true, autoReloadFundingMethodId: 10, autoReloadFundingMethodActive: true, autoReloadFundingMethodReady: true, autoReloadFundingMethodIsCard: true },
    steps: [],
  };
}

function walletJson(state: StubState) {
  const fundingMethods = state.methods.map(({ activatesAfterReads: _ignored, ...method }) => method);
  return { wallet: {
    account: { walletAccountId: 1, vendorId: 1, availableBalanceCents: state.balanceCents, pendingBalanceCents: state.pendingCents, currency: "USD", status: "active", createdAt: STAMP, updatedAt: STAMP },
    autoReload: state.autoReload, fundingMethods, recentLedger: state.ledger, cardFundingFeeBps: state.cardFundingFeeBps, usdcBaseDepositAddress: state.usdcDepositAddress,
    ...(state.limits ? { limits: state.limits } : {}) } };
}

async function setup(page: Page, initial: Partial<StubState> = {}, path = HARNESS_PATH) {
  const state: StubState = { methods: [], usdcDepositAddress: null, autoReload: null, balanceCents: 0, pendingCents: 0, ledger: [], cardFundingFeeBps: 300, limits: null,
    proofs: {}, failChallenge: false, deleteRefusal: null, detachOutcome: "detached", putRefusalOnce: null, vendorStatus: "onboarding", vendorStandingReason: null,
    walletReads: 0, nextCardId: 10, nextBankId: 30, setupSessions: [], autoReloadWrites: [], fundingSessions: [], usdcRegistrations: [], deletes: [], bodies: [],
    codesSent: [], unexpected: [], errors: [], ...initial };
  // Fixtures are copied so a journey that archives or activates a row never leaks into the next one; new ids follow the fixtures.
  state.methods = state.methods.map((row) => ({ ...row }));
  for (const row of state.methods) {
    if (row.rail === "stripe_card") state.nextCardId = Math.max(state.nextCardId, row.fundingMethodId + 1);
    if (row.rail === "stripe_ach") state.nextBankId = Math.max(state.nextBankId, row.fundingMethodId + 1);
  }
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const rawBody = route.request().postData();
    if (rawBody) state.bodies.push(rawBody);
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
    if (url.pathname === "/api/dropship/onboarding/state" && method === "GET") return route.fulfill({ json: onboardingJson(state) });
    if (url.pathname === "/api/dropship/wallet" && method === "GET") {
      state.walletReads += 1;
      // The webhook stands in: a pending row activates a few reads after Stripe returns.
      for (const row of state.methods) {
        if (row.status === "pending" && row.activatesAfterReads !== undefined) {
          row.activatesAfterReads -= 1;
          if (row.activatesAfterReads <= 0) { row.status = "active"; row.updatedAt = LATER; }
        }
      }
      return route.fulfill({ json: walletJson(state) });
    }
    if (url.pathname === "/api/dropship/wallet/funding-methods/stripe/setup-session" && method === "POST") {
      const body = route.request().postDataJSON() as { rail: "stripe_card" | "stripe_ach" };
      state.setupSessions.push(body);
      const id = body.rail === "stripe_ach" ? state.nextBankId++ : state.nextCardId++;
      const label = body.rail === "stripe_ach" ? `Chase ending in ${id === 30 ? "1234" : "5678"}` : `Visa ending in ${id === 10 ? "4242" : "9999"}`;
      state.methods.push({ fundingMethodId: id, rail: body.rail, status: "pending", displayLabel: label, isDefault: state.methods.every((row) => row.rail !== body.rail), usdcWalletAddress: null,
        createdAt: LATER, updatedAt: LATER, activatesAfterReads: 3,
        ...(body.rail === "stripe_card" ? { card: { brand: "Visa", last4: id === 10 ? "4242" : "9999", expMonth: 12, expYear: 2027 } } : { bankAccount: { bankName: "Chase", last4: id === 30 ? "1234" : "5678", accountType: "checking" } }) });
      return route.fulfill({ json: { setupSession: { checkoutUrl: `${path}?funding_setup=success`, providerSessionId: "cs_1", expiresAt: "2999-01-01T00:00:00.000Z" } } });
    }
    if (url.pathname === "/api/dropship/wallet/auto-reload" && method === "PUT") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.autoReloadWrites.push(body);
      if (state.putRefusalOnce) {
        const refusal = state.putRefusalOnce;
        state.putRefusalOnce = null;
        return route.fulfill({ status: refusal.status, json: { error: { code: refusal.code, message: "Refused by the stub.", context: refusal.context ?? null } } });
      }
      // The stub serves the D4/D7 fields the real server will store: the designated backup card and the acknowledgement.
      state.autoReload = { autoReloadSettingId: 5, updatedAt: LATER, ...body, acknowledgedAt: body.acknowledgedCardFeeBps === null ? null : LATER };
      return route.fulfill({ json: { autoReload: state.autoReload, idempotentReplay: false } });
    }
    if (url.pathname === "/api/dropship/wallet/funding/stripe/checkout-session" && method === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.fundingSessions.push(body);
      const amountCents = Number(body.amountCents);
      const paidByCard = state.methods.find((row) => row.fundingMethodId === Number(body.fundingMethodId))?.rail === "stripe_card";
      const cardFeeCents = paidByCard ? Math.floor((amountCents * 300 + 5_000) / 10_000) : 0;
      // The return moves the ledger mark: a card payment settles at once, a bank transfer is pending.
      state.ledger.unshift({ ledgerEntryId: state.ledger.length + 100, type: "funding", status: paidByCard ? "settled" : "pending", amountCents, currency: "USD",
        availableBalanceAfterCents: state.balanceCents + (paidByCard ? amountCents : 0), pendingBalanceAfterCents: state.pendingCents + (paidByCard ? 0 : amountCents),
        createdAt: LATER, settledAt: paidByCard ? LATER : null, metadata: { provider: "stripe" } });
      if (paidByCard) state.balanceCents += amountCents; else state.pendingCents += amountCents;
      return route.fulfill({ json: { fundingSession: { checkoutUrl: `${path}?wallet_funding=success`, providerSessionId: "cs_2", amountCents, cardFeeCents, chargedCents: amountCents + cardFeeCents, currency: "USD", expiresAt: "2999-01-01T00:00:00.000Z" } } });
    }
    if (url.pathname === "/api/dropship/wallet/funding-methods/usdc-base" && method === "POST") {
      const body = route.request().postDataJSON() as { walletAddress: string; displayLabel: string };
      state.usdcRegistrations.push(body);
      const fundingMethod: StubMethod = { fundingMethodId: 20, rail: "usdc_base", status: "active", displayLabel: body.displayLabel, isDefault: false, usdcWalletAddress: body.walletAddress, createdAt: LATER, updatedAt: LATER };
      state.methods.push(fundingMethod);
      return route.fulfill({ json: { fundingMethod, idempotentReplay: false } });
    }
    const deleteMatch = /^\/api\/dropship\/wallet\/funding-methods\/(\d+)$/.exec(url.pathname);
    if (deleteMatch && method === "DELETE") {
      state.deletes.push(url.pathname);
      if (state.deleteRefusal) return route.fulfill({ status: 409, json: { error: { code: state.deleteRefusal, message: "Refused by the stub.", context: { classification: "permanent" } } } });
      const row = state.methods.find((entry) => entry.fundingMethodId === Number(deleteMatch[1]));
      if (!row) return route.fulfill({ status: 404, json: { error: { code: "DROPSHIP_FUNDING_METHOD_NOT_FOUND", message: "Not found." } } });
      row.status = "archived";
      return route.fulfill({ json: { fundingMethod: row, idempotentReplay: false, providerDetach: state.detachOutcome } });
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

/** Every journey ends clean: no unexpected request, no page error, no daily cost or foreign key in any body, and every PUT carries exactly the contract's keys. */
function finish(state: StubState, dailyCostTyped: string | null = null) {
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
  const forbiddenValues = dailyCostTyped ? new Set<unknown>([dailyCostTyped, Number(dailyCostTyped), Math.round(Number(dailyCostTyped) * 100)]) : new Set<unknown>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) { expect(key).not.toMatch(/daily|cost/i); walk(nested); }
      return;
    }
    expect(forbiddenValues.has(value), `daily cost leaked: ${String(value)}`).toBe(false);
  };
  for (const body of state.bodies) walk(JSON.parse(body));
  for (const write of state.autoReloadWrites) expect(Object.keys(write).sort()).toEqual(PUT_KEYS);
}

async function enterCode(page: Page, code = "123456") {
  const prompt = page.getByTestId("wallet-verification");
  await expect(prompt).toBeVisible();
  await prompt.locator("input").first().fill(code);
  await prompt.getByRole("button", { name: "Continue" }).click();
}

function radio(page: Page, group: string, name: string) {
  return page.getByRole("radiogroup", { name: group }).getByRole("radio", { name, exact: true });
}

async function expectNoHorizontalScroll(page: Page) {
  const width = page.viewportSize()?.width ?? 1280;
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

async function shot(page: Page, name: string) {
  if (!SHOTS_DIR) return;
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS_DIR, `${test.info().project.name}-${name}.png`), fullPage: true });
}

/** Seed the vendor-scoped draft so a journey can start mid-flow, exactly as a redirect would find it. */
function seedDraft(page: Page, draft: Record<string, unknown>) {
  return page.addInitScript((value: string) => { window.sessionStorage.setItem("dropship-wallet-setup-draft:v1:1", value); }, JSON.stringify({ v: 1, seenIntro: true, sourceRail: null, sourceMethodId: null, floorCents: null, dailyCostCents: null, backupMethodId: null, pendingStripe: null, deposit: null, ...draft }));
}

test("bank vendor, end to end: intro, bank source, floor with guidance, backup card, one authorization, then the deposit step — with one emailed code", async ({ page }) => {
  const state = await setup(page, { usdcDepositAddress: DEPOSIT_ADDRESS });
  const intro = page.getByTestId("wallet-step-intro");
  await expect(intro.getByRole("heading", { name: "How your wallet works" })).toBeVisible();
  await expect(intro).toContainText("return fee");
  await expect(intro).toContainText("If a top-up fails for any other reason, we email you.");
  await expect(intro.getByTestId("wallet-intro-verification-note")).toContainText("(a 6-digit code by email)");
  await expect(page.getByTestId("wallet-impact")).toHaveCount(0);
  await expect(page.getByTestId("wallet-balance")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await shot(page, "01-intro");
  await intro.getByRole("button", { name: "Set up my wallet" }).click();

  // Step 2: nothing pre-selected; the recommendation is a badge, not a choice.
  const source = page.getByTestId("wallet-step-source");
  await expect(source.getByRole("heading", { name: "Choose your top-up source" })).toBeVisible();
  await expect(source.getByRole("button", { name: "Continue" })).toBeDisabled();
  await expect(source.getByTestId("wallet-usdc-note")).toContainText("can never be your top-up source");
  await shot(page, "02-source-empty");
  await radio(page, "Top up from", "Bank account").click();
  await expect(source.getByTestId("wallet-impact")).toContainText("Routine top-ups are free");
  await source.getByRole("button", { name: "Add a bank account" }).click();
  await expect(source.getByTestId("wallet-verification")).toBeVisible();
  await expect(source.getByRole("status").filter({ hasText: "6-digit code" })).toBeVisible();
  expect(state.codesSent).toEqual(["add_funding_method"]);
  await shot(page, "02-source-code");
  await enterCode(page);
  // Stripe's hosted page is stood in for by a same-origin return; the webhook by a few reads.
  await expect(page.getByTestId("wallet-bank-confirmation")).toContainText("Confirming your bank account with Stripe");
  expect(state.setupSessions).toEqual([{ rail: "stripe_ach", returnTo: HARNESS_PATH }]);
  expect(new URL(page.url()).search).toBe("");
  await expect(source.getByRole("status").filter({ hasText: "Bank account added: Chase ending in 1234." })).toBeVisible();
  await expect(radio(page, "Top up from", "Bank account")).toHaveAttribute("aria-checked", "true");
  await expect(source).toContainText("Chase ending in 1234 · checking");
  await expectNoHorizontalScroll(page);
  await shot(page, "02-source-bank-added");
  await source.getByRole("button", { name: "Continue" }).click();

  // Step 3: guidance follows the daily cost, which never leaves the browser.
  const floor = page.getByTestId("wallet-step-floor");
  await expect(floor.getByRole("heading", { name: "Set your floor" })).toBeVisible();
  await expect(radio(page, "Keep my balance at", "$250")).toContainText("Default");
  await shot(page, "03-floor-default");
  await page.getByTestId("wallet-daily-cost").fill("20");
  await expect(floor.getByTestId("wallet-floor-recommendation")).toContainText("we suggest a floor of $200");
  await expect(radio(page, "Keep my balance at", "Recommended $200")).toHaveAttribute("aria-checked", "true");
  await expect(radio(page, "Keep my balance at", "$250")).toContainText("≈ 12 days");
  await radio(page, "Keep my balance at", "$250").click();
  await expect(floor.getByTestId("wallet-floor-verdict")).toContainText("Keeps up");
  await expect(floor.getByTestId("wallet-guidance-fee")).toContainText("about $0 a month at $600 of orders — at most 3% of what actually goes on the card, $18 if all $600 did");
  await expect(floor.getByTestId("wallet-guidance-parked")).toContainText("Routine top-ups keep up to $250");
  await expect(floor.getByTestId("wallet-guidance-activation")).toContainText("$250 from Chase ending in 1234");
  await expect(floor.getByTestId("wallet-guidance-activation")).toContainText("first daily check after you activate");
  await expect(floor.getByTestId("wallet-floor-limit-note")).toContainText("$500 (2 × your floor)");
  await expect(floor.getByTestId("wallet-floor-limit-note")).toContainText("2 hours");
  await expectNoHorizontalScroll(page);
  await shot(page, "03-floor-guidance");
  await floor.getByRole("button", { name: "Continue" }).click();

  // Step 4: the proof from step 2 is still live, so no second code.
  const backup = page.getByTestId("wallet-step-backup");
  await expect(backup.getByRole("heading", { name: "Your backup card" })).toBeVisible();
  await expect(backup.getByTestId("wallet-card-fee-note")).toHaveText("Card charges carry a 3% fee on top of the amount added. Bank accounts and USDC carry no fee.");
  await shot(page, "04-backup-empty");
  await backup.getByRole("button", { name: "Add a card" }).click();
  await expect(page.getByTestId("wallet-card-confirmation")).toContainText("Confirming your card with Stripe");
  expect(state.codesSent).toEqual(["add_funding_method"]);
  await expect(backup).toContainText("Visa ending in 4242 · expires 12/27 will be your backup card.");
  await expect(backup.getByTestId("wallet-impact")).toContainText("only for the shortfall plus the 3% fee");
  await shot(page, "04-backup-added");
  await backup.getByRole("button", { name: "Continue" }).click();

  // Step 5: the whole mandate, one button, no checkbox.
  const review = page.getByTestId("wallet-step-review");
  await expect(review.getByRole("heading", { name: "Review and turn on auto-reload" })).toBeVisible();
  const summary = review.getByTestId("wallet-review-summary");
  await expect(summary).toContainText("Chase ending in 1234 (bank account, no fee)");
  await expect(summary).toContainText("$250 — about 12 days at $20 a day");
  await expect(summary).toContainText("Visa ending in 4242");
  await expect(summary).toContainText("$500 — 2 × your floor");
  await expect(summary).toContainText("48 hours — the default");
  const mandate = review.getByTestId("wallet-mandate");
  for (const phrase of ["$250", "$500", "shortfall", "up to the single top-up limit", "48 hours", "2 hours", "before it lands",
    "If a return fee has taken your balance below zero, the shortfall includes that amount.", "Adding money by card now avoids that", "for automatic top-ups and covers", "first daily check after you activate"]) {
    await expect(mandate).toContainText(phrase);
  }
  await expect(review.getByTestId("wallet-plan-sentence")).toContainText("you keep $250 in your wallet, refilled from your bank for free");
  await expect(review.getByTestId("wallet-activation-quote")).toContainText("$250 bank transfer");
  await expect(review.getByTestId("wallet-fee-acknowledgement-line")).toContainText("records that you agree to the 3% fee");
  await expect(review.getByRole("checkbox")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await shot(page, "05-review");
  await review.getByRole("button", { name: "Agree and turn on auto-reload" }).click();
  expect(state.autoReloadWrites).toEqual([{ enabled: true, fundingMethodId: 30, backstopFundingMethodId: 10, minimumBalanceCents: 25_000, maxSingleReloadCents: 50_000, paymentHoldTimeoutMinutes: 2880, acknowledgedCardFeeBps: 300 }]);

  // Step 6: recommended, never a gate.
  const deposit = page.getByTestId("wallet-step-deposit");
  await expect(deposit.getByRole("heading", { name: "Add money now (recommended)" })).toBeVisible();
  await expect(deposit).toContainText("first daily check after you activate");
  await expect(radio(page, "Amount", "$250")).toHaveAttribute("aria-checked", "true");
  await expect(deposit.getByTestId("wallet-deposit-quote")).toContainText("once the bank transfer settles");
  await expect(deposit).toContainText("we may ask you to confirm it is you again");
  await expectNoHorizontalScroll(page);
  await shot(page, "06-deposit");
  await deposit.getByRole("button", { name: "Not now" }).click();

  const manage = page.getByTestId("wallet-manage");
  await expect(manage).toBeVisible();
  await expect(manage.getByTestId("wallet-plan-source")).toContainText("Chase ending in 1234 · bank account · no fee");
  await expect(manage.getByTestId("wallet-plan-floor")).toContainText("$250 — topped up once a day");
  await expect(manage.getByTestId("wallet-plan-floor")).toContainText("≈ 12 days at $20 a day");
  await expect(manage.getByTestId("wallet-plan-backup-card")).toContainText("Visa ending in 4242 · expires 12/27");
  await expect(manage.getByTestId("wallet-plan-limits")).toContainText("Single top-up limit $500 · hold time 48 hours");
  await expect(manage.getByTestId("wallet-plan-authorization")).toContainText("at a 3% card fee");
  await expect(manage.getByTestId("wallet-deposit-callout")).toBeVisible();
  await expect(manage.getByRole("button", { name: "Back to onboarding" })).toBeVisible();
  await expect(manage.getByTestId("wallet-auto-reload-off")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot(page, "07-manage");
  expect(state.codesSent).toEqual(["add_funding_method"]);
  finish(state, "20");
});

test("card vendor: steps 4 and 6 are satisfied rows, the limit is not a false multiple, and the card is both source and backup", async ({ page }) => {
  const state = await setup(page, { proofs: ALL_PROOFS });
  await page.getByRole("button", { name: "Set up my wallet" }).click();
  const source = page.getByTestId("wallet-step-source");
  await radio(page, "Top up from", "Card").click();
  await source.getByRole("button", { name: "Add a card" }).click();
  await expect(page.getByTestId("wallet-card-confirmation")).toBeVisible();
  await expect(source.getByRole("status").filter({ hasText: "Card added: Visa ending in 4242." })).toBeVisible();
  await expect(source.getByTestId("wallet-impact")).toContainText("Every top-up costs 3%");
  await expect(source.getByTestId("wallet-impact")).toContainText("Your card is also your backup card");
  await shot(page, "card-02-source");
  await source.getByRole("button", { name: "Continue" }).click();

  const floor = page.getByTestId("wallet-step-floor");
  await expect(radio(page, "Keep my balance at", "$100")).toHaveAttribute("aria-checked", "true");
  await expect(radio(page, "Keep my balance at", "$100")).toContainText("Default");
  await expect(floor).toContainText("$3 at $100, $30 at $1,000");
  await expect(floor.getByTestId("wallet-guidance-activation")).toContainText("$103");
  await expect(floor.getByTestId("wallet-floor-limit-note")).toContainText("Single top-up limit: $250 (at least 2 × your floor, rounded up to the next preset)");
  await shot(page, "card-03-floor");
  await floor.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByTestId("wallet-step-backup")).toHaveCount(0);
  const steps = page.getByTestId("wallet-step-indicator").first();
  await expect(steps).toContainText("Backup card · Visa ending in 4242 — the card you top up with is also your backup card");
  await expect(steps).toContainText("First top-up ·");
  await expect(steps).toContainText("$103");
  const review = page.getByTestId("wallet-step-review");
  await expect(review.getByTestId("wallet-review-summary")).toContainText("$250 — at least 2 × your floor, rounded up to the next preset");
  await expect(review.getByTestId("wallet-review-summary")).toContainText("Visa ending in 4242 — also your top-up source");
  await expect(review.getByTestId("wallet-mandate")).toContainText("or a bank transfer you started is returned before it lands");
  await expect(review.getByTestId("wallet-mandate")).toContainText("$100 + $3 = $103");
  await expect(page.getByText("(2 × your floor)")).toHaveCount(0);
  await shot(page, "card-05-review");
  await review.getByRole("button", { name: "Agree and turn on auto-reload" }).click();
  expect(state.autoReloadWrites).toEqual([{ enabled: true, fundingMethodId: 10, backstopFundingMethodId: 10, minimumBalanceCents: 10_000, maxSingleReloadCents: 25_000, paymentHoldTimeoutMinutes: 2880, acknowledgedCardFeeBps: 300 }]);
  await expect(page.getByTestId("wallet-manage")).toBeVisible();
  await expect(page.getByTestId("wallet-step-deposit")).toHaveCount(0);
  await expect(page.getByTestId("wallet-plan").getByRole("status")).toContainText("Auto-reload is on.");
  await expect(page.getByTestId("wallet-plan-backup-card")).toContainText("The same card you top up with");
  await expect(page.getByTestId("wallet-plan-backup-card").getByRole("button", { name: "Change" })).toHaveCount(0);
  await shot(page, "card-07-manage");
  expect(state.codesSent).toEqual([]);
  finish(state);
});

test("a cancelled Stripe return at step 4 saves nothing and says so next to the step", async ({ page }) => {
  await seedDraft(page, { sourceRail: "stripe_ach", sourceMethodId: 30, floorCents: 25_000,
    pendingStripe: { rail: "stripe_card", purpose: "backup", knownMethods: [{ id: 30, updatedAt: STAMP }], ledgerMark: null, startedAt: STAMP, expiresAt: "2999-01-01T00:00:00.000Z" } });
  const state = await setup(page, { methods: [BANK], proofs: ALL_PROOFS }, `${HARNESS_PATH}?funding_setup=cancelled`);
  const backup = page.getByTestId("wallet-step-backup");
  await expect(backup.getByRole("status").filter({ hasText: "Nothing was saved. You are back at step 4." })).toBeVisible();
  await expect(backup.getByRole("button", { name: "Add a card" })).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
  await shot(page, "03b-cancelled-return");
  // The draft's other choices stand and the pending redirect is gone.
  const draft = JSON.parse(await page.evaluate(() => window.sessionStorage.getItem("dropship-wallet-setup-draft:v1:1") ?? "{}")) as Record<string, unknown>;
  expect(draft.pendingStripe).toBeNull();
  expect(draft.floorCents).toBe(25_000);
  expect(state.autoReloadWrites).toEqual([]);
  expect(state.setupSessions).toEqual([]);
  finish(state);
});

test("manage: changing the floor lifts the limit with it and saves the whole row at the recorded rate", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "active", methods: [CARD, BANK], autoReload: doneAutoReload(), balanceCents: 30_000, proofs: ALL_PROOFS });
  const plan = page.getByTestId("wallet-plan");
  await expect(page.getByTestId("wallet-available")).toHaveText("$300.00");
  await expect(page.getByTestId("wallet-step-indicator")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back to onboarding" })).toHaveCount(0);
  await expect(page.getByTestId("wallet-auto-reload-off")).toHaveCount(0);
  await shot(page, "manage-01-plan");
  await plan.getByTestId("wallet-plan-floor").getByRole("button", { name: "Change" }).click();
  await radio(page, "Keep my balance at", "$1,000").click();
  await expect(plan).toContainText("Single top-up limit lifted to $2,500 (at least 2 × your floor, rounded up to the next preset)");
  await expectNoHorizontalScroll(page);
  await shot(page, "manage-02-floor-editor");
  await plan.getByRole("button", { name: "Save", exact: true }).click();
  expect(state.autoReloadWrites).toEqual([{ enabled: true, fundingMethodId: 30, backstopFundingMethodId: 10, minimumBalanceCents: 100_000, maxSingleReloadCents: 250_000, paymentHoldTimeoutMinutes: 2880, acknowledgedCardFeeBps: 300 }]);
  await expect(plan.getByTestId("wallet-plan-floor")).toContainText("$1,000 — topped up once a day");
  await expect(plan.getByTestId("wallet-plan-limits")).toContainText("Single top-up limit $2,500 · hold time 48 hours");

  // The Limits editor speaks from the served warning window, never a constant.
  await plan.getByTestId("wallet-plan-limits").getByRole("button", { name: "Change" }).click();
  const limits = page.getByTestId("wallet-limits-editor");
  await expect(limits).toContainText("for orders held from now on");
  await expect(limits).toContainText("We email you 2 hours before.");
  await radio(page, "Single top-up limit", "$5,000").click();
  await radio(page, "Hold time", "72 hours").click();
  await shot(page, "manage-03-limits-editor");
  await limits.getByRole("button", { name: "Save", exact: true }).click();
  expect(state.autoReloadWrites[1]).toMatchObject({ maxSingleReloadCents: 500_000, paymentHoldTimeoutMinutes: 4320, minimumBalanceCents: 100_000 });
  await expect(plan.getByTestId("wallet-plan-limits")).toContainText("Single top-up limit $5,000 · hold time 72 hours");
  finish(state);
});

test("manage: replacing the backup card is add, designate, then remove the old one — and each Remove is pre-disabled with the server's reason", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "active", methods: [CARD, BANK], autoReload: doneAutoReload(), proofs: { add_funding_method: LIVE_PROOF, wallet_funding_high_value: LIVE_PROOF } });
  const methods = page.getByTestId("wallet-methods");
  const oldCard = methods.getByTestId("wallet-method-10");
  await expect(oldCard).toContainText("Backup card");
  await expect(oldCard.getByTestId("wallet-method-remove")).toBeDisabled();
  await expect(oldCard).toContainText("This is your backup card — choose another backup card first, then remove this one.");
  await expect(methods.getByTestId("wallet-method-30")).toContainText("This is your top-up source — choose another source first, then remove this one.");
  await expect(methods).toContainText("To replace a card: add the new one, make it the backup card");
  await shot(page, "manage-04-methods");

  await methods.getByRole("button", { name: "Add a card" }).click();
  const offer = page.getByTestId("wallet-new-method-offer");
  await expect(offer).toContainText("Visa ending in 9999 added.");
  await expect(page.getByTestId("wallet-funding-return")).toContainText("Card added: Visa ending in 9999.");
  await shot(page, "manage-05-new-card-offer");
  await offer.getByRole("button", { name: "Use as backup card" }).click();
  expect(state.autoReloadWrites).toEqual([{ enabled: true, fundingMethodId: 30, backstopFundingMethodId: 11, minimumBalanceCents: 25_000, maxSingleReloadCents: 50_000, paymentHoldTimeoutMinutes: 2880, acknowledgedCardFeeBps: 300 }]);
  await expect(page.getByTestId("wallet-plan-backup-card")).toContainText("Visa ending in 9999");
  await expect(methods.getByTestId("wallet-method-11")).toContainText("Backup card");
  await expect(oldCard.getByTestId("wallet-method-remove")).toBeEnabled();

  await oldCard.getByTestId("wallet-method-remove").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Remove Visa ending in 4242?");
  await expect(dialog).toContainText("We also ask Stripe to remove it. Card Shellz will no longer charge it.");
  // The dialog fits the viewport on both projects (390 px on mobile); measured once its enter animation has finished.
  await dialog.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  if (SHOTS_DIR) await page.screenshot({ path: resolve(SHOTS_DIR, `${test.info().project.name}-manage-06-remove-dialog.png`), fullPage: false });
  await dialog.getByRole("button", { name: "Remove" }).click();
  // Removal needs its own proof.
  await expect(methods.getByTestId("wallet-verification")).toBeVisible();
  expect(state.codesSent).toEqual(["remove_funding_method"]);
  await enterCode(page);
  expect(state.deletes).toEqual(["/api/dropship/wallet/funding-methods/10"]);
  await expect(methods.getByRole("status").filter({ hasText: "Removed. Card Shellz will no longer charge it." })).toBeVisible();
  await expect(methods.getByTestId("wallet-method-10")).toHaveCount(0);
  await methods.getByRole("button", { name: "Show removed" }).click();
  await expect(methods).toContainText("Visa ending in 4242 · Removed");
  await expect(page.getByText(/has been notified/)).toHaveCount(0);
  await shot(page, "manage-07-after-remove");
  finish(state);
});

test("manage: a server refusal to remove a method in a role renders the exact sentence, and an unconfirmed detach says so", async ({ page }) => {
  // The stub serves roles that let the click through, then refuses like the server would for a method still in a role.
  const noRoles = { isAutoReloadSource: false, isBackupCard: false, chargeable: true };
  const state = await setup(page, { vendorStatus: "active", methods: [{ ...CARD, roles: noRoles }, { ...BANK, roles: { ...noRoles, chargeable: false } }], autoReload: doneAutoReload(), proofs: ALL_PROOFS, deleteRefusal: "DROPSHIP_FUNDING_METHOD_IS_BACKUP_CARD" });
  const methods = page.getByTestId("wallet-methods");
  await methods.getByTestId("wallet-method-10").getByTestId("wallet-method-remove").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(methods.getByRole("alert")).toHaveText("This is your backup card. Choose another backup card first, then remove this one.");
  state.deleteRefusal = "DROPSHIP_FUNDING_METHOD_IS_AUTO_RELOAD_SOURCE";
  await methods.getByTestId("wallet-method-30").getByTestId("wallet-method-remove").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(methods.getByRole("alert")).toHaveText("This is your top-up source. Choose another source first, then remove this one.");
  await shot(page, "manage-08-remove-refused");
  state.deleteRefusal = null;
  state.detachOutcome = "pending";
  await methods.getByTestId("wallet-method-10").getByTestId("wallet-method-remove").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  const removal = methods.getByRole("status");
  await expect(removal).toContainText("Removed from your wallet. Card Shellz will no longer charge it. Stripe has not confirmed the removal yet; if it still shows on Stripe's page later, contact Card Shellz support.");
  await expect(removal).not.toContainText("can no longer be charged");
  await expect(page.getByText(/has been notified/)).toHaveCount(0);
  // The backup card is gone, so the role warning names the gap without naming the card.
  await expect(page.getByTestId("wallet-role-warning")).toContainText("Backup card needed");
  await expect(page.getByTestId("wallet-role-warning")).not.toContainText("ending in");
  expect(state.deletes).toHaveLength(3);
  finish(state);
});

test("manage: adding money by card, bank or USDC quotes the fee honestly and returns with the right banner", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "active", methods: [CARD, BANK], autoReload: doneAutoReload(), balanceCents: 4_250, usdcDepositAddress: DEPOSIT_ADDRESS, proofs: { add_funding_method: LIVE_PROOF, remove_funding_method: LIVE_PROOF } });
  await expect(page.getByTestId("wallet-available")).toHaveText("$42.50");
  await page.getByRole("button", { name: "Add money" }).click();
  const panel = page.getByTestId("wallet-add-money");
  await expect(radio(page, "Pay with", "Bank account (no fee)")).toHaveAttribute("aria-checked", "true");
  await radio(page, "Amount", "$100").click();
  await expect(panel.getByTestId("wallet-funding-quote")).toHaveText("No fee. $100.00 goes into your wallet once the bank transfer settles — up to 5 business days (our assumption). It cannot pay orders until then.");
  await radio(page, "Pay with", "Card (3% fee)").click();
  await expect(panel.getByTestId("wallet-funding-quote")).toHaveText("Card fee (3%): $3.00. Your card is charged $103.00 and $100.00 goes into your wallet, available at once.");
  await expectNoHorizontalScroll(page);
  await shot(page, "manage-09-add-money-card");

  await radio(page, "Pay with", "USDC on Base").click();
  const usdc = page.getByTestId("wallet-usdc-funding");
  await expect(usdc.getByTestId("wallet-usdc-deposit-address")).toHaveText(DEPOSIT_ADDRESS);
  await expect(usdc).toContainText("A member of the Card Shellz team credits your wallet after confirming the transfer — this is not instant.");
  await expect(page.getByRole("button", { name: "Continue on Stripe" })).toHaveCount(0);
  await usdc.getByLabel("Wallet address you send from").fill("0x1234567890abcdef1234567890abcdef12345678");
  await usdc.getByRole("button", { name: "Save USDC address" }).click();
  expect(state.usdcRegistrations).toEqual([{ walletAddress: "0x1234567890abcdef1234567890abcdef12345678", displayLabel: "USDC on Base", isDefault: false }]);
  await expect(usdc).toContainText("Sending from USDC · 0x1234…5678");
  await shot(page, "manage-10-add-money-usdc");

  await radio(page, "Pay with", "Card (3% fee)").click();
  await radio(page, "Amount", "$100").click();
  await panel.getByRole("button", { name: "Continue on Stripe" }).click();
  await expect(page.getByTestId("wallet-balance").getByTestId("wallet-verification")).toBeVisible();
  expect(state.codesSent).toEqual(["wallet_funding_high_value"]);
  await enterCode(page);
  await expect(page.getByTestId("wallet-funding-return")).toContainText("Payment received. Your balance updates as soon as Stripe confirms it.");
  expect(state.fundingSessions).toEqual([{ fundingMethodId: 10, amountCents: 10_000, returnTo: HARNESS_PATH }]);
  await expect(page.getByTestId("wallet-available")).toHaveText("$142.50");
  await expect(page.getByTestId("wallet-activity")).toContainText("Money you added");
  expect(new URL(page.url()).search).toBe("");
  await shot(page, "manage-11-funding-return");

  // A bank transfer comes back as money on the way, with the one settlement phrase.
  await page.getByRole("button", { name: "Add money" }).click();
  await radio(page, "Amount", "$250").click();
  await panel.getByRole("button", { name: "Continue on Stripe" }).click();
  await expect(page.getByTestId("wallet-funding-return")).toContainText("Transfer started. It shows as on the way once Stripe confirms it");
  expect(state.fundingSessions[1]).toEqual({ fundingMethodId: 30, amountCents: 25_000, returnTo: HARNESS_PATH });
  await expect(page.getByTestId("wallet-pending")).toContainText("$250 on the way — a bank transfer takes up to 5 business days (our assumption) to land");
  await expect(page.getByText(/a few days/)).toHaveCount(0);
  finish(state);
});

test("a wrong code is rejected in place and can be retried; a failed code email is reported without saving anything", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Set up my wallet" }).click();
  const source = page.getByTestId("wallet-step-source");
  await radio(page, "Top up from", "Bank account").click();
  await source.getByRole("button", { name: "Add a bank account" }).click();
  await enterCode(page, "000000");
  await expect(source.getByRole("alert")).toContainText("That code is not right.");
  await expect(source.getByTestId("wallet-verification")).toBeVisible();
  expect(state.setupSessions).toEqual([]);
  await shot(page, "02-source-wrong-code");
  await source.getByTestId("wallet-verification").getByRole("button", { name: "Cancel" }).click();
  state.failChallenge = true;
  await source.getByRole("button", { name: "Add a bank account" }).click();
  await expect(source.getByRole("alert")).toHaveText("We could not send the code. Try again in a moment.");
  await expect(source.getByTestId("wallet-verification")).toHaveCount(0);
  expect(state.setupSessions).toEqual([]);
  finish(state);
});

test("a paused vendor sees the standing notice above everything with a control behind it, and no way to turn auto-reload off", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "paused", vendorStandingReason: "card_declined", methods: [CARD, BANK], autoReload: doneAutoReload(), proofs: ALL_PROOFS });
  const notice = page.getByTestId("wallet-vendor-standing-notice");
  await expect(notice).toContainText("Selling is paused");
  expect(await notice.boundingBox().then((box) => box?.y ?? 0)).toBeLessThan(await page.getByTestId("wallet-balance").boundingBox().then((box) => box?.y ?? 0));
  await notice.getByRole("button", { name: "Change backup card" }).click();
  await expect(page.getByTestId("wallet-step-backup")).toBeVisible();
  await expect(page.getByTestId("wallet-auto-reload-off")).toHaveCount(0);
  await expect(page.getByTestId("wallet-method-10").getByTestId("wallet-method-remove")).toBeDisabled();
  await shot(page, "manage-12-paused");
  finish(state);
});

test("a PUT refusal with a step recovery moves the flow back to that step with the alert inside it, and the retry succeeds", async ({ page }) => {
  await seedDraft(page, { sourceRail: "stripe_ach", sourceMethodId: 30, floorCents: 25_000, backupMethodId: 10 });
  const state = await setup(page, { methods: [CARD, BANK], proofs: ALL_PROOFS, putRefusalOnce: { status: 409, code: "DROPSHIP_BACKUP_CARD_EXPIRED", context: { expMonth: 1, expYear: 2026 } } });
  const review = page.getByTestId("wallet-step-review");
  await review.getByRole("button", { name: "Agree and turn on auto-reload" }).click();
  const backup = page.getByTestId("wallet-step-backup");
  await expect(backup.getByRole("alert")).toHaveText("That card has expired. Add a current card.");
  await shot(page, "04b-put-refusal");
  await backup.getByRole("button", { name: "Continue" }).click();
  await page.getByTestId("wallet-step-review").getByRole("button", { name: "Agree and turn on auto-reload" }).click();
  await expect(page.getByTestId("wallet-step-deposit")).toBeVisible();
  expect(state.autoReloadWrites).toHaveLength(2);
  finish(state);
});
