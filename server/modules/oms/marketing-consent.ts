/**
 * Extract marketing-consent facts from a channel order payload.
 *
 * WHY this exists: the OMS is the only system that sees the raw checkout
 * payload, and Shopify's marketing-consent state lives *only* there — it is
 * not on any oms_orders column. Archon (the CRM) cannot mail a customer
 * without affirmative consent evidence, so without this extractor every
 * purchaser becomes an unmailable profile. This function is the sanctioned
 * pass-through: it reads the stored raw payload and hands the CRM a narrow,
 * validated snapshot. It records nothing and decides nothing.
 *
 * Pure: no IO, no clock, no mutation of the input. Unknown/absent shapes
 * yield "unknown" — never a guessed subscription.
 */

/** Shopify's `email_marketing_consent.state` vocabulary, plus our own
 *  "unknown" for payloads that carry no consent information at all
 *  (eBay/Amazon orders, or Shopify payloads predating the consent object). */
export type MarketingConsentState =
  | "subscribed"
  | "not_subscribed"
  | "unsubscribed"
  | "pending"
  | "redacted"
  | "unknown";

const KNOWN_STATES: readonly MarketingConsentState[] = [
  "subscribed",
  "not_subscribed",
  "unsubscribed",
  "pending",
  "redacted",
];

/** Where the snapshot came from — the CRM stores this as consent evidence. */
export type MarketingConsentEvidence =
  /** Shopify's structured {state, opt_in_level, consent_updated_at} object. */
  | "consent_object"
  /** The legacy boolean (`buyer_accepts_marketing` / `accepts_marketing`). */
  | "legacy_flag"
  /** Nothing in the payload spoke to consent. */
  | "absent";

export interface ChannelConsentSnapshot {
  state: MarketingConsentState;
  /** Shopify: "single_opt_in" | "confirmed_opt_in" | "unknown". */
  optInLevel: string | null;
  /** ISO-8601 instant Shopify last changed this state, when it supplies one.
   *  The CRM uses it as the ledger row's occurred_at so a stale checkout
   *  snapshot cannot overwrite a newer preference-page decision. */
  updatedAt: string | null;
  evidence: MarketingConsentEvidence;
}

export interface ChannelMarketingConsent {
  email: ChannelConsentSnapshot;
  sms: ChannelConsentSnapshot;
}

const ABSENT: ChannelConsentSnapshot = {
  state: "unknown",
  optInLevel: null,
  updatedAt: null,
  evidence: "absent",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asState(value: unknown): MarketingConsentState | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (KNOWN_STATES as readonly string[]).includes(normalized)
    ? (normalized as MarketingConsentState)
    : null;
}

function asIsoString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function asOptInLevel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, 40);
}

/** Read one Shopify `*_marketing_consent` object. Returns null when the
 *  object is missing or carries a state we do not recognise — an unknown
 *  vocabulary word must not be silently coerced into a subscription. */
function readConsentObject(raw: unknown): ChannelConsentSnapshot | null {
  if (!isRecord(raw)) return null;
  const state = asState(raw.state);
  if (state === null) return null;
  return {
    state,
    optInLevel: asOptInLevel(raw.opt_in_level),
    updatedAt: asIsoString(raw.consent_updated_at),
    evidence: "consent_object",
  };
}

/** Fall back to Shopify's legacy boolean. `false` is "did not opt in", NOT
 *  "opted out" — the distinction matters downstream, where not_subscribed
 *  writes no ledger row and unsubscribed writes a revocation. */
function readLegacyFlag(raw: unknown): ChannelConsentSnapshot | null {
  if (typeof raw !== "boolean") return null;
  return {
    state: raw ? "subscribed" : "not_subscribed",
    optInLevel: null,
    updatedAt: null,
    evidence: "legacy_flag",
  };
}

/**
 * @param rawPayload the channel payload stored on oms_orders.raw_payload.
 *   Anything that is not a Shopify-shaped order yields two "unknown"
 *   snapshots, which the CRM treats as "say nothing about consent".
 */
export function extractMarketingConsent(rawPayload: unknown): ChannelMarketingConsent {
  if (!isRecord(rawPayload)) return { email: ABSENT, sms: ABSENT };

  const customer = isRecord(rawPayload.customer) ? rawPayload.customer : null;

  const email =
    (customer ? readConsentObject(customer.email_marketing_consent) : null) ??
    // Order-level flag first: it records what happened at THIS checkout,
    // whereas customer.accepts_marketing is the account-wide rollup.
    readLegacyFlag(rawPayload.buyer_accepts_marketing) ??
    (customer ? readLegacyFlag(customer.accepts_marketing) : null) ??
    ABSENT;

  const sms = (customer ? readConsentObject(customer.sms_marketing_consent) : null) ?? ABSENT;

  return { email, sms };
}
