/**
 * eBay SANDBOX proof of variation-listing membership changes.
 *
 * Drives the same code production uses for the "Update existing listing" action
 * (`EbayMarketplaceListingConnector` + `createEbayRouteListingLifecycleClient` +
 * `buildEbayRouteListingDraft` + `prepareEbayListingPackages`) against eBay's
 * sandbox, on a throwaway listing, and prints every eBay request with its
 * response status and error ids.
 *
 * It is NOT part of the web process and never touches a database or the
 * production eBay account:
 *   - it refuses to start unless the client id carries eBay's sandbox marker;
 *   - it aborts any request to a production eBay host;
 *   - the database URL is replaced with an unreachable address.
 *
 * What it does not cover (stated so nobody reads a pass as more than it is):
 *   - The real quantity admission (`createChannelEbayQuantityRequestAdmission`)
 *     is Postgres-backed. Here a stand-in supplies the canonical quantity, so the
 *     eBay-facing half of `quantity-publication-request.ts` runs for real and the
 *     database half does not. The stand-in does imitate the 60-second cooldown
 *     the real owner applies after eBay refuses a write.
 *   - `executeProduct`'s database steps (product lock, change intents, stock
 *     link, saved mapping) and the sealed prepared intent are not exercised.
 *   - The sandbox is not production. On 2026-11-16 it answered identical writes
 *     with 25019 / 25001 / 25002 on one call and success on the next, and it
 *     applied a write that left one live variation where production answered
 *     25604. A pass here shows the sequence is accepted by eBay's sandbox, no more.
 *
 * Credentials (never committed): EBAY_SANDBOX_CLIENT_ID, EBAY_SANDBOX_CLIENT_SECRET,
 * EBAY_SANDBOX_RUNAME, EBAY_SANDBOX_REFRESH_TOKEN, from the environment or a
 * git-ignored `.env` beside package.json.
 *
 * Usage (in Git Bash on Windows, set MSYS_NO_PATHCONV=1 so `rest` paths are not rewritten):
 *   npx tsx scripts/ebay-sandbox-listing-membership.ts setup                      business policies + location, once
 *   npx tsx scripts/ebay-sandbox-listing-membership.ts a                          publish two sizes; prints the run id
 *   npx tsx scripts/ebay-sandbox-listing-membership.ts b --run <id>               add a third size
 *   npx tsx scripts/ebay-sandbox-listing-membership.ts c --run <id> --sizes ...   add one size and remove another
 *   npx tsx scripts/ebay-sandbox-listing-membership.ts raw-add --run <id> --sizes ...   leave a size half-added (no offer)
 *   npx tsx scripts/ebay-sandbox-listing-membership.ts d|e|update --run <id> --sizes <final sizes>
 *   npx tsx scripts/ebay-sandbox-listing-membership.ts state --run <id>           eBay's record beside the live listing
 *   npx tsx scripts/ebay-sandbox-listing-membership.ts rest <METHOD> </path> [--body '<json>']   one plain sandbox call
 *   npx tsx scripts/ebay-sandbox-listing-membership.ts cleanup --run <id>
 * Flags: --zero-stock <sizes>  those sizes have no stock (canonical quantity 0)
 *        --retry-sandbox-faults  repeat idempotent writes eBay answered with 25019/25002 (printed; not a connector pass)
 */
import fs from "node:fs";
import path from "node:path";
import https from "node:https";

const SANDBOX_API = "https://api.sandbox.ebay.com";
const MARKETPLACE_ID = "EBAY_US";
const MERCHANT_LOCATION_KEY = "echelon-sandbox-hq";
const POLICY_NAME_PREFIX = "Echelon sandbox";
/** Leaf category of production listing 298148420100 (read from its live offer on 2026-11-16). */
const CATEGORY_ID = process.env.EBAY_SANDBOX_CATEGORY_ID ?? "183437";
const VARIATION_ASPECT = "Style";
const PRODUCT_ID = 54;
/** A public product photo eBay can fetch (the production listing's own picture). */
const IMAGE_URL = "https://cdn.shopify.com/s/files/1/0474/6625/0399/files/s-l1600_a111aba3-9d2f-4b01-a5c3-a1b8ba48280e.jpg?v=1775084781";
const SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
].join(" ");

