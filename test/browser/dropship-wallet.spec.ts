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
/** The vendor's own deposit address (funding design phase 6), in its EIP-55 form. */
const OWN_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const WATCHED_USDC = { offered: true, watched: true, chainId: 8453, tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", minConfirmations: 6, settleTag: "safe", address: null as Record<string, unknown> | null };
const LIVE_PROOF = { method: "email_mfa", verifiedAt: STAMP, expiresAt: "2999-01-01T00:00:00.000Z" };
const ALL_PROOFS = { add_funding_method: LIVE_PROOF, wallet_funding_high_value: LIVE_PROOF, remove_funding_method: LIVE_PROOF };
/** Where step screenshots go when WALLET_SHOTS_DIR is set (never in CI). */
const SHOTS_DIR = process.env.WALLET_SHOTS_DIR ?? null;
const PUT_KEYS = ["enabled", "fundingMethodId", "backstopFundingMethodId", "minimumBalanceCents", "topUpAmountCents", "paymentHoldTimeoutMinutes", "acknowledgedCardFeeBps"].sort();

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
/** A card already on the wallet before this flow existed — the case the intro used to skip. */
const SAVED_CARD: StubMethod = { fundingMethodId: 12, rail: "stripe_card", status: "active", displayLabel: "Amex ending in 6800", isDefault: true, usdcWalletAddress: null, createdAt: STAMP, updatedAt: STAMP, card: { brand: "Amex", last4: "6800", expMonth: 12, expYear: 2028 } };

interface StubState {
  methods: StubMethod[];
  /** Tests asserting the pending UI release the simulated webhook explicitly. */
  holdSetupConfirmation: boolean;
  usdcDepositAddress: string | null;
  /** The served deposit position (funding design phase 6); null models a server one release behind. */
  usdcDeposit: Record<string, unknown> | null;
  autoReload: Record<string, unknown> | null;
  balanceCents: number;
  pendingCents: number;
  ledger: Record<string, unknown>[];
  cardFundingFeeBps: number;
  limits: Record<string, number> | null;
  /** The server's listing tier decision; null models a server that does not serve it yet. */
  listingTiers: Record<string, unknown> | null;
  advance: Record<string, unknown> | null;
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
  usdcAddressRequests: number;
  deletes: string[];
  bodies: string[];
  codesSent: string[];
  unexpected: string[];
  errors: string[];
}

function doneAutoReload(overrides: Record<string, unknown> = {}) {
  return { autoReloadSettingId: 5, enabled: true, minimumBalanceCents: 25_000, maxSingleReloadCents: 50_000, topUpAmountCents: null, paymentHoldTimeoutMinutes: 2880, fundingMethodId: 30, updatedAt: STAMP,
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
    ...(state.usdcDeposit ? { usdcDeposit: state.usdcDeposit } : {}),
    ...(state.limits ? { limits: state.limits } : {}),
    ...(state.listingTiers ? { listingTiers: state.listingTiers } : {}),
    ...(state.advance ? { advance: state.advance } : {}) } };
}

/** The bank account (method 30) qualifies with $400 on the way; the card never appears. */
function advanceJson() {
  return {
    policy: { feeBps: 100, capCents: 50_000, capSource: "policy" },
    sources: [{ fundingMethodId: 30, pendingCents: 40_000, accountHolderType: "company", balanceVerified: true, priorPullSettled: true, eligible: true, reasons: [] }],
    eligiblePendingCents: 40_000,
    allowanceCents: 40_000,
    exposureCents: 0,
    headroomCents: 40_000,
    reasons: [],
  };
}

/** Pack tier on sale; case tier $380 short of $500 with a raise to $750 landing in grace. */
function listingTiersJson() {
  return {
    pack: { tier: "pack", eligible: true, reason: null, minimumCents: 10_000, shortfallCents: 0, upcoming: null },
    case: { tier: "case", eligible: false, reason: "case_tier_balance_below_minimum", minimumCents: 50_000, shortfallCents: 38_000,
      upcoming: { minimumCents: 75_000, policyVersion: 3, enforcesAt: "2026-10-04T15:00:00.000Z", affectsVendor: true } },
    generatedAt: STAMP,
  };
}