interface Size { code: string; label: string; variantId: number; priceCents: number; quantity: number; weightGrams: number }
const SIZES: Record<string, Size> = {
  P50: { code: "P50", label: "Pack of 50", variantId: 1, priceCents: 454, quantity: 40, weightGrams: 60 },
  P100: { code: "P100", label: "Pack of 100", variantId: 2, priceCents: 799, quantity: 30, weightGrams: 110 },
  C500: { code: "C500", label: "Case of 500", variantId: 3, priceCents: 2999, quantity: 20, weightGrams: 560 },
  C1000: { code: "C1000", label: "Case of 1000", variantId: 4, priceCents: 4999, quantity: 15, weightGrams: 1150 },
  C2500: { code: "C2500", label: "Case of 2500", variantId: 5, priceCents: 9999, quantity: 10, weightGrams: 2950 },
  C5000: { code: "C5000", label: "Case of 5000", variantId: 6, priceCents: 17999, quantity: 5, weightGrams: 5900 },
  P25: { code: "P25", label: "Pack of 25", variantId: 7, priceCents: 299, quantity: 50, weightGrams: 35 },
};

// ---------------------------------------------------------------------------
// Environment: sandbox only, decided before any server module is imported.
// ---------------------------------------------------------------------------

function loadSandboxEnvFile(): void {
  const file = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^(EBAY_SANDBOX_[A-Z_]+)=(.*)$/);
    // Only the sandbox names are read; nothing else in a local .env reaches this process.
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

function requireSandboxEnvironment(): { clientId: string; clientSecret: string; ruName: string; refreshToken: string } {
  loadSandboxEnvFile();
  const clientId = process.env.EBAY_SANDBOX_CLIENT_ID ?? "";
  const clientSecret = process.env.EBAY_SANDBOX_CLIENT_SECRET ?? "";
  const ruName = process.env.EBAY_SANDBOX_RUNAME ?? "";
  const refreshToken = process.env.EBAY_SANDBOX_REFRESH_TOKEN ?? "";
  if (!clientId || !clientSecret || !ruName || !refreshToken)
    throw new Error("Set EBAY_SANDBOX_CLIENT_ID, EBAY_SANDBOX_CLIENT_SECRET, EBAY_SANDBOX_RUNAME and EBAY_SANDBOX_REFRESH_TOKEN.");
  if (!clientId.includes("-SBX-") || clientId.includes("-PRD-"))
    throw new Error("EBAY_SANDBOX_CLIENT_ID is not an eBay sandbox key. Refusing to run.");
  // The server modules read these names. Point every one of them at the sandbox for this process only.
  process.env.EBAY_ENVIRONMENT = "sandbox";
  process.env.EBAY_CLIENT_ID = clientId;
  process.env.EBAY_CLIENT_SECRET = clientSecret;
  process.env.EBAY_RUNAME = ruName;
  delete process.env.EXTERNAL_DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://no-database:unused@127.0.0.1:1/ebay-sandbox-script";
  delete process.env.DRY_RUN;
  return { clientId, clientSecret, ruName, refreshToken };
}

// ---------------------------------------------------------------------------
// Network guard + transcript of every eBay call.
// ---------------------------------------------------------------------------

interface CallRecord { scenario: string; method: string; path: string; status: number | null; errorIds: number[]; message?: string }
const transcript: CallRecord[] = [];
let currentScenario = "setup";

function assertNotProductionEbay(hostname: string): void {
  if (/(^|\.)ebay\.com$/i.test(hostname) && !/\.sandbox\.ebay\.com$/i.test(hostname))
    throw new Error(`Blocked a request to production eBay host ${hostname}.`);
}

function recordCall(method: string, url: URL, status: number | null, body: string): void {
  if (!/ebay\.com$/i.test(url.hostname)) return;
  let errorIds: number[] = [];
  let message: string | undefined;
  try {
    const parsed = JSON.parse(body) as { errors?: Array<{ errorId?: number; message?: string; longMessage?: string }> };
    errorIds = (parsed.errors ?? []).map(error => error.errorId).filter((id): id is number => typeof id === "number");
    message = (parsed.errors ?? []).map(error => error.longMessage ?? error.message).filter(Boolean).join(" | ") || undefined;
  } catch {
    const xmlErrors = [...body.matchAll(/<ErrorCode>(\d+)<\/ErrorCode>/g)].map(match => Number(match[1]));
    if (xmlErrors.length) { errorIds = xmlErrors; message = [...body.matchAll(/<LongMessage>([^<]*)<\/LongMessage>/g)].map(match => match[1]).join(" | "); }
  }
  if (method !== "GET" && status !== null && status >= 400) console.log(`      raw: ${body.slice(0, 1800)}`);
  const record: CallRecord = { scenario: currentScenario, method, path: url.pathname + url.search, status, errorIds, ...(message ? { message } : {}) };
  transcript.push(record);
  const failed = status === null || status >= 400 || errorIds.length > 0;
  console.log(`  ${failed ? "✗" : "·"} ${method.padEnd(6)} ${record.path}  → ${status ?? "no response"}${errorIds.length ? `  errorIds=${errorIds.join(",")}` : ""}${message ? `\n      ${message.slice(0, 600)}` : ""}`);
}