async function setup(page: Page, initial: Partial<StubState> = {}, path = HARNESS_PATH) {
  const state: StubState = { methods: [], holdSetupConfirmation: false, usdcDepositAddress: null, usdcDeposit: null, autoReload: null, balanceCents: 0, pendingCents: 0, ledger: [], cardFundingFeeBps: 300, limits: null, listingTiers: null, advance: null,
    proofs: {}, failChallenge: false, deleteRefusal: null, detachOutcome: "detached", putRefusalOnce: null, vendorStatus: "onboarding", vendorStandingReason: null,
    walletReads: 0, nextCardId: 10, nextBankId: 30, setupSessions: [], autoReloadWrites: [], fundingSessions: [], usdcRegistrations: [], usdcAddressRequests: 0, deletes: [], bodies: [],
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
        if (!state.holdSetupConfirmation && row.status === "pending" && row.activatesAfterReads !== undefined) {
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
      // It also derives the single-charge bound the way the server does: max(minimum, top-up amount), never sent by this client.
      const minimumBalanceCents = Number(body.minimumBalanceCents);
      const topUpAmountCents = typeof body.topUpAmountCents === "number" ? body.topUpAmountCents : null;
      state.autoReload = {
        autoReloadSettingId: 5, updatedAt: LATER, ...body, topUpAmountCents,
        maxSingleReloadCents: body.enabled ? Math.max(minimumBalanceCents, topUpAmountCents ?? minimumBalanceCents) : null,
        acknowledgedAt: body.acknowledgedCardFeeBps === null ? null : LATER,
      };
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
    if (url.pathname === "/api/dropship/wallet/usdc/deposit-address" && method === "POST") {
      state.usdcAddressRequests += 1;
      const deposit = state.usdcDeposit;
      if (!deposit || deposit.offered !== true) {
        return route.fulfill({ status: 503, json: { error: { code: "DROPSHIP_USDC_DEPOSITS_NOT_OFFERED", message: "USDC deposits are not offered: no account key is configured." } } });
      }
      const created = deposit.address === null;
      if (created) deposit.address = { address: OWN_ADDRESS.toLowerCase(), checksumAddress: OWN_ADDRESS, assignedAt: LATER };
      return route.fulfill({ status: created ? 201 : 200, json: { usdcDeposit: deposit, created } });
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

/** Every journey ends clean: no unexpected request, no page error, no foreign key in any body, and every PUT carries exactly the contract's keys. */
function finish(state: StubState) {
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) { expect(key).not.toMatch(/daily|cost/i); walk(nested); }
    }
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

/** The step list is rendered twice — once for wide screens, once inside the phone collapsible — and only ever one is on screen. */
function stepLink(page: Page, step: string) {
  return page.locator(`[data-testid="wallet-step-link-${step}"]:visible`);
}

async function openStepList(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) >= 640) return;
  const toggle = page.getByRole("button", { name: "Show all steps" });
  if (await toggle.isVisible()) await toggle.click();
}

async function clickStep(page: Page, step: string) {
  await openStepList(page);
  await stepLink(page, step).click();
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
  return page.addInitScript((value: string) => { window.sessionStorage.setItem("dropship-wallet-setup-draft:v1:1", value); }, JSON.stringify({ v: 1, seenIntro: true, sourceRail: null, sourceMethodId: null, floorCents: null, backupMethodId: null, pendingStripe: null, deposit: null, ...draft }));
}

function confirmPendingSetup(state: StubState, rail: "stripe_card" | "stripe_ach") {
  const pending = state.methods.filter(method => method.rail === rail && method.status === "pending");
  expect(pending).toHaveLength(1);
  pending[0].status = "active";
  pending[0].updatedAt = LATER;
  delete pending[0].activatesAfterReads;
}

test("bank vendor, end to end: intro, bank source, minimum with guidance and a top-up amount, backup card, one authorization, then the deposit step — with one emailed code", async ({ page }) => {
  const state = await setup(page, { usdcDepositAddress: DEPOSIT_ADDRESS, holdSetupConfirmation: true });
  const intro = page.getByTestId("wallet-step-intro");
  await expect(intro.getByRole("heading", { name: "How your wallet works" })).toBeVisible();
  await expect(intro.getByTestId("wallet-how-it-works-lede")).toHaveText("Your wallet is the deposit Card Shellz draws on for the orders you sell. Here is what it holds, what it lets you sell, how it stays funded, and what happens when a payment fails.");
  // Six topics, each scannable from its bold lead alone.
  const topics = intro.getByTestId("wallet-how-it-works-rules").getByRole("listitem");
  await expect(topics).toHaveCount(6);
  for (const [index, lead] of ["What your wallet is.", "What you can sell, and the minimum it needs.", "Keeping it funded: your minimum and autopay.",
    "Ways to pay, and what each costs.", "Orders while a transfer lands, and your backup card.", "If a payment fails or is taken back."].entries()) {
    await expect(topics.nth(index).locator("strong")).toHaveText(lead);
  }
  // The tier minimums, the grace period, the advance terms, the rate and the deadline all come from served values.
  await expect(intro).toContainText("A return fee comes out of it too, and so does a payment your bank takes back after it landed; either can take the balance below zero");
  await expect(intro).toContainText("Singles, packs and inner packs are on sale while you keep at least $100 in your wallet. Cases are on sale once your balance, counting money on its way, has reached $500.");
  await expect(intro).toContainText("you keep selling for 14 days after the notice");
  await expect(intro).toContainText("takes up to 5 business days to land (our estimate)");
  await expect(intro).toContainText("costs 3% on top of the amount");
  await expect(intro).toContainText("USDC costs nothing.");
  await expect(intro).toContainText("the same gap is never pulled twice");
  await expect(intro).toContainText("Routine top-ups never take more than the larger of your minimum and your top-up amount in one charge.");
  await expect(intro).toContainText("You can also add money yourself at any time.");
  await expect(intro).toContainText("for a 1% fee on the amount used, at most $500 outstanding at a time");
  await expect(intro).toContainText("cancelled after your hold time (24 hours)");
  await expect(intro).toContainText("We email you, and we do not retry the charge ourselves.");
  // No amount the product does not enforce as a rule, no USDC timing claim, no forward reference, and none of the old words.
  await expect(intro).not.toContainText("single top-up limit");
  await expect(intro).not.toContainText("it is not instant");
  await expect(intro).not.toContainText("Never charge more than");
  await expect(intro).not.toContainText("step 5");
  await expect(intro).not.toContainText("floor");
  await expect(intro).not.toContainText("auto-reload");
  await expect(intro.getByTestId("wallet-intro-verification-note")).toContainText("(a 6-digit code by email)");
  await expect(page.getByTestId("wallet-impact")).toHaveCount(0);
  await expect(page.getByTestId("wallet-balance")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await shot(page, "01-intro");
  await intro.getByRole("button", { name: "Set up my wallet" }).click();

  // Step 2: the recommended rail is the default, but no method is chosen for the
  // vendor, so Continue stays disabled until they pick one.
  const source = page.getByTestId("wallet-step-source");
  await expect(source.getByRole("heading", { name: "Choose your autopay source" })).toBeVisible();
  await expect(radio(page, "Top up from", "Bank account")).toHaveAttribute("aria-checked", "true");
  await expect(source.getByRole("button", { name: "Continue" })).toBeDisabled();
  await expect(source.getByTestId("wallet-usdc-note")).toContainText("can never be your autopay source");
  await shot(page, "02-source-empty");
  await radio(page, "Top up from", "Bank account").click();
  await expect(source.getByTestId("wallet-impact")).toContainText("Routine top-ups are free");
  await source.getByRole("button", { name: "Add a bank account" }).click();
  await expect(source.getByTestId("wallet-verification")).toBeVisible();
  await expect(source.getByRole("status").filter({ hasText: "6-digit code" })).toBeVisible();
  expect(state.codesSent).toEqual(["add_funding_method"]);
  await shot(page, "02-source-code");
  await enterCode(page);
  // Hold the webhook until pending UI is observed. Request counts must not race
  // this assertion during the redirect; the real page's polling observes activation.
  await expect(page.getByTestId("wallet-bank-confirmation")).toContainText("Confirming your bank account with Stripe");
  confirmPendingSetup(state, "stripe_ach");
  expect(state.setupSessions).toEqual([{ rail: "stripe_ach", returnTo: HARNESS_PATH }]);
  expect(new URL(page.url()).search).toBe("");
  await expect(source.getByRole("status").filter({ hasText: "Bank account added: Chase ending in 1234." })).toBeVisible();
  await expect(radio(page, "Top up from", "Bank account")).toHaveAttribute("aria-checked", "true");
  await expect(source).toContainText("Chase ending in 1234 · checking");
  await expectNoHorizontalScroll(page);
  await shot(page, "02-source-bank-added");
  await source.getByRole("button", { name: "Continue" }).click();

  // Step 3: the two tier minimums from the served limits; nothing to guess and no other amount to type.
  const floor = page.getByTestId("wallet-step-floor");
  await expect(floor.getByRole("heading", { name: "Set your minimum" })).toBeVisible();
  await expect(radio(page, "Minimum", "$100")).toHaveAttribute("aria-checked", "true");
  await expect(radio(page, "Minimum", "$100")).toContainText("Singles, packs and inner packs");
  await expect(radio(page, "Minimum", "$500")).toContainText("Cases too");
  await expect(page.getByRole("radiogroup", { name: "Minimum" }).getByRole("radio")).toHaveCount(2);
  await expect(floor.getByTestId("wallet-daily-cost")).toHaveCount(0);
  await expect(floor.getByTestId("wallet-floor-custom")).toHaveCount(0);
  await expect(floor.getByTestId("wallet-tier-hint")).toContainText("Keep at least the tier you sell.");
  // The top-up quick picks follow the minimum: at $100 they are $100, $200, $300 and $500.
  await expect(radio(page, "Top-up amount", "$100")).toHaveAttribute("aria-checked", "true");
  await expect(radio(page, "Top-up amount", "$100")).toContainText("Your minimum");
  await expect(radio(page, "Top-up amount", "$200")).toContainText("2× your minimum");
  await expect(radio(page, "Top-up amount", "$300")).toContainText("3× your minimum");
  await expect(radio(page, "Top-up amount", "$500")).toContainText("5× your minimum");
  await shot(page, "03-floor-default");
  await radio(page, "Top-up amount", "$200").click();
  await expect(floor.getByTestId("wallet-guidance-parked")).toContainText("Autopay keeps at least $100 in the wallet, topping up by $200 at a time.");
  await radio(page, "Minimum", "$500").click();
  await expect(radio(page, "Minimum", "$500")).toHaveAttribute("aria-checked", "true");
  // The pick was "2×", so it follows the new minimum: $1,000, still selected.
  await expect(radio(page, "Top-up amount", "$1,000")).toHaveAttribute("aria-checked", "true");
  await expect(radio(page, "Top-up amount", "$1,000")).toContainText("2× your minimum");
  await expect(radio(page, "Top-up amount", "$1,500")).toContainText("3× your minimum");
  await expect(radio(page, "Top-up amount", "$2,500")).toContainText("5× your minimum");
  await expect(floor.getByTestId("wallet-guidance-parked")).toContainText("Autopay keeps at least $500 in the wallet, topping up by $1,000 at a time.");
  await expect(floor.getByTestId("wallet-floor-limit-note")).toContainText("Routine top-ups never take more than $1,000 in one charge (your top-up amount)");
  await radio(page, "Top-up amount", "$500").click();
  await expect(floor.getByTestId("wallet-impact")).toContainText("Keeping $500 means routine top-ups are free");
  await expect(floor.getByTestId("wallet-guidance-fee")).toContainText("Card fees: $0 on routine top-ups. Only a shortfall is charged 3% — for example a $75 order with $20 available charges your backup card $55 + $1.65.");
  await expect(floor.getByTestId("wallet-guidance-parked")).toContainText("Autopay keeps at least $500 in the wallet, topping up by $500 at a time.");
  await expect(floor.getByTestId("wallet-guidance-activation")).toContainText("$500 from Chase ending in 1234");
  await expect(floor.getByTestId("wallet-guidance-activation")).toContainText("first daily check after you activate");
  await expect(floor.getByTestId("wallet-floor-limit-note")).toContainText("Routine top-ups never take more than $500 in one charge (your minimum)");
  await expect(floor.getByTestId("wallet-floor-limit-note")).toContainText("2 hours");
  // An amount of the vendor's own: it has to clear the policy's smallest top-up, then the bound follows it and no quick pick is selected.
  await page.getByTestId("wallet-top-up-custom").fill("50");
  await expect(floor.getByRole("alert")).toHaveText("The top-up amount must be at least $100.");
  await expect(floor.getByRole("button", { name: "Continue" })).toBeDisabled();
  await page.getByTestId("wallet-top-up-custom").fill("800");
  await expect(page.getByRole("radiogroup", { name: "Top-up amount" }).getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(floor.getByTestId("wallet-guidance-parked")).toContainText("topping up by $800 at a time");
  await expect(floor.getByTestId("wallet-guidance-activation")).toContainText("$800 from Chase ending in 1234");
  await expect(floor.getByTestId("wallet-floor-limit-note")).toContainText("Routine top-ups never take more than $800 in one charge (your top-up amount)");
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
  confirmPendingSetup(state, "stripe_card");
  expect(state.codesSent).toEqual(["add_funding_method"]);
  await expect(backup).toContainText("Visa ending in 4242 · expires 12/27 will be your backup card.");
  await expect(backup.getByTestId("wallet-impact")).toContainText("only for the shortfall plus the 3% fee");
  await shot(page, "04-backup-added");
  await backup.getByRole("button", { name: "Continue" }).click();

  // Step 5: the whole mandate, one button, no checkbox.
  const review = page.getByTestId("wallet-step-review");
  await expect(review.getByRole("heading", { name: "Review and turn on autopay" })).toBeVisible();
  const summary = review.getByTestId("wallet-review-summary");
  await expect(summary).toContainText("Chase ending in 1234 (bank account, no fee)");
  await expect(summary).toContainText("$500");
  await expect(summary).not.toContainText("a day");
  await expect(summary).toContainText("Visa ending in 4242");
  await expect(summary).toContainText("$800. Routine top-ups never take more than $800 in one charge.");
  await expect(summary).toContainText("24 hours — set by CardShellz for every wallet.");
  const mandate = review.getByTestId("wallet-mandate");
  for (const phrase of ["your minimum of $500", "your top-up amount of $800", "shortfall", "whatever its size (up to $5,000)", "24 hours", "2 hours", "before it lands",
    "If a return fee has taken your balance below zero, the shortfall includes that amount.", "Adding money by card now avoids that", "for automatic top-ups and covers", "first daily check after you activate"]) {
    await expect(mandate).toContainText(phrase);
  }
  // The single-charge bound is explained in full here, beside the numbers themselves; the intro only states the rule.
  await expect(mandate).toContainText("Routine top-ups never take more than $800 in one charge — the larger of your minimum and your top-up amount. A held order is different: your backup card is charged its whole shortfall, up to $5,000, the most any single payment may be.");
  await expect(review.getByTestId("wallet-plan-sentence")).toContainText("you keep $500 in your wallet; when an order takes it lower, autopay pulls $800 from your bank for free");
  await expect(review.getByTestId("wallet-activation-quote")).toContainText("$800 bank transfer");
  await expect(review.getByTestId("wallet-fee-acknowledgement-line")).toContainText("records that you agree to the 3% fee");
  await expect(review.getByRole("checkbox")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await shot(page, "05-review");
  await review.getByRole("button", { name: "Agree and turn on autopay" }).click();
  expect(state.autoReloadWrites).toEqual([{ enabled: true, fundingMethodId: 30, backstopFundingMethodId: 10, minimumBalanceCents: 50_000, topUpAmountCents: 80_000, paymentHoldTimeoutMinutes: 1440, acknowledgedCardFeeBps: 300 }]);

  // Step 6: recommended, never a gate.
  const deposit = page.getByTestId("wallet-step-deposit");
  await expect(deposit.getByRole("heading", { name: "Add money now (recommended)" })).toBeVisible();
  // The balance stands on its own, the picked way to pay lists its terms, and nothing here is about autopay (funding design phase 7).
  await expect(deposit.getByTestId("wallet-deposit-available")).toHaveText("$0.00");
  await expect(deposit.getByTestId("wallet-deposit-pending")).toHaveCount(0);
  await expect(deposit.getByTestId("wallet-rail-notes").getByRole("listitem")).toHaveText([
    "No fee.",
    "Takes up to 5 business days (our assumption) to land, and counts toward your minimum as soon as it shows as on the way.",
    "A business bank account can qualify to pay for orders while a transfer is still on the way; a personal account pays only once the money lands.",
    "While it is on the way, an order it cannot pay for is charged to Visa ending in 4242 for the shortfall plus 3%.",
  ]);
  await radio(page, "Pay with", "Card (3% fee)").click();
  await expect(deposit.getByTestId("wallet-rail-notes").getByRole("listitem")).toHaveText(["Card fee: 3% on top of the amount.", "Deposits of $100 or more.", "Available at once."]);
  await radio(page, "Pay with", "Bank account (no fee)").click();
  await expect(deposit).not.toContainText(/autopay|daily check|first top-up/i);
  await expect(deposit.getByTestId("wallet-impact")).toHaveCount(0);
  await expect(deposit.getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
  // The amounts are the top-up step's picks again — the $500 minimum, the vendor's own $800 top-up and the multiples — opening on the $800 top-up; nothing below the minimum is offered.
  await expect(page.getByRole("radiogroup", { name: "Amount", exact: true }).getByRole("radio")).toHaveCount(5);
  for (const [amount, hint] of [["$500", "Your minimum"], ["$800", "Your top-up amount"], ["$1,000", "2× your minimum"], ["$1,500", "3× your minimum"], ["$2,500", "5× your minimum"]]) {
    await expect(radio(page, "Amount", amount)).toContainText(hint);
  }
  await expect(radio(page, "Amount", "$800")).toHaveAttribute("aria-checked", "true");
  await expect(deposit.getByTestId("wallet-deposit-quote")).toContainText("No fee. $800.00 goes into your wallet once the bank transfer settles");
  await expect(deposit).toContainText("we may ask you to confirm it is you again");
  await expectNoHorizontalScroll(page);
  await shot(page, "06-deposit");
  await deposit.getByRole("button", { name: "Skip for now" }).click();

  const manage = page.getByTestId("wallet-manage");
  await expect(manage).toBeVisible();
  await expect(manage.getByTestId("wallet-plan-source")).toContainText("Chase ending in 1234 · bank account · no fee");
  await expect(manage.getByTestId("wallet-plan-floor")).toContainText("$500 — autopay tops it up after any order that takes it lower, and at the daily check.");
  await expect(manage.getByTestId("wallet-plan-floor")).not.toContainText("a day");
  await expect(manage.getByTestId("wallet-plan-top-up")).toContainText("Top-up amount $800 · routine top-ups never more than $800 in one charge.");
  await expect(manage.getByTestId("wallet-plan-backup-card")).toContainText("Visa ending in 4242 · expires 12/27");
  await expect(manage.getByTestId("wallet-plan-limits")).toContainText("24 hours — set by CardShellz for every wallet.");
  await expect(manage.getByTestId("wallet-plan-authorization")).toContainText("with 3% fee on card charges");
  await expect(manage.getByTestId("wallet-deposit-callout")).toBeVisible();
  await expect(manage.getByRole("button", { name: "Back to onboarding" })).toBeVisible();
  await expect(manage.getByTestId("wallet-auto-reload-off")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot(page, "07-manage");
  expect(state.codesSent).toEqual(["add_funding_method"]);
  finish(state);
});

test("card vendor: steps 4 and 6 are satisfied rows, the bound is the minimum, and the card is both source and backup", async ({ page }) => {
  const state = await setup(page, { proofs: ALL_PROOFS, holdSetupConfirmation: true });
  await page.getByRole("button", { name: "Set up my wallet" }).click();
  const source = page.getByTestId("wallet-step-source");
  await radio(page, "Top up from", "Card").click();
  await source.getByRole("button", { name: "Add a card" }).click();
  await expect(page.getByTestId("wallet-card-confirmation")).toBeVisible();
  confirmPendingSetup(state, "stripe_card");
  await expect(source.getByRole("status").filter({ hasText: "Card added: Visa ending in 4242." })).toBeVisible();
  await expect(source.getByTestId("wallet-impact")).toContainText("Every top-up costs 3%");
  await expect(source.getByTestId("wallet-impact")).toContainText("Your card is also your backup card");
  await shot(page, "card-02-source");
  await source.getByRole("button", { name: "Continue" }).click();

  const floor = page.getByTestId("wallet-step-floor");
  await expect(radio(page, "Minimum", "$100")).toHaveAttribute("aria-checked", "true");
  await expect(radio(page, "Minimum", "$100")).toContainText("Singles, packs and inner packs");
  await expect(floor).toContainText("$3 at $100, $30 at $1,000");
  await expect(floor.getByTestId("wallet-guidance-activation")).toContainText("$103");
  await expect(floor.getByTestId("wallet-floor-limit-note")).toContainText("Routine top-ups never take more than $100 in one charge (your minimum)");
  await shot(page, "card-03-floor");
  await floor.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByTestId("wallet-step-backup")).toHaveCount(0);
  const steps = page.getByTestId("wallet-step-indicator").first();
  await expect(steps).toContainText("Backup card · Visa ending in 4242 — the card you top up with is also your backup card");
  await expect(steps).toContainText("First top-up ·");
  await expect(steps).toContainText("$103");
  const review = page.getByTestId("wallet-step-review");
  await expect(review.getByTestId("wallet-review-summary")).toContainText("$100 — your minimum. Routine top-ups never take more than $100 in one charge.");
  await expect(review.getByTestId("wallet-review-summary")).toContainText("Visa ending in 4242 — also your autopay source");
  await expect(review.getByTestId("wallet-mandate")).toContainText("or a bank transfer you started is returned before it lands");
  await expect(review.getByTestId("wallet-mandate")).toContainText("$100 + $3 = $103");
  await expect(page.getByText("(2 × your floor)")).toHaveCount(0);
  await shot(page, "card-05-review");
  await review.getByRole("button", { name: "Agree and turn on autopay" }).click();
  expect(state.autoReloadWrites).toEqual([{ enabled: true, fundingMethodId: 10, backstopFundingMethodId: 10, minimumBalanceCents: 10_000, topUpAmountCents: null, paymentHoldTimeoutMinutes: 1440, acknowledgedCardFeeBps: 300 }]);
  await expect(page.getByTestId("wallet-manage")).toBeVisible();
  await expect(page.getByTestId("wallet-step-deposit")).toHaveCount(0);
  await expect(page.getByTestId("wallet-plan").getByRole("status")).toContainText("Autopay is on.");
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

test("manage: changing the minimum moves the bound with it, the top-up amount is its own number, and each save sends the whole row at the recorded rate", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "active", methods: [CARD, BANK], autoReload: doneAutoReload(), balanceCents: 30_000, proofs: ALL_PROOFS });
  const plan = page.getByTestId("wallet-plan");
  await expect(page.getByTestId("wallet-available")).toHaveText("$300.00");
  await expect(page.getByTestId("wallet-step-indicator")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back to onboarding" })).toHaveCount(0);
  await expect(page.getByTestId("wallet-auto-reload-off")).toHaveCount(0);
  await shot(page, "manage-01-plan");
  // The stored bound ($500) shows until the amounts change; the minimum editor then shows the bound the server will derive.
  await expect(plan.getByTestId("wallet-plan-top-up")).toContainText("Top-up amount $250 (your minimum) · routine top-ups never more than $500 in one charge.");
  await plan.getByTestId("wallet-plan-floor").getByRole("button", { name: "Change" }).click();
  await expect(radio(page, "Minimum", "$100")).toHaveAttribute("aria-checked", "true");
  await expect(radio(page, "Top-up amount", "$100")).toHaveAttribute("aria-checked", "true");
  await radio(page, "Minimum", "$500").click();
  await expect(radio(page, "Top-up amount", "$500")).toHaveAttribute("aria-checked", "true");
  await expect(radio(page, "Top-up amount", "$2,500")).toContainText("5× your minimum");
  await expect(plan.getByTestId("wallet-floor-limit-note")).toContainText("Routine top-ups never take more than $500 in one charge (your minimum)");
  await expectNoHorizontalScroll(page);
  await shot(page, "manage-02-floor-editor");
  await plan.getByRole("button", { name: "Save", exact: true }).click();
  expect(state.autoReloadWrites).toEqual([{ enabled: true, fundingMethodId: 30, backstopFundingMethodId: 10, minimumBalanceCents: 50_000, topUpAmountCents: null, paymentHoldTimeoutMinutes: 1440, acknowledgedCardFeeBps: 300 }]);
  await expect(plan.getByTestId("wallet-plan-floor")).toContainText("$500 — autopay tops it up after any order that takes it lower");
  await expect(plan.getByTestId("wallet-plan-top-up")).toContainText("Top-up amount $500 (your minimum) · routine top-ups never more than $500 in one charge.");

  // The hold time is CardShellz's setting: shown from the served warning window, never chosen here.
  await expect(plan.getByTestId("wallet-plan-limits")).toContainText("24 hours — set by CardShellz for every wallet.");
  await expect(plan.getByTestId("wallet-plan-limits")).toContainText("for orders held from now on");
  await expect(plan.getByTestId("wallet-plan-limits")).toContainText("We email you 2 hours before.");
  await expect(plan.getByTestId("wallet-plan-limits").getByRole("button", { name: "Change" })).toHaveCount(0);

  // A top-up amount of its own: bigger, fewer pulls, and the bound follows it.
  await plan.getByTestId("wallet-plan-floor").getByRole("button", { name: "Change" }).click();
  await page.getByTestId("wallet-top-up-custom").fill("2500");
  await expect(plan.getByTestId("wallet-floor-limit-note")).toContainText("Routine top-ups never take more than $2,500 in one charge (your top-up amount)");
  await shot(page, "manage-03-top-up-editor");
  await plan.getByRole("button", { name: "Save", exact: true }).click();
  expect(state.autoReloadWrites[1]).toMatchObject({ topUpAmountCents: 250_000, minimumBalanceCents: 50_000, paymentHoldTimeoutMinutes: 1440 });
  expect(state.autoReloadWrites[1]).not.toHaveProperty("maxSingleReloadCents");
  await expect(plan.getByTestId("wallet-plan-top-up")).toContainText("Top-up amount $2,500 · routine top-ups never more than $2,500 in one charge.");
  finish(state);
});

test("manage: replacing the backup card is add, designate, then remove the old one — and each Remove is pre-disabled with the server's reason", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "active", methods: [CARD, BANK], autoReload: doneAutoReload(), proofs: { add_funding_method: LIVE_PROOF, wallet_funding_high_value: LIVE_PROOF } });
  const methods = page.getByTestId("wallet-methods");
  const oldCard = methods.getByTestId("wallet-method-10");
  await expect(oldCard).toContainText("Backup card");
  await expect(oldCard.getByTestId("wallet-method-remove")).toBeDisabled();
  await expect(oldCard).toContainText("This is your backup card — choose another backup card first, then remove this one.");
  await expect(methods.getByTestId("wallet-method-30")).toContainText("This is your autopay source — choose another source first, then remove this one.");
  await expect(methods).toContainText("To replace a card: add the new one, make it the backup card");
  await shot(page, "manage-04-methods");

  await methods.getByRole("button", { name: "Add a card" }).click();
  const offer = page.getByTestId("wallet-new-method-offer");
  await expect(offer).toContainText("Visa ending in 9999 added.");
  await expect(page.getByTestId("wallet-funding-return")).toContainText("Card added: Visa ending in 9999.");
  await shot(page, "manage-05-new-card-offer");
  await offer.getByRole("button", { name: "Use as backup card" }).click();
  expect(state.autoReloadWrites).toEqual([{ enabled: true, fundingMethodId: 30, backstopFundingMethodId: 11, minimumBalanceCents: 25_000, topUpAmountCents: null, paymentHoldTimeoutMinutes: 1440, acknowledgedCardFeeBps: 300 }]);
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
  await expect(methods.getByRole("status").filter({ hasText: "Removed. Card Shellz will no longer charge it." })).toBeVisible();
  expect(state.deletes).toEqual(["/api/dropship/wallet/funding-methods/10"]);
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
  await expect(methods.getByRole("alert")).toHaveText("This is your autopay source. Choose another source first, then remove this one.");
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
  // The picks are the plan's: the $250 minimum, which autopay would pull next with $42.50 in the wallet, opens selected, then its multiples.
  await expect(page.getByRole("radiogroup", { name: "Amount", exact: true }).getByRole("radio")).toHaveCount(4);
  await expect(radio(page, "Amount", "$250")).toHaveAttribute("aria-checked", "true");
  await expect(radio(page, "Amount", "$250")).toContainText("Your minimum");
  await expect(radio(page, "Amount", "$1,250")).toContainText("5× your minimum");
  await expect(panel.getByTestId("wallet-funding-quote")).toHaveText("No fee. $250.00 goes into your wallet once the bank transfer settles — up to 5 business days (our assumption). It cannot pay orders until then.");
  await radio(page, "Pay with", "Card (3% fee)").click();
  await expect(panel.getByTestId("wallet-funding-quote")).toHaveText("Card fee (3%): $7.50. Your card is charged $257.50 and $250.00 goes into your wallet, available at once.");
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
  await radio(page, "Amount", "$250").click();
  await panel.getByRole("button", { name: "Continue on Stripe" }).click();
  await expect(page.getByTestId("wallet-balance").getByTestId("wallet-verification")).toBeVisible();
  expect(state.codesSent).toEqual(["wallet_funding_high_value"]);
  await enterCode(page);
  await expect(page.getByTestId("wallet-funding-return")).toContainText("Payment received. Your balance updates as soon as Stripe confirms it.");
  expect(state.fundingSessions).toEqual([{ fundingMethodId: 10, amountCents: 25_000, returnTo: HARNESS_PATH }]);
  await expect(page.getByTestId("wallet-available")).toHaveText("$292.50");
  await expect(page.getByTestId("wallet-activity")).toContainText("Money you added");
  expect(new URL(page.url()).search).toBe("");
  await shot(page, "manage-11-funding-return");

  // A bank transfer comes back as money on the way, with the one settlement phrase.
  await page.getByRole("button", { name: "Add money" }).click();
  // Back above the minimum, the panel opens on the routine top-up amount — the $250 minimum — and 2× is a click away.
  await expect(radio(page, "Amount", "$250")).toHaveAttribute("aria-checked", "true");
  await radio(page, "Amount", "$500").click();
  await expect(radio(page, "Amount", "$500")).toContainText("2× your minimum");
  await panel.getByRole("button", { name: "Continue on Stripe" }).click();
  await expect(page.getByTestId("wallet-funding-return")).toContainText("Transfer started. It shows as on the way once Stripe confirms it");
  expect(state.fundingSessions[1]).toEqual({ fundingMethodId: 30, amountCents: 50_000, returnTo: HARNESS_PATH });
  await expect(page.getByTestId("wallet-pending")).toContainText("$500 on the way — a bank transfer takes up to 5 business days (our assumption) to land");
  await expect(page.getByText(/a few days/)).toHaveCount(0);
  finish(state);
});

test("manage: with no card fee, every card surface says so, a fee cut keeps the record refreshable, and a card deposit keeps its own minimum", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "active", methods: [CARD, BANK], autoReload: doneAutoReload(), balanceCents: 4_250, cardFundingFeeBps: 0, proofs: ALL_PROOFS });
  const manage = page.getByTestId("wallet-manage");
  // The recorded 3% still covers the vendor; the cut applies at once and the banner offers to refresh the record.
  await expect(page.getByTestId("wallet-acknowledgement-needed")).toContainText("Card Shellz removed the card fee (you agreed to a 3% fee). Automatic charges already use the lower rate; confirm to keep your record current.");
  await expect(manage.getByTestId("wallet-plan-authorization")).toContainText("with 3% fee on card charges; card charges now carry no fee — confirm the new terms above.");
  await expect(manage.getByTestId("wallet-plan-backup-card")).toContainText("Charged only for the shortfall on an order, up to $5,000 in one payment");
  await expect(page.getByText(/0%/)).toHaveCount(0);

  await page.getByRole("button", { name: "Add money" }).click();
  const panel = page.getByTestId("wallet-add-money");
  await radio(page, "Pay with", "Card (no fee)").click();
  await expect(panel.getByTestId("wallet-funding-quote")).toHaveText("No fee. Your card is charged $250.00, and it goes into your wallet, available at once.");
  // A card deposit below the $100 card minimum is refused before Stripe is involved; the message names the card's bounds.
  await panel.getByLabel("Or another amount").fill("50");
  await panel.getByRole("button", { name: "Continue on Stripe" }).click();
  await expect(panel.getByRole("alert")).toHaveText("Amounts must be between $100 and $5,000.");
  expect(state.fundingSessions).toEqual([]);
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

test("manage: the wallet says which listing tiers are on sale, what each needs, and a raise still in grace", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "active", methods: [CARD, BANK], autoReload: doneAutoReload(), balanceCents: 12_000, proofs: ALL_PROOFS, listingTiers: listingTiersJson() });
  const tiers = page.getByTestId("wallet-listing-tiers");
  await expect(tiers).toContainText("What is on sale");
  // Between the balance and the plan: the first thing after the number is what it buys.
  const balanceY = await page.getByTestId("wallet-balance").boundingBox().then((box) => box?.y ?? 0);
  const tiersY = await tiers.boundingBox().then((box) => box?.y ?? 0);
  const planY = await page.getByTestId("wallet-plan").boundingBox().then((box) => box?.y ?? 0);
  expect(tiersY).toBeGreaterThan(balanceY);
  expect(planY).toBeGreaterThan(tiersY);
  const pack = tiers.getByTestId("wallet-listing-tier-pack");
  await expect(pack).toContainText("Packs and inner packs · minimum $100");
  await expect(pack).toContainText("On sale");
  await expect(pack).toContainText("Your wallet keeps this minimum, so these listings are on sale.");
  await expect(pack.getByTestId("wallet-listing-tier-pack-upcoming")).toHaveCount(0);
  const cases = tiers.getByTestId("wallet-listing-tier-case");
  await expect(cases).toContainText("Cases · minimum $500");
  await expect(cases).toContainText("Off sale");
  await expect(cases).toContainText("Case listings go on sale on their own once your balance reaches the minimum. You are $380 short.");
  await expect(cases.getByTestId("wallet-listing-tier-case-upcoming")).toContainText(
    "The minimum rises to $750 on October 4, 2026. As things stand you would fall below it; bring your wallet up before then to keep these listings on sale.",
  );
  await expectNoHorizontalScroll(page);
  await shot(page, "manage-13-listing-tiers");
  finish(state);
});

test("manage: the wallet says what money on its way can already pay for, and why a bank account qualifies", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "active", methods: [CARD, BANK], autoReload: doneAutoReload(), balanceCents: 12_000, pendingCents: 40_000, proofs: ALL_PROOFS, advance: advanceJson() });
  await expect(page.getByTestId("wallet-pending")).toContainText("$400 on the way — a bank transfer takes up to 5 business days (our assumption) to land; up to $400 of it can pay for orders now, for a 1% fee on the amount used.");
  const section = page.getByTestId("wallet-advance");
  await expect(section).toContainText("Orders while a transfer lands");
  await expect(section.getByTestId("wallet-advance-status")).toHaveText("Up to $400 of money on its way can pay for orders now.");
  await expect(section.getByTestId("wallet-advance-details")).toContainText("Fee 1% on the amount used; at most $500 outstanding at a time.");
  const bank = section.getByTestId("wallet-advance-source-30");
  await expect(bank).toContainText("Chase ending in 1234 · $400 on the way");
  await expect(bank).toContainText("Qualifies");
  await expect(section.getByTestId("wallet-advance-source-10")).toHaveCount(0);
  // Below the tiers when both are served, above the plan.
  const planY = await page.getByTestId("wallet-plan").boundingBox().then((box) => box?.y ?? 0);
  expect(await section.boundingBox().then((box) => box?.y ?? 0)).toBeLessThan(planY);
  await expectNoHorizontalScroll(page);
  await shot(page, "manage-14-advance");
  finish(state);
});