function installNetworkGuard(): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assertNotProductionEbay(url.hostname);
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    try {
      const response = await originalFetch(input, init);
      if (/ebay\.com$/i.test(url.hostname)) recordCall(method, url, response.status, await response.clone().text());
      return response;
    } catch (error) {
      recordCall(method, url, null, "");
      throw error;
    }
  }) as typeof fetch;

  const originalRequest = https.request.bind(https);
  (https as { request: unknown }).request = (options: https.RequestOptions, callback?: (res: import("node:http").IncomingMessage) => void) => {
    const hostname = String(options.hostname ?? options.host ?? "");
    assertNotProductionEbay(hostname);
    return originalRequest(options, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => recordCall(String(options.method ?? "GET"), new URL(`https://${hostname}${options.path ?? "/"}`), res.statusCode ?? null, body));
      callback?.(res);
    });
  };
}

// ---------------------------------------------------------------------------
// Sandbox account helpers (plain REST, no connector).
// ---------------------------------------------------------------------------

async function mintAccessToken(credentials: ReturnType<typeof requireSandboxEnvironment>): Promise<string> {
  const response = await fetch(`${SANDBOX_API}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credentials.refreshToken, scope: SCOPES }),
  });
  const body = await response.json() as { access_token?: string; error_description?: string };
  if (!response.ok || !body.access_token) throw new Error(`Sandbox token refresh failed (${response.status}): ${body.error_description ?? "no detail"}`);
  return body.access_token;
}

function createRest(accessToken: string) {
  return async <T = unknown>(method: string, apiPath: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${SANDBOX_API}${apiPath}`, { method,
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json",
        "Content-Language": "en-US", "Accept-Language": "en-US" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let parsed: unknown = undefined;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    return { status: response.status, body: parsed as T };
  };
}
type Rest = ReturnType<typeof createRest>;

interface SandboxPolicies { fulfillmentPolicyId: string; returnPolicyId: string; paymentPolicyId: string }

async function readPolicies(rest: Rest): Promise<Partial<SandboxPolicies>> {
  const pick = <K extends string>(rows: Array<Record<string, unknown>> | undefined, idField: K): string | undefined =>
    rows?.find(row => String(row.name ?? "").startsWith(POLICY_NAME_PREFIX))?.[idField] as string | undefined;
  const fulfillment = await rest<{ fulfillmentPolicies?: Array<Record<string, unknown>> }>("GET", `/sell/account/v1/fulfillment_policy?marketplace_id=${MARKETPLACE_ID}`);
  const returns = await rest<{ returnPolicies?: Array<Record<string, unknown>> }>("GET", `/sell/account/v1/return_policy?marketplace_id=${MARKETPLACE_ID}`);
  const payment = await rest<{ paymentPolicies?: Array<Record<string, unknown>> }>("GET", `/sell/account/v1/payment_policy?marketplace_id=${MARKETPLACE_ID}`);
  return { fulfillmentPolicyId: pick(fulfillment.body?.fulfillmentPolicies, "fulfillmentPolicyId"),
    returnPolicyId: pick(returns.body?.returnPolicies, "returnPolicyId"), paymentPolicyId: pick(payment.body?.paymentPolicies, "paymentPolicyId") };
}

async function requirePolicies(rest: Rest): Promise<SandboxPolicies> {
  const policies = await readPolicies(rest);
  if (!policies.fulfillmentPolicyId || !policies.returnPolicyId || !policies.paymentPolicyId)
    throw new Error("Sandbox business policies are missing. Run the `setup` command first.");
  return policies as SandboxPolicies;
}

async function setup(rest: Rest): Promise<void> {
  const categoryTypes = [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }];
  await rest("POST", "/sell/account/v1/program/opt_in", { programType: "SELLING_POLICY_MANAGEMENT" });
  const existing = await readPolicies(rest);
  if (!existing.fulfillmentPolicyId) await rest("POST", "/sell/account/v1/fulfillment_policy", {
    name: `${POLICY_NAME_PREFIX} shipping`, marketplaceId: MARKETPLACE_ID, categoryTypes, handlingTime: { value: 1, unit: "DAY" },
    shippingOptions: [{ optionType: "DOMESTIC", costType: "FLAT_RATE", shippingServices: [{ sortOrder: 1,
      shippingCarrierCode: "USPS", shippingServiceCode: "USPSPriority", freeShipping: true,
      shippingCost: { value: "0.00", currency: "USD" } }] }] });
  if (!existing.returnPolicyId) await rest("POST", "/sell/account/v1/return_policy", {
    name: `${POLICY_NAME_PREFIX} returns`, marketplaceId: MARKETPLACE_ID, categoryTypes, returnsAccepted: true,
    returnPeriod: { value: 30, unit: "DAY" }, returnShippingCostPayer: "SELLER", refundMethod: "MONEY_BACK" });
  if (!existing.paymentPolicyId) await rest("POST", "/sell/account/v1/payment_policy", {
    name: `${POLICY_NAME_PREFIX} payment`, marketplaceId: MARKETPLACE_ID, categoryTypes, immediatePay: false });
  const location = await rest("GET", `/sell/inventory/v1/location/${MERCHANT_LOCATION_KEY}`);
  if (location.status !== 200) await rest("POST", `/sell/inventory/v1/location/${MERCHANT_LOCATION_KEY}`, {
    name: "Echelon sandbox warehouse", merchantLocationStatus: "ENABLED", locationTypes: ["WAREHOUSE"],
    location: { address: { addressLine1: "2145 Hamilton Ave", city: "San Jose", stateOrProvince: "CA", postalCode: "95125", country: "US" } } });
  const policies = await readPolicies(rest);
  console.log("\nSandbox account:", JSON.stringify({ ...policies, merchantLocationKey: MERCHANT_LOCATION_KEY }));
}