test("a paused vendor sees the standing notice above everything with a control behind it, and no way to turn autopay off", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "paused", vendorStandingReason: "card_declined", methods: [CARD, BANK], autoReload: doneAutoReload(), proofs: ALL_PROOFS });
  const notice = page.getByTestId("wallet-vendor-standing-notice");
  await expect(notice).toContainText("Selling is paused");
  expect(await notice.boundingBox().then((box) => box?.y ?? 0)).toBeLessThan(await page.getByTestId("wallet-balance").boundingBox().then((box) => box?.y ?? 0));
  await notice.getByRole("button", { name: "Change backup card" }).click();
  await expect(page.getByTestId("wallet-step-backup")).toBeVisible();
  await expect(page.getByTestId("wallet-auto-reload-off")).toHaveCount(0);
  await expect(page.getByTestId("wallet-method-10").getByTestId("wallet-method-remove")).toBeDisabled();
  // A server that does not serve the listing tiers yet leaves the section out rather than guessing.
  await expect(page.getByTestId("wallet-listing-tiers")).toHaveCount(0);
  await shot(page, "manage-12-paused");
  finish(state);
});

test("a vendor whose wallet already holds a card still starts at step 1, with no tick on a page they have not seen", async ({ page }) => {
  // A card carried over from the old wallet: the old rule skipped the intro
  // whenever any method existed, so this vendor never saw the charge rules.
  const state = await setup(page, { methods: [SAVED_CARD], proofs: ALL_PROOFS });
  const intro = page.getByTestId("wallet-step-intro");
  await expect(intro.getByRole("heading", { name: "How your wallet works" })).toBeVisible();
  await expect(intro.getByRole("button", { name: "Set up my wallet" })).toBeVisible();
  await expect(page.getByTestId("wallet-step-source")).toHaveCount(0);
  await openStepList(page);
  await expect(stepLink(page, "intro")).toHaveAttribute("aria-current", "step");
  // Nothing ahead of it is open yet, and nothing behind it is ticked.
  await expect(page.locator('[data-testid="wallet-step-link-source"]')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await shot(page, "nav-00-intro-with-saved-card");

  await intro.getByRole("button", { name: "Set up my wallet" }).click();
  const source = page.getByTestId("wallet-step-source");
  await expect(source.getByRole("heading", { name: "Choose your autopay source" })).toBeVisible();
  // A saved card does not flip the default onto the fee-bearing rail: the picker
  // opens on the recommended bank rail and names the card as the alternative.
  await expect(radio(page, "Top up from", "Bank account")).toHaveAttribute("aria-checked", "true");
  await expect(radio(page, "Top up from", "Card")).toHaveAttribute("aria-checked", "false");
  await expect(source.getByTestId("wallet-source-preselection")).toHaveCount(0);
  await expect(source.getByTestId("wallet-source-saved-card"))
    .toHaveText("Amex ending in 6800 is already saved. Choose Card to use it, or add a bank account and pay no fees.");
  await expect(source.getByTestId("wallet-impact")).toContainText("Routine top-ups are free");
  // The whole option is the control: a click on the comparison text picks the rail.
  await source.getByTestId("wallet-source-option-card").getByText("Lands at once").click();
  await expect(radio(page, "Top up from", "Card")).toHaveAttribute("aria-checked", "true");
  await expect(source.getByTestId("wallet-source-saved-card")).toHaveCount(0);
  await expect(source).toContainText("Amex ending in 6800 · expires 12/28");
  await openStepList(page);
  await expect(stepLink(page, "intro")).not.toHaveAttribute("aria-current", "step");
  await expect(stepLink(page, "source")).toHaveAttribute("aria-current", "step");
  await shot(page, "nav-00b-source-bank-default");
  finish(state);
});

test("the step list walks back and forward without losing a choice, and manage keeps the rules on hand", async ({ page }) => {
  // The draft a vendor holds after steps 1–3, written the way a browser from
  // before step navigation would still hold it: no `stepOverride` key at all.
  await seedDraft(page, { sourceRail: "stripe_ach", sourceMethodId: 30, floorCents: 25_000 });
  const state = await setup(page, { methods: [BANK, CARD], proofs: ALL_PROOFS });

  // The choices reach step 4. Everything behind it is a control; nothing ahead of it is.
  const backup = page.getByTestId("wallet-step-backup");
  await expect(backup.getByRole("heading", { name: "Your backup card" })).toBeVisible();
  await openStepList(page);
  await expect(stepLink(page, "backup")).toHaveAttribute("aria-current", "step");
  await expect(stepLink(page, "floor")).toContainText("$250");
  await expect(page.locator('[data-testid="wallet-step-link-authorize"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="wallet-step-link-deposit"]')).toHaveCount(0);

  // Step 2 revisited shows the saved bank account, still chosen.
  await clickStep(page, "source");
  const source = page.getByTestId("wallet-step-source");
  await expect(source.getByRole("heading", { name: "Choose your autopay source" })).toBeVisible();
  await expect(radio(page, "Top up from", "Bank account")).toHaveAttribute("aria-checked", "true");
  await expect(source).toContainText("Chase ending in 1234 · checking");
  await expect(stepLink(page, "source")).toHaveAttribute("aria-current", "step");
  // Looking back does not undo the steps ahead of it: step 3 still shows the floor it holds.
  await expect(stepLink(page, "floor")).toContainText("$250");
  await expectNoHorizontalScroll(page);
  await shot(page, "nav-01-source-revisited");

  // Continue with nothing changed lands back on step 4 with the floor intact.
  await source.getByRole("button", { name: "Continue" }).click();
  await expect(backup.getByRole("heading", { name: "Your backup card" })).toBeVisible();
  await openStepList(page);
  await expect(stepLink(page, "floor")).toContainText("$250");
  const kept = JSON.parse(await page.evaluate(() => window.sessionStorage.getItem("dropship-wallet-setup-draft:v1:1") ?? "{}")) as Record<string, unknown>;
  expect(kept).toMatchObject({ sourceMethodId: 30, floorCents: 25_000, stepOverride: null });

  // Step 1 is a page of its own now: the same rules, and a button that only walks back.
  await clickStep(page, "intro");
  const intro = page.getByTestId("wallet-step-intro");
  await expect(intro.getByRole("heading", { name: "How your wallet works" })).toBeVisible();
  await expect(intro).toContainText("Money that has landed pays for orders first.");
  await expect(intro.getByTestId("wallet-intro-verification-note")).toContainText("(a 6-digit code by email)");
  await expect(intro.getByRole("button", { name: "Set up my wallet" })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await shot(page, "nav-02-intro-revisited");
  await intro.getByRole("button", { name: "Back to setup" }).click();
  await expect(backup.getByRole("heading", { name: "Your backup card" })).toBeVisible();

  // The plain Back control walks one step at a time, and Continue returns from there too.
  await backup.getByRole("button", { name: "Back", exact: true }).click();
  const floor = page.getByTestId("wallet-step-floor");
  await expect(floor.getByRole("heading", { name: "Set your minimum" })).toBeVisible();
  // The drafted $250 is not one of the two tiers any more: it opens on the tier it falls in, and Continue keeps that.
  await expect(radio(page, "Minimum", "$100")).toHaveAttribute("aria-checked", "true");
  await shot(page, "nav-03-floor-revisited");
  await floor.getByRole("button", { name: "Continue" }).click();
  await expect(backup.getByRole("heading", { name: "Your backup card" })).toBeVisible();

  // Finish setup from there: nothing was lost on the way round.
  await backup.getByRole("button", { name: "Continue" }).click();
  const review = page.getByTestId("wallet-step-review");
  await expect(review.getByTestId("wallet-review-summary")).toContainText("Chase ending in 1234 (bank account, no fee)");
  await expect(review.getByTestId("wallet-review-summary")).toContainText("$100");
  await review.getByRole("button", { name: "Agree and turn on autopay" }).click();
  expect(state.autoReloadWrites).toEqual([{ enabled: true, fundingMethodId: 30, backstopFundingMethodId: 10, minimumBalanceCents: 10_000, topUpAmountCents: null, paymentHoldTimeoutMinutes: 1440, acknowledgedCardFeeBps: 300 }]);
  // At step 6 the plan belongs to the server: the review is still readable, the
  // earlier steps are not offered, and the review's Change controls go with them.
  const deposit = page.getByTestId("wallet-step-deposit");
  await openStepList(page);
  await expect(page.locator('[data-testid="wallet-step-link-source"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="wallet-step-link-floor"]')).toHaveCount(0);
  await expect(stepLink(page, "intro")).toBeVisible();
  // The add-money step has no Back: the step list is the way to the review.
  await expect(deposit.getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
  await clickStep(page, "authorize");
  const reviewAgain = page.getByTestId("wallet-step-review");
  await expect(reviewAgain.getByTestId("wallet-review-summary")).toContainText("Chase ending in 1234 (bank account, no fee)");
  await expect(reviewAgain.getByRole("button", { name: "Change" })).toHaveCount(0);
  await clickStep(page, "deposit");
  await expect(deposit.getByRole("heading", { name: "Add money now (recommended)" })).toBeVisible();
  await deposit.getByRole("button", { name: "Skip for now" }).click();

  // Past setup the rules are still one click away, collapsed until asked for.
  const how = page.getByTestId("wallet-how-it-works");
  await expect(how).not.toContainText("Money that has landed pays for orders first.");
  await how.getByRole("button").click();
  await expect(how).toContainText("Money that has landed pays for orders first.");
  // One source: the manage view renders the same lede and the same six topics as step 1.
  await expect(how.getByTestId("wallet-how-it-works-lede")).toContainText("Your wallet is the deposit Card Shellz draws on for the orders you sell.");
  await expect(how.getByTestId("wallet-how-it-works-rules").getByRole("listitem")).toHaveCount(6);
  await expect(how.getByTestId("wallet-intro-verification-note")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot(page, "nav-04-how-it-works");
  finish(state);
});

test("a PUT refusal with a step recovery moves the flow back to that step with the alert inside it, and the retry succeeds", async ({ page }) => {
  await seedDraft(page, { sourceRail: "stripe_ach", sourceMethodId: 30, floorCents: 25_000, backupMethodId: 10 });
  const state = await setup(page, { methods: [CARD, BANK], proofs: ALL_PROOFS, putRefusalOnce: { status: 409, code: "DROPSHIP_BACKUP_CARD_EXPIRED", context: { expMonth: 1, expYear: 2026 } } });
  const review = page.getByTestId("wallet-step-review");
  await review.getByRole("button", { name: "Agree and turn on autopay" }).click();
  const backup = page.getByTestId("wallet-step-backup");
  await expect(backup.getByRole("alert")).toHaveText("That card has expired. Add a current card.");
  await shot(page, "04b-put-refusal");
  await backup.getByRole("button", { name: "Continue" }).click();
  await page.getByTestId("wallet-step-review").getByRole("button", { name: "Agree and turn on autopay" }).click();
  await expect(page.getByTestId("wallet-step-deposit")).toBeVisible();
  expect(state.autoReloadWrites).toHaveLength(2);
  finish(state);
});

test("manage: USDC lands on the vendor's own address — get it once, then the timing and the warning are the model's", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "active", methods: [CARD, BANK], autoReload: doneAutoReload(), balanceCents: 4_250, usdcDeposit: { ...WATCHED_USDC } });
  await expect(page.getByTestId("wallet-available")).toHaveText("$42.50");
  await page.getByRole("button", { name: "Add money" }).click();
  await radio(page, "Pay with", "USDC on Base").click();
  const usdc = page.getByTestId("wallet-usdc-funding");
  // No address yet: the panel offers to get one and says nothing about sending from anywhere.
  await expect(usdc.getByTestId("wallet-usdc-deposit-address")).toHaveCount(0);
  await expect(usdc.getByLabel("Wallet address you send from")).toHaveCount(0);
  await expect(usdc.getByTestId("wallet-usdc-timing")).toHaveText("No fee. A transfer shows in your wallet after 6 confirmations and is available for orders once the network settles it — usually within a few minutes (our estimate).");
  await expect(usdc.getByTestId("wallet-usdc-warning")).toHaveText("Send only USDC on the Base network to this address. Anything else sent here cannot be recovered.");
  await usdc.getByTestId("wallet-usdc-request-address").click();
  await expect(page.getByRole("status").filter({ hasText: "Your USDC deposit address is ready." })).toHaveCount(1);
  await expect(usdc.getByTestId("wallet-usdc-deposit-address")).toHaveText(OWN_ADDRESS);
  await expect(usdc.getByTestId("wallet-usdc-request-address")).toHaveCount(0);
  expect(state.usdcAddressRequests).toBe(1);
  await expectNoHorizontalScroll(page);
  await shot(page, "manage-11-usdc-own-address");
});

test("manage: without a key, asking for a USDC address is refused in the model's words", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "active", methods: [CARD, BANK], autoReload: doneAutoReload(), balanceCents: 4_250, usdcDeposit: { ...WATCHED_USDC, offered: false, watched: false }, usdcDepositAddress: DEPOSIT_ADDRESS });
  await page.getByRole("button", { name: "Add money" }).click();
  await radio(page, "Pay with", "USDC on Base").click();
  // Only the shared address is configured: the legacy panel, with the manual credit wording.
  const usdc = page.getByTestId("wallet-usdc-funding");
  await expect(usdc.getByTestId("wallet-usdc-deposit-address")).toHaveText(DEPOSIT_ADDRESS);
  await expect(usdc).toContainText("A member of the Card Shellz team credits your wallet after confirming the transfer — this is not instant.");
  expect(state.usdcAddressRequests).toBe(0);
});