// ---------------------------------------------------------------------------
// The production code under test.
// ---------------------------------------------------------------------------

async function loadProductionCode() {
  const [connectorModule, clientModule, draftModule, packageModule] = await Promise.all([
    import("../server/modules/channels/listing-connectors/ebay-listing.connector"),
    import("../server/modules/channels/infrastructure/ebay-listing-client"),
    import("../server/modules/channels/application/ebay-listing-draft"),
    import("../server/modules/channels/adapters/ebay/ebay-listing-package"),
  ]);
  return { ...connectorModule, ...clientModule, ...draftModule, ...packageModule };
}
type ProductionCode = Awaited<ReturnType<typeof loadProductionCode>>;
type LifecycleClient = ReturnType<ProductionCode["createEbayRouteListingLifecycleClient"]>;
type Draft = Parameters<InstanceType<ProductionCode["EbayMarketplaceListingConnector"]>["pushListing"]>[0]["draft"];

const skuOf = (run: string, size: Size): string => `${run}-${size.code}`;

/** Same window the real owner applies after eBay refuses a write (EBAY_REJECTION_RETRY_MS in ebay-quantity-http.ts). */
const EMULATED_REJECTION_COOLDOWN_MS = 60_000;

/**
 * Stand-in for the Postgres quantity admission. It hands the protocol in
 * `quantity-publication-request.ts` the canonical quantity of each SKU the way
 * the real owner does, so the protocol's own eBay reads and quantity refreshes
 * run unchanged. It takes no locks and journals nothing.
 *
 * It does emulate one rule of the real owner, because that rule decides whether
 * a fallback inside a single change can work: after eBay refuses a write (a 400
 * the transport classifies as rejected), every scope that write held is cooled
 * for 60 seconds and the next write on any of them is refused before it is sent
 * (quantity-provider-request-evidence.repository.ts `finish`,
 * quantity-publication-admission.repository.ts PUBLICATION_PROVIDER_COOLDOWN).
 * The real owner's handling of a 5xx (scope blocked until reconciliation) is NOT emulated.
 */
function createCanonicalQuantityAdmission(run: string, zeroStock: readonly Size[]) {
  // --zero-stock names sizes the warehouse has none of: their canonical quantity is 0, as it is for a real size
  // with no stock. Without it the stand-in would "restock" a size the scenario zeroed on eBay.
  const quantityBySku = new Map(Object.values(SIZES).map(size => [skuOf(run, size), zeroStock.includes(size) ? 0 : size.quantity]));
  const quantityOf = (sku: string): number => {
    const quantity = quantityBySku.get(sku);
    if (quantity === undefined) throw new Error(`No canonical quantity for ${sku}.`);
    return quantity;
  };
  const cooledUntil = new Map<string, number>();
  const admit = async <T>(scopes: readonly string[], work: () => Promise<T>): Promise<T> => {
    const cooled = scopes.find(scope => (cooledUntil.get(scope) ?? 0) > Date.now());
    if (cooled) {
      console.log(`  ✗ admission refused before sending: emulated provider cooldown on ${cooled}`);
      throw Object.assign(new Error("PUBLICATION_PROVIDER_COOLDOWN (emulated): The provider retry window has not opened; no quantity request was sent."),
        { code: "PUBLICATION_PROVIDER_COOLDOWN" });
    }
    try { return await work(); }
    catch (error) {
      if (error instanceof Error && error.name === "QuantityProviderRejectionError")
        for (const scope of scopes) cooledUntil.set(scope, Date.now() + EMULATED_REJECTION_COOLDOWN_MS);
      throw error;
    }
  };
  return {
    item: <T>(sku: string, work: (quantity: number | null) => Promise<T>) => admit([sku], () => work(quantityOf(sku))),
    group: <T>(groupKey: string, skus: readonly string[], work: (quantities: ReadonlyMap<string, number> | null, retained?: readonly string[]) => Promise<T>) =>
      admit([`group:${groupKey}`, ...skus], () => work(new Map(skus.map(sku => [sku, quantityOf(sku)])))),
    reducing: <T>(identity: string, work: () => Promise<T>, memberSkus?: readonly string[]) => admit([identity, ...(memberSkus ?? [])], work),
  };
}

/** Longer than the emulated cooldown, so a repeat is not refused by the admission stand-in. */
const SANDBOX_FAULT_RETRY_DELAYS_MS = [61_000, 61_000, 61_000];
let sandboxFaultRetries = 0;

function isSandboxReviseFault(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(25019|25002)\b/.test(message);
}

function retryingIdempotentWrites(client: LifecycleClient): LifecycleClient {
  const idempotent = ["createOrReplaceInventoryItem", "createOrReplaceInventoryItemGroup", "updateOffer",
    "publishOfferByInventoryItemGroup", "bulkUpdatePriceQuantity"] as const;
  const wrapped = { ...client } as Record<string, unknown>;
  for (const name of idempotent) {
    const original = (client as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name];
    wrapped[name] = async (...args: unknown[]) => {
      for (let attempt = 0; ; attempt += 1) {
        try { return await original(...args); }
        catch (error) {
          const delayMs = SANDBOX_FAULT_RETRY_DELAYS_MS[attempt];
          if (delayMs === undefined || !isSandboxReviseFault(error)) throw error;
          sandboxFaultRetries += 1;
          console.log(`      script retry ${attempt + 1} of ${name} after ${delayMs} ms (connector would have stopped here)`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    };
  }
  return wrapped as unknown as LifecycleClient;
}

async function buildDraft(code: ProductionCode, client: LifecycleClient, input: { run: string; sizes: Size[]; policies: SandboxPolicies;
  listingId: string | null; offerIds: Record<number, string | null> }): Promise<Draft> {
  const variants = input.sizes.map(size => ({ id: size.variantId, sku: skuOf(input.run, size), name: size.label,
    option1_name: VARIATION_ASPECT, option1_value: size.label, price_cents: size.priceCents, weight_grams: size.weightGrams,
    length_mm: 203, width_mm: 178, height_mm: 178 }));
  const built = code.buildEbayRouteListingDraft({ productId: PRODUCT_ID,
    product: { name: `Sandbox Glove-Fit Sleeves ${input.run}`, sku: input.run, description: "<p>Echelon sandbox membership test listing.</p>" },
    variants, photoPlan: { byVariantId: new Map(variants.map(variant => [variant.id, [IMAGE_URL]])), groupImageUrls: [IMAGE_URL] },
    aspects: { Brand: ["Shellz"], Type: ["Card Sleeves"] }, isMultiVariant: true, variationAspectName: VARIATION_ASPECT,
    variantPrices: new Map(variants.map(variant => [variant.id, variant.price_cents])),
    atpByVariantId: new Map(input.sizes.map(size => [size.variantId, size.quantity])),
    marketplaceId: MARKETPLACE_ID, ebayBrowseCategoryId: CATEGORY_ID,
    resolvedPoliciesByVariantId: new Map(variants.map(variant => [variant.id, input.policies])),
    storeCategoryNames: [], merchantLocationKey: MERCHANT_LOCATION_KEY,
    ...(input.listingId ? { existingGroupKey: input.run } : {}) });
  let draft: Draft = { productId: PRODUCT_ID, marketplaceId: MARKETPLACE_ID, inventoryItems: built.inventoryItems, offers: built.offers,
    itemGroup: built.itemGroup, publishMode: "publish", hasExistingExternalIds: input.listingId !== null,
    existingExternalProductId: input.listingId ?? undefined, existingOfferIdsByVariantId: input.offerIds };
  if (input.listingId && draft.itemGroup) {
    // Same alignment `preparePushDraft` applies for an in-place update (ebay-listing-push.ts).
    const liveGroup = await client.getInventoryItemGroup(draft.itemGroup.groupKey);
    if (!liveGroup) throw new Error("The sandbox group was not found while preparing the update.");
    draft = code.alignDraftVariationSchemaToLiveGroup({ draft: { ...draft, itemGroup: draft.itemGroup }, liveGroup });
  }
  return code.prepareEbayListingPackages(client, draft);
}

interface ListingState { group: { variantSKUs: string[]; values: string[] } | null; listingId: string | null;
  offers: Array<{ sku: string; offerId: string | null; status: string | null; listingId: string | null; availableQuantity: number | null; soldQuantity: number | null }> }

async function readState(rest: Rest, run: string): Promise<ListingState> {
  const group = await rest<{ variantSKUs?: string[]; variesBy?: { specifications?: Array<{ values?: string[] }> } }>("GET", `/sell/inventory/v1/inventory_item_group/${run}`);
  const members = new Set<string>([...(group.status === 200 ? group.body.variantSKUs ?? [] : []), ...Object.values(SIZES).map(size => skuOf(run, size))]);
  const offers: ListingState["offers"] = [];
  for (const sku of [...members].sort()) {
    const response = await rest<{ offers?: Array<Record<string, any>> }>("GET", `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${MARKETPLACE_ID}`);
    const offer = response.status === 200 ? response.body.offers?.[0] : undefined;
    if (!offer && !(group.body?.variantSKUs ?? []).includes(sku)) continue;
    offers.push({ sku, offerId: offer?.offerId ?? null, status: offer?.status ?? null, listingId: offer?.listing?.listingId ?? null,
      availableQuantity: offer?.availableQuantity ?? null, soldQuantity: offer?.listing?.soldQuantity ?? null });
  }
  const listingIds = [...new Set(offers.map(offer => offer.listingId).filter((id): id is string => Boolean(id)))];
  return { group: group.status === 200 ? { variantSKUs: [...(group.body.variantSKUs ?? [])].sort(),
    values: group.body.variesBy?.specifications?.[0]?.values ?? [] } : null, listingId: listingIds.length === 1 ? listingIds[0] : null, offers };
}

function printState(label: string, state: ListingState): void {
  console.log(`\n  ${label}: listing ${state.listingId ?? "none"}; group members ${state.group ? state.group.variantSKUs.join(", ") : "(no group)"}`);
  if (state.group) console.log(`    group ${VARIATION_ASPECT} values: ${state.group.values.join(" | ")}`);
  for (const offer of state.offers)
    console.log(`    ${offer.sku}: offer ${offer.offerId ?? "none"} ${offer.status ?? ""} qty=${offer.availableQuantity ?? "-"} sold=${offer.soldQuantity ?? "-"} listing=${offer.listingId ?? "-"}`);
}

/**
 * What buyers see: the live listing's own variations, read through the Trading API. The Inventory API's group and
 * offers are eBay's record of what the seller asked for; this is the listing itself, and the two can disagree.
 */
async function printLiveListing(accessToken: string, listingId: string): Promise<void> {
  const response = await fetch(`${SANDBOX_API}/ws/api.dll`, { method: "POST",
    headers: { "Content-Type": "text/xml", "X-EBAY-API-CALL-NAME": "GetItem", "X-EBAY-API-COMPATIBILITY-LEVEL": "1477",
      "X-EBAY-API-SITEID": "0", "X-EBAY-API-IAF-TOKEN": accessToken },
    body: `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${listingId}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics></GetItemRequest>` });
  const xml = await response.text();
  const status = xml.match(/<ListingStatus>([^<]*)<\/ListingStatus>/)?.[1] ?? "unknown";
  const variations = [...xml.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)].map(match => ({
    sku: match[1].match(/<SKU>([^<]*)<\/SKU>/)?.[1] ?? "?", quantity: match[1].match(/<Quantity>(\d+)<\/Quantity>/)?.[1] ?? "?",
    sold: match[1].match(/<QuantitySold>(\d+)<\/QuantitySold>/)?.[1] ?? "?" }));
  console.log(`\n  live listing ${listingId} (${status}) as buyers see it:`);
  for (const variation of variations) console.log(`    ${variation.sku}: quantity=${variation.quantity} sold=${variation.sold} (available ${Number(variation.quantity) - Number(variation.sold)})`);
  if (!variations.length) console.log("    (no variations returned)");
}

function sizesFromArg(value: string): Size[] {
  return value.split(",").map(code => {
    const size = SIZES[code.trim().toUpperCase()];
    if (!size) throw new Error(`Unknown size ${code}. Known: ${Object.keys(SIZES).join(", ")}.`);
    return size;
  });
}

/** The owner's "Update existing listing" action: review (preview), then apply the reviewed change. */
async function reviewedUpdate(code: ProductionCode, client: LifecycleClient, rest: Rest, input: { run: string; desired: Size[]; policies: SandboxPolicies }) {
  const before = await readState(rest, input.run);
  printState("before", before);
  if (!before.listingId) throw new Error("No single live sandbox listing was found for this run.");
  const offerIds = Object.fromEntries(input.desired.map(size => [size.variantId, before.offers.find(offer => offer.sku === skuOf(input.run, size))?.offerId ?? null]));
  const connector = new code.EbayMarketplaceListingConnector({ delay: ms => new Promise(resolve => setTimeout(resolve, ms)) });
  const draft = await buildDraft(code, client, { run: input.run, sizes: input.desired, policies: input.policies, listingId: before.listingId, offerIds });
  const preview = await connector.previewListingRebuild({ client, draft, currentExternalListingId: before.listingId });
  console.log(`\n  review: add [${preview.addedSkus.join(", ")}] remove [${preview.removedSkus.join(", ")}] active [${preview.activeSkus.join(", ")}] inactive [${preview.inactiveSkus.join(", ")}]`);
  const result = await connector.updateExistingListing({ client, draft, preview });
  console.log(`\n  connector result: listing ${result.externalProductId}; removed [${result.removedSkus.join(", ")}]; offers ${JSON.stringify(result.externalOfferIds)}`);
  return result;
}

async function main(): Promise<void> {
  const [command, ...rest0] = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const index = rest0.indexOf(`--${name}`); return index >= 0 ? rest0[index + 1] : undefined; };
  if (!command) throw new Error("Command required: setup | a | b | c | d | e | update | raw-add | state | cleanup");
  const credentials = requireSandboxEnvironment();
  installNetworkGuard();
  const accessToken = await mintAccessToken(credentials);
  const rest = createRest(accessToken);
  currentScenario = command;
  console.log(`\n=== ${command} (eBay sandbox) ===`);

  if (command === "setup") { await setup(rest); return; }
  if (command === "rest") {
    // One plain sandbox call, for probing what eBay itself does: rest <METHOD> <path> [--body '<json>']
    const [method, apiPath] = rest0;
    if (!method || !apiPath?.startsWith("/")) throw new Error("Usage: rest <METHOD> </path> [--body '<json>' | --body-file <path>]");
    const bodyFile = flag("body-file");
    const body = bodyFile ? fs.readFileSync(bodyFile, "utf8") : flag("body");
    const response = await rest(method.toUpperCase(), apiPath, body === undefined ? undefined : JSON.parse(body));
    console.log(JSON.stringify(response.body, null, 1)?.slice(0, 6000));
    return;
  }

  const run = flag("run") ?? (command === "a" ? `SBX${Date.now().toString(36).toUpperCase()}` : undefined);
  if (!run || !/^SBX[A-Z0-9]{4,20}$/.test(run)) throw new Error("Pass --run <id> (printed by scenario a).");
  console.log(`run id: ${run}`);

  if (command === "state") {
    const state = await readState(rest, run);
    printState("state", state);
    if (state.listingId) await printLiveListing(accessToken, state.listingId);
    return;
  }

  const code = await loadProductionCode();
  const admission = createCanonicalQuantityAdmission(run, flag("zero-stock") ? sizesFromArg(flag("zero-stock")!) : []);
  const productionClient = code.createEbayRouteListingLifecycleClient({ accessToken, quantityAdmission: async () => admission });
  // The sandbox answers the same idempotent write with 25019 "Cannot revise listing ... try again later" or
  // 500/25002 on one call and 204 on the next (observed 2026-11-16). The connector does not retry these. With
  // --retry-sandbox-faults the script repeats only idempotent writes so the rest of a sequence can be observed;
  // every repeat is printed, and a run that needed one did NOT pass as the connector is written.
  const client = rest0.includes("--retry-sandbox-faults") ? retryingIdempotentWrites(productionClient) : productionClient;

  if (command === "cleanup") {
    const state = await readState(rest, run);
    if (state.listingId) await client.withdrawOfferByInventoryItemGroup(run, MARKETPLACE_ID).catch(error => console.log(`  withdraw refused: ${(error as Error).message.slice(0, 200)}`));
    if (state.group) await client.deleteInventoryItemGroup(run).catch(error => console.log(`  group delete refused: ${(error as Error).message.slice(0, 200)}`));
    for (const size of Object.values(SIZES)) await client.deleteInventoryItem(skuOf(run, size)).catch(() => undefined);
    printState("after cleanup", await readState(rest, run));
    return;
  }

  const policies = await requirePolicies(rest);
  try {
    if (command === "a") {
      // a. publish a two-size listing through the connector's publication path.
      const sizes = sizesFromArg(flag("sizes") ?? "P50,C5000");
      const connector = new code.EbayMarketplaceListingConnector({ delay: ms => new Promise(resolve => setTimeout(resolve, ms)) });
      const draft = await buildDraft(code, client, { run, sizes, policies, listingId: null, offerIds: {} });
      const result = await connector.pushListing({ client, draft });
      console.log(`\n  connector result: listing ${result.externalProductId}; offers ${JSON.stringify(result.externalOfferIds)}`);
    } else if (command === "b") {
      // b. add a third size to the live listing.
      await reviewedUpdate(code, client, rest, { run, desired: sizesFromArg(flag("sizes") ?? "P50,C500,C5000"), policies });
    } else if (command === "c") {
      // c. add one size and remove another in one reviewed change (the product 54 case).
      await reviewedUpdate(code, client, rest, { run, desired: sizesFromArg(flag("sizes") ?? "P50,C500,C2500"), policies });
    } else if (command === "raw-add") {
      // Builds a half-applied state the way the code before PR 2095 did: one group write naming exactly --sizes,
      // where a size new to the listing has an inventory item but NO offer. Sizes left out are removed by that write.
      const target = sizesFromArg(flag("sizes") ?? "");
      const state = await readState(rest, run);
      if (!state.group || !state.listingId) throw new Error("No live sandbox group for this run.");
      const offerIds = Object.fromEntries(target.map(member => [member.variantId, state.offers.find(offer => offer.sku === skuOf(run, member))?.offerId ?? null]));
      const draft = await buildDraft(code, client, { run, sizes: target, policies, listingId: state.listingId, offerIds });
      for (const item of draft.inventoryItems) {
        if (state.offers.some(offer => offer.sku === item.sku && offer.offerId)) continue;
        await client.createOrReplaceInventoryItem(item.sku, item.payload);
      }
      await client.createOrReplaceInventoryItemGroup(run, draft.itemGroup!.payload)
        .then(() => console.log("\n  eBay ACCEPTED the group write."))
        .catch(error => console.log(`\n  eBay refused the group write: ${(error as Error).message.slice(0, 300)}`));
    } else if (command === "d" || command === "e" || command === "update") {
      // d. resume from a half-applied state; e. remove a size that has sales; update: any reviewed change.
      const sizes = flag("sizes");
      if (!sizes) throw new Error("Pass --sizes with the desired final sizes, e.g. --sizes P50,C500,C2500,P100");
      await reviewedUpdate(code, client, rest, { run, desired: sizesFromArg(sizes), policies });
    } else throw new Error(`Unknown command ${command}.`);
    if (command === "raw-add") console.log("\n  RESULT: state prepared (this command does not run the connector's update).");
    else console.log(sandboxFaultRetries === 0 ? "\n  RESULT: the connector completed without error."
      : `\n  RESULT: completed ONLY with ${sandboxFaultRetries} script retr${sandboxFaultRetries === 1 ? "y" : "ies"} of an eBay fault; the connector alone would have failed.`);
  } catch (error) {
    const failure = error as Error & { code?: string; statusCode?: number; errorIds?: number[] };
    console.log(`\n  RESULT: FAILED ${failure.name}${failure.code ? ` code=${failure.code}` : ""}${failure.statusCode ? ` http=${failure.statusCode}` : ""}${failure.errorIds?.length ? ` errorIds=${failure.errorIds.join(",")}` : ""}`);
    console.log(`    ${failure.message.slice(0, 1500)}`);
    process.exitCode = 1;
  } finally {
    const after = await readState(rest, run);
    printState("after", after);
    if (after.listingId) await printLiveListing(accessToken, after.listingId).catch(error => console.log(`  live listing read failed: ${(error as Error).message}`));
    // A 404 on a read is eBay saying "not there", not a refusal; only writes count as refused.
    const failures = transcript.filter(call => call.scenario === command && call.method !== "GET" && (call.status === null || call.status >= 400));
    console.log(`\n  eBay calls: ${transcript.length}; refused: ${failures.length}${failures.length ? ` (${failures.map(call => `${call.method} ${call.path.split("?")[0]} ${call.status} [${call.errorIds.join(",")}]`).join("; ")})` : ""}`);
  }
}

main().then(() => process.exit(process.exitCode ?? 0), error => { console.error(`\nFATAL: ${(error as Error).message}`); process.exit(1); });
