import { z } from "zod";
import type { ListingSettingsPolicyKind } from "@shared/dropship/listing-settings";
import { LISTING_SETUP_RELOAD_MESSAGE, listingSetupRevision } from "./dropship-ebay-listing-setup";
import { bannerFromWriteError, type ConnectionBanner } from "./dropship-listing-settings-access";
import {
  LISTING_SETTINGS_KEY_PREFIXES,
  LISTING_SETTINGS_SAVE_WORDS,
  classifyWriteFailure,
  type EditorId,
  type WriteFailure,
} from "./dropship-listing-settings-drafts";
import { CHECKING_EBAY, rightReasonLine, shippingPolicyFit, type ShippingPolicyFit } from "./dropship-listing-settings-words";
import {
  postJson,
  putJson,
  type DropshipEbayListingSetupResponse,
  type DropshipEbayListingSetupSaveRequest,
  type DropshipEbayShipFromRepairRequest,
  type DropshipEbayStoreCategoryOption,
} from "./dropship-ops-surface";

/**
 * The store default policy and shelf rows, and the ship-from note, of the
 * Listing settings step (Listing settings PR 7, sub-part 2A): the requests
 * they send, how a save runs, and the editor rules they follow.
 *
 * Writers (plan 4.5):
 * - W2, `PUT /api/dropship/ebay/listing-setup/:id`: exactly one policy, or
 *   the store shelf default, against the revision of the live setup read.
 * - W10, `POST /api/dropship/ebay/listing-setup/:id/ship-from/repair`.
 *
 * A request is planned before it gets a key: its signature is the request
 * without its key, so the same request always reuses its key (a retry is
 * answered from the first save, never saved twice) and any change gets a new
 * one. "Check again" rebuilds the request from the signature alone, so it
 * resends exactly what was sent.
 *
 * Pure apart from `runStoreSetupSave`, whose network, cache and clock work is
 * passed in. Words marked interim are not in the design record yet; they
 * live here so a later PR can change them in one place.
 */

// ---------------------------------------------------------------------------
// Words (R:190-199, R:503, R:510-513, R:581)
// ---------------------------------------------------------------------------

/** Where a vendor makes or edits eBay business policies (as `client/src/pages/EbaySettings.tsx`). */
export const EBAY_SELLER_HUB_POLICIES_URL = "https://www.ebay.com/sh/sell-preferences/business-policies";

const POLICY_KIND_WORDS: Readonly<Record<ListingSettingsPolicyKind, string>> = {
  shipping: "shipping",
  return: "return",
  payment: "payment",
};

export const STORE_DEFAULT_EDITOR_WORDS = Object.freeze({
  sellerHubPrompt: "Don't see the one you want? Make it in eBay Seller Hub, then check again.",
  openSellerHub: "Open eBay Seller Hub ↗",
  checkEbayAgain: "Check eBay again",
  checkingEbay: CHECKING_EBAY,
  suggested: "Suggested · not saved",
  noneFits: "None of your eBay shipping policies work with Card Shellz shipping.",
  chooseAnother: "Choose another",
  shipFromNeeded: "Card Shellz needs to update where your items ship from.",
  updateNow: "Update now",
  saveOrCancelPolicyFirst: rightReasonLine("save_policy_first") ?? "Save or cancel your policy change first.",
  details: "Details",
  shelfIntro: "Shelves are the categories in your own eBay store. Optional.",
  shelf: "Shelf",
  secondShelf: "Second shelf (optional)",
  pickFirstShelfFirst: "Pick a first shelf first",
  shelvesIndependent: "Changing the first shelf never changes the second one.",
  none: "None",
  noShelves: "Your eBay store has no shelves. That's fine: shelves are optional.",
  shelfGone: LISTING_SETTINGS_SAVE_WORDS.shelfGone,
  // Interim: the server's own words for two equal shelves.
  sameShelfTwice: "Pick two different shelves.",
  // Interim: "None" while the shelves can't be read (a sign-in), when the pickers are off.
  setShelfToNone: "Set to None",
  // Interim: the shelf can't be read because eBay can't be read.
  shelfUnknown: "Can't check eBay right now",
  // Interim: the shelf picker's search.
  shelfSearch: "Search your shelves",
  shelfSearchEmpty: "No matching shelves.",
  // Interim: the ship-from repair named in the bar and the leave prompt.
  shipFromPlace: "Ship-from location",
  // Interim: "Update now" reads the setup first; that read failed, so no repair was sent.
  shipFromCheckFailed: "Couldn't check where your items ship from. Nothing was changed. Try again.",
  // Interim (C20): beside a field the vendor and another window both changed.
  changedElsewhereToo: "Changed in another window too",
} as const);

/** "You don't have a return policy on eBay yet. Make one in eBay Seller Hub, then check again." (R:510) */
export function noPolicyOnEbayWords(kind: ListingSettingsPolicyKind): string {
  return `You don't have a ${POLICY_KIND_WORDS[kind]} policy on eBay yet. Make one in eBay Seller Hub, then check again.`;
}

/** "Reference R-…", the support code for an unfinished Card Shellz shipping setup (R:503). */
export function shippingSetupReferenceWords(reference: string): string {
  return `Reference ${reference}`;
}

// ---------------------------------------------------------------------------
// Request errors (built here, before anything is sent)
// ---------------------------------------------------------------------------

export const STORE_SETUP_REQUEST_ERROR_CODES = [
  /** The setup read carries no revision: the page must reload before saving. */
  "DROPSHIP_LISTING_SETTINGS_RELOAD_REQUIRED",
  "DROPSHIP_LISTING_SETTINGS_STORE_INVALID",
  "DROPSHIP_LISTING_SETTINGS_POLICY_INVALID",
  "DROPSHIP_LISTING_SETTINGS_SHELF_INVALID",
  "DROPSHIP_LISTING_SETTINGS_REQUEST_KEY_INVALID",
  /** A signature this module did not make (a corrupted draft). */
  "DROPSHIP_LISTING_SETTINGS_SIGNATURE_INVALID",
] as const;
export type StoreSetupRequestErrorCode = (typeof STORE_SETUP_REQUEST_ERROR_CODES)[number];

/** A request this page refuses to send, with a namespaced code and what was refused. */
export class StoreSetupRequestError extends Error {
  readonly code: StoreSetupRequestErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(input: { code: StoreSetupRequestErrorCode; message: string; context?: Record<string, unknown> }) {
    super(input.message);
    this.name = "StoreSetupRequestError";
    this.code = input.code;
    this.context = Object.freeze({ ...(input.context ?? {}) });
  }
}

// ---------------------------------------------------------------------------
// Request bodies (the server's schemas, mirrored: dropship-ebay-listing-setup-service.ts)
// ---------------------------------------------------------------------------

/** PostgreSQL integer, the revision column's type. */
const MAX_REVISION = 2_147_483_647;
/** eBay business policy ids, as the server accepts them (trimmed). */
const MAX_POLICY_ID_LENGTH = 100;
/** eBay store shelf ids, as the server accepts them (trimmed). */
const MAX_SHELF_ID_LENGTH = 40;
/** eBay takes a first and a second store shelf. */
export const MAX_STORE_SHELVES = 2;

const requestKeySchema = z.string().min(8).max(200).regex(/^[A-Za-z0-9:_-]+$/);
const revisionSchema = z.number().int().positive().max(MAX_REVISION);
const trimmedText = (max: number) => z.string().min(1).max(max).refine((value) => value === value.trim());
const policyIdSchema = trimmedText(MAX_POLICY_ID_LENGTH);
const shelfIdSchema = trimmedText(MAX_SHELF_ID_LENGTH);

/** W2 with one policy: exactly one of the three, so a return or payment change needs no Card Shellz shipping check. */
const policySaveBodySchema = z.object({
  expectedRevision: revisionSchema,
  idempotencyKey: requestKeySchema,
  fulfillmentPolicyId: policyIdSchema.optional(),
  returnPolicyId: policyIdSchema.optional(),
  paymentPolicyId: policyIdSchema.optional(),
}).strict().refine(
  (body) => [body.fulfillmentPolicyId, body.returnPolicyId, body.paymentPolicyId].filter((id) => id !== undefined).length === 1,
  "A policy save sends exactly one policy.",
);

/** W2 with the shelf default: one or two different shelves, or null for "None". */
const shelfSaveBodySchema = z.object({
  expectedRevision: revisionSchema,
  idempotencyKey: requestKeySchema,
  storeShelfDefault: z.object({ ids: z.array(shelfIdSchema).min(1).max(MAX_STORE_SHELVES) }).strict().nullable(),
}).strict().refine(
  (body) => body.storeShelfDefault === null || new Set(body.storeShelfDefault.ids).size === body.storeShelfDefault.ids.length,
  STORE_DEFAULT_EDITOR_WORDS.sameShelfTwice,
);

/** W10. */
const shipFromRepairBodySchema = z.object({
  expectedRevision: revisionSchema,
  idempotencyKey: requestKeySchema,
}).strict();

// ---------------------------------------------------------------------------
// Request plans
// ---------------------------------------------------------------------------

export type StoreSetupWriter = "W2" | "W10";
export type StoreSetupRequestKind = "policy" | "shelf" | "ship_from";
type StoreSetupBody = DropshipEbayListingSetupSaveRequest | DropshipEbayShipFromRepairRequest;

/** A request ready for a key: what it is, and its signature (the request without its key). */
export interface StoreSetupSavePlan {
  writer: StoreSetupWriter;
  kind: StoreSetupRequestKind;
  storeConnectionId: number;
  /** The request key prefix (`createDropshipIdempotencyKey(prefix)`). */
  keyPrefix: string;
  /** Stable for the same request; any change gives another. Holds everything needed to send it again. */
  signature: string;
}

/** A request with its key, ready to send. */
export interface StoreSetupRequest {
  writer: StoreSetupWriter;
  method: "PUT" | "POST";
  path: string;
  body: StoreSetupBody;
}

/** The setup facts a request needs: whose store, and the revision the vendor saw. */
export type StoreSetupRevisionFacts = Pick<DropshipEbayListingSetupResponse, "storeConnectionId" | "revision">;

export const POLICY_FIELD_BY_KIND = Object.freeze({
  shipping: "fulfillmentPolicyId",
  return: "returnPolicyId",
  payment: "paymentPolicyId",
} as const satisfies Record<ListingSettingsPolicyKind, keyof DropshipEbayListingSetupResponse["selection"]>);

const POLICY_NAME_FIELD_BY_KIND = Object.freeze({
  shipping: "fulfillmentPolicyName",
  return: "returnPolicyName",
  payment: "paymentPolicyName",
} as const satisfies Record<ListingSettingsPolicyKind, keyof NonNullable<DropshipEbayListingSetupResponse["storedNames"]>>);

const POLICY_OPTIONS_BY_KIND = Object.freeze({
  shipping: "fulfillmentPolicies",
  return: "returnPolicies",
  payment: "paymentPolicies",
} as const satisfies Record<ListingSettingsPolicyKind, keyof DropshipEbayListingSetupResponse["options"]>);

const SIGNATURE_VERSION = 1;

interface SignatureContent {
  v: typeof SIGNATURE_VERSION;
  writer: StoreSetupWriter;
  kind: StoreSetupRequestKind;
  storeConnectionId: number;
  keyPrefix: string;
  /** The body without its request key. */
  body: Record<string, unknown>;
}

const signatureSchema = z.object({
  v: z.literal(SIGNATURE_VERSION),
  writer: z.enum(["W2", "W10"]),
  kind: z.enum(["policy", "shelf", "ship_from"]),
  storeConnectionId: z.number().int().positive(),
  keyPrefix: z.enum([LISTING_SETTINGS_KEY_PREFIXES.policy, LISTING_SETTINGS_KEY_PREFIXES.shelf, LISTING_SETTINGS_KEY_PREFIXES.shipFrom]),
  body: z.record(z.unknown()),
}).strict();

function storeConnectionIdOf(setup: StoreSetupRevisionFacts): number {
  const id = setup.storeConnectionId;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new StoreSetupRequestError({
      code: "DROPSHIP_LISTING_SETTINGS_STORE_INVALID",
      message: "This store can't be saved from here. Reload the page.",
      context: { storeConnectionId: id },
    });
  }
  return id;
}

/** The revision to save against. Throws the reload words when the read carries none (the server refuses a save without it). */
function expectedRevisionOf(setup: StoreSetupRevisionFacts): number {
  const revision = listingSetupRevision(setup);
  if (revision === null) {
    throw new StoreSetupRequestError({
      code: "DROPSHIP_LISTING_SETTINGS_RELOAD_REQUIRED",
      message: LISTING_SETUP_RELOAD_MESSAGE,
      context: { storeConnectionId: setup.storeConnectionId, revision: setup.revision ?? null },
    });
  }
  return revision;
}

function plan(content: Omit<SignatureContent, "v">): StoreSetupSavePlan {
  // Fixed field order, so the same request always has the same signature.
  const signature = JSON.stringify({
    v: SIGNATURE_VERSION,
    writer: content.writer,
    kind: content.kind,
    storeConnectionId: content.storeConnectionId,
    keyPrefix: content.keyPrefix,
    body: content.body,
  } satisfies SignatureContent);
  return { writer: content.writer, kind: content.kind, storeConnectionId: content.storeConnectionId, keyPrefix: content.keyPrefix, signature };
}

/**
 * W2 for one store default policy. Only that policy is sent: today's builder
 * sends every chosen policy when nothing changed
 * (`buildEbayListingSetupSaveRequest`), which would make a return policy
 * save wait on the Card Shellz shipping check.
 */
export function planStoreDefaultPolicySave(
  setup: StoreSetupRevisionFacts,
  kind: ListingSettingsPolicyKind,
  policyId: string,
): StoreSetupSavePlan {
  const storeConnectionId = storeConnectionIdOf(setup);
  const expectedRevision = expectedRevisionOf(setup);
  const id = typeof policyId === "string" ? policyId.trim() : "";
  if (!policyIdSchema.safeParse(id).success) {
    throw new StoreSetupRequestError({
      code: "DROPSHIP_LISTING_SETTINGS_POLICY_INVALID",
      message: `Pick a ${POLICY_KIND_WORDS[kind]} policy.`,
      context: { kind, length: id.length },
    });
  }
  return plan({
    writer: "W2",
    kind: "policy",
    storeConnectionId,
    keyPrefix: LISTING_SETTINGS_KEY_PREFIXES.policy,
    body: { expectedRevision, [POLICY_FIELD_BY_KIND[kind]]: id },
  });
}

/** W2 for the store shelf default: `[first]`, `[first, second]`, or null for "None". */
export function planStoreShelfDefaultSave(
  setup: StoreSetupRevisionFacts,
  shelfIds: readonly string[] | null,
): StoreSetupSavePlan {
  const storeConnectionId = storeConnectionIdOf(setup);
  const expectedRevision = expectedRevisionOf(setup);
  let storeShelfDefault: { ids: string[] } | null = null;
  if (shelfIds !== null) {
    const ids = shelfIds.map((id) => (typeof id === "string" ? id.trim() : ""));
    const refuse = (message: string, reason: string): never => {
      throw new StoreSetupRequestError({ code: "DROPSHIP_LISTING_SETTINGS_SHELF_INVALID", message, context: { reason, count: ids.length } });
    };
    if (ids.length === 0 || ids.length > MAX_STORE_SHELVES) refuse("Pick one or two shelves, or None.", "count");
    if (ids.some((id) => !shelfIdSchema.safeParse(id).success)) refuse("Pick a shelf from your eBay store.", "id");
    if (new Set(ids).size !== ids.length) refuse(STORE_DEFAULT_EDITOR_WORDS.sameShelfTwice, "same_shelf_twice");
    storeShelfDefault = { ids };
  }
  return plan({
    writer: "W2",
    kind: "shelf",
    storeConnectionId,
    keyPrefix: LISTING_SETTINGS_KEY_PREFIXES.shelf,
    body: { expectedRevision, storeShelfDefault },
  });
}

/** W10: point the store's listings at the Card Shellz-managed eBay location again. */
export function planShipFromRepair(setup: StoreSetupRevisionFacts): StoreSetupSavePlan {
  const storeConnectionId = storeConnectionIdOf(setup);
  const expectedRevision = expectedRevisionOf(setup);
  return plan({
    writer: "W10",
    kind: "ship_from",
    storeConnectionId,
    keyPrefix: LISTING_SETTINGS_KEY_PREFIXES.shipFrom,
    body: { expectedRevision },
  });
}

/** The plan a signature was made from (for "Check again", which resends the same request). */
export function planFromSignature(signature: string): StoreSetupSavePlan {
  const content = parseSignature(signature);
  return { writer: content.writer, kind: content.kind, storeConnectionId: content.storeConnectionId, keyPrefix: content.keyPrefix, signature };
}

function parseSignature(signature: string): SignatureContent {
  let raw: unknown;
  try {
    raw = JSON.parse(signature);
  } catch (error) {
    throw new StoreSetupRequestError({
      code: "DROPSHIP_LISTING_SETTINGS_SIGNATURE_INVALID",
      message: "This save can't be sent again. Reload the page.",
      context: { reason: error instanceof Error ? error.name : "parse" },
    });
  }
  const parsed = signatureSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StoreSetupRequestError({
      code: "DROPSHIP_LISTING_SETTINGS_SIGNATURE_INVALID",
      message: "This save can't be sent again. Reload the page.",
      context: { issues: parsed.error.issues.slice(0, 3).map((issue) => issue.path.join(".")) },
    });
  }
  const content = parsed.data;
  const writerFits = (content.writer === "W10") === (content.kind === "ship_from");
  const prefixFits = content.keyPrefix === KEY_PREFIX_BY_KIND[content.kind];
  if (!writerFits || !prefixFits) {
    throw new StoreSetupRequestError({
      code: "DROPSHIP_LISTING_SETTINGS_SIGNATURE_INVALID",
      message: "This save can't be sent again. Reload the page.",
      context: { writer: content.writer, kind: content.kind },
    });
  }
  return content;
}

const KEY_PREFIX_BY_KIND: Readonly<Record<StoreSetupRequestKind, string>> = {
  policy: LISTING_SETTINGS_KEY_PREFIXES.policy,
  shelf: LISTING_SETTINGS_KEY_PREFIXES.shelf,
  ship_from: LISTING_SETTINGS_KEY_PREFIXES.shipFrom,
};

/**
 * The request for a signature and its key, checked against the server's
 * schema before it is sent: a request the server would refuse is never sent.
 */
export function storeSetupRequest(signature: string, idempotencyKey: string): StoreSetupRequest {
  const content = parseSignature(signature);
  if (!requestKeySchema.safeParse(idempotencyKey).success || !idempotencyKey.startsWith(`${content.keyPrefix}:`)) {
    throw new StoreSetupRequestError({
      code: "DROPSHIP_LISTING_SETTINGS_REQUEST_KEY_INVALID",
      message: "This save can't be sent. Reload the page.",
      context: { keyPrefix: content.keyPrefix, length: typeof idempotencyKey === "string" ? idempotencyKey.length : null },
    });
  }
  const candidate = { ...content.body, idempotencyKey };
  const schema = content.kind === "policy" ? policySaveBodySchema : content.kind === "shelf" ? shelfSaveBodySchema : shipFromRepairBodySchema;
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    const code: StoreSetupRequestErrorCode = content.kind === "shelf" ? "DROPSHIP_LISTING_SETTINGS_SHELF_INVALID"
      : content.kind === "policy" ? "DROPSHIP_LISTING_SETTINGS_POLICY_INVALID" : "DROPSHIP_LISTING_SETTINGS_SIGNATURE_INVALID";
    throw new StoreSetupRequestError({
      code,
      message: parsed.error.issues[0]?.message ?? "This save can't be sent.",
      context: { kind: content.kind, issues: parsed.error.issues.slice(0, 3).map((issue) => issue.path.join(".")) },
    });
  }
  const base = `/api/dropship/ebay/listing-setup/${content.storeConnectionId}`;
  return content.writer === "W10"
    ? { writer: "W10", method: "POST", path: `${base}/ship-from/repair`, body: parsed.data }
    : { writer: "W2", method: "PUT", path: base, body: parsed.data };
}

/** Sends a planned request (PUT for W2, POST for W10). The answer is checked by `runStoreSetupSave`. */
export function sendStoreSetupRequest(request: StoreSetupRequest): Promise<unknown> {
  return request.method === "PUT" ? putJson<unknown>(request.path, request.body) : postJson<unknown>(request.path, request.body);
}

/**
 * The W2 body for one store default policy: `{ expectedRevision,
 * idempotencyKey, <exactly one of fulfillmentPolicyId | returnPolicyId |
 * paymentPolicyId> }`. Throws the reload words without a revision.
 */
export function buildStoreDefaultPolicySave(
  setup: StoreSetupRevisionFacts,
  kind: ListingSettingsPolicyKind,
  policyId: string,
  idempotencyKey: string,
): DropshipEbayListingSetupSaveRequest {
  return storeSetupRequest(planStoreDefaultPolicySave(setup, kind, policyId).signature, idempotencyKey).body as DropshipEbayListingSetupSaveRequest;
}

/** The W2 body for the store shelf default: `{ expectedRevision, idempotencyKey, storeShelfDefault: { ids } | null }`. */
export function buildStoreShelfDefaultSave(
  setup: StoreSetupRevisionFacts,
  shelfIds: readonly string[] | null,
  idempotencyKey: string,
): DropshipEbayListingSetupSaveRequest {
  return storeSetupRequest(planStoreShelfDefaultSave(setup, shelfIds).signature, idempotencyKey).body as DropshipEbayListingSetupSaveRequest;
}

/** The W10 body: `{ expectedRevision, idempotencyKey }`. */
export function buildStoreShipFromRepair(setup: StoreSetupRevisionFacts, idempotencyKey: string): DropshipEbayShipFromRepairRequest {
  return storeSetupRequest(planShipFromRepair(setup).signature, idempotencyKey).body as DropshipEbayShipFromRepairRequest;
}

// ---------------------------------------------------------------------------
// The answer (checked before it is cached)
// ---------------------------------------------------------------------------

const nullableText = z.string().nullable();
const setupOptionSchema = z.object({ id: z.string(), name: z.string() }).passthrough();
const fulfillmentOptionSchema = setupOptionSchema.extend({
  compatible: z.boolean(),
  compatibilityChecked: z.boolean().optional(),
  compatibilityIssues: z.array(z.object({ code: z.string(), message: z.string() }).passthrough()),
});
const fulfillmentCapabilitySchema = z.object({
  marketplaceId: z.string(),
  requiredHandlingTimeBusinessDays: z.number().int(),
  destinationCountry: z.literal("US"),
  destinationRegions: z.array(z.string()),
  destinationCoverageComplete: z.boolean(),
  supportedServices: z.array(z.object({
    carrier: z.string(),
    ebayServiceCode: z.string(),
    serviceName: z.string(),
    shipStationCarrierCode: z.string(),
    shipStationServiceCode: z.string(),
  }).passthrough()),
  evidenceHash: z.string(),
  source: z.object({
    omsChannelId: z.number(),
    originWarehouseId: z.number(),
    rateBookId: z.number(),
    rateBookCode: z.string(),
    rateTableId: z.number(),
    serviceLevelId: z.number(),
    fulfillmentRoutingRevision: z.number(),
  }).passthrough(),
}).passthrough();

/** The setup answer a W2 or W10 save returns (`DropshipEbayListingSetupWriteResult`). */
const setupAnswerSchema = z.object({
  storeConnectionId: z.number().int().positive(),
  marketplaceId: z.string(),
  complete: z.boolean(),
  missingFields: z.array(z.string()),
  fulfillmentCapability: fulfillmentCapabilitySchema.nullable(),
  selection: z.object({
    merchantLocationKey: nullableText,
    fulfillmentPolicyId: nullableText,
    returnPolicyId: nullableText,
    paymentPolicyId: nullableText,
  }).passthrough(),
  options: z.object({
    merchantLocations: z.array(setupOptionSchema),
    fulfillmentPolicies: z.array(fulfillmentOptionSchema),
    returnPolicies: z.array(setupOptionSchema),
    paymentPolicies: z.array(setupOptionSchema),
  }).passthrough(),
  revision: z.number().int().positive().nullable().optional(),
  access: z.union([
    z.object({ canEdit: z.literal(true), reason: z.null() }).passthrough(),
    z.object({
      canEdit: z.literal(false),
      reason: z.enum(["vendor_not_active", "store_paused", "store_disconnecting", "store_disconnected"]),
    }).passthrough(),
  ]).optional(),
  checks: z.object({
    ebay: z.enum(["checked", "not_checked"]),
    fulfillment: z.discriminatedUnion("status", [
      z.object({ status: z.literal("checked") }).passthrough(),
      z.object({
        status: z.literal("unavailable"),
        reference: z.string(),
        kind: z.enum(["temporary", "setup_incomplete", "marketplace_unsupported"]),
      }).passthrough(),
      z.object({ status: z.literal("not_checked") }).passthrough(),
    ]),
  }).passthrough().optional(),
  storedNames: z.object({
    fulfillmentPolicyName: nullableText,
    returnPolicyName: nullableText,
    paymentPolicyName: nullableText,
  }).passthrough().optional(),
  storeShelfDefault: z.object({ ids: z.array(z.string()), names: z.array(z.string()) }).passthrough().nullable().optional(),
  outcome: z.enum(["changed", "unchanged", "replayed"]).optional(),
}).passthrough();

/**
 * A save's answer for this store, or null when it doesn't match the setup
 * contract (or names another store). A null answer is never cached: the
 * setup is read again instead.
 */
export function parseStoreSetupAnswer(answer: unknown, storeConnectionId: number): DropshipEbayListingSetupResponse | null {
  const parsed = setupAnswerSchema.safeParse(answer);
  if (!parsed.success || parsed.data.storeConnectionId !== storeConnectionId) return null;
  const setup: DropshipEbayListingSetupResponse = parsed.data;
  return setup;
}

// ---------------------------------------------------------------------------
// Running a save
// ---------------------------------------------------------------------------

/** The page's pending-save counter (plan D10): it holds back queueing while a save runs. */
export interface StoreSetupSaveCallbacks {
  disabled?: boolean;
  /** Throws when a listing action is running; nothing is sent then. */
  onSaveStarted: () => void;
  onSaveSettled: () => void;
}

/** How a save ended, as the drafts provider takes it (`ListingSettingsSaveSettlement`). */
export type StoreSetupSettlement =
  | { kind: "saved" }
  | { kind: "saved_view_stale" }
  | { kind: "failure"; failure: WriteFailure };

export interface RunStoreSetupSaveInput {
  plan: StoreSetupSavePlan;
  callbacks: StoreSetupSaveCallbacks;
  /** The drafts provider's `startSave`: the request key, or null when no save can start. */
  startSave: (signature: string, keyPrefix: string) => string | null;
  /** The drafts provider's `settle`. */
  settle: (key: string, settlement: StoreSetupSettlement) => void;
  /** Sends the request; rejects with a `DropshipApiError` for a refusal, anything else for a dropped connection. */
  send: (request: StoreSetupRequest) => Promise<unknown>;
  /** Publishes a confirmed answer to the shared setup read (`synchronizeSavedEbayListingSetup`). */
  synchronize: (saved: DropshipEbayListingSetupResponse) => Promise<void>;
  /** Reads the setup again when the answer can't be used (`refreshEbayListingConfiguration`). */
  refresh: () => Promise<void>;
  /** After a confirmed save: mark the preview stale and read the listing settings again. */
  onSaved: () => void;
  /** A save the server blocked: the banner it names, or null when the reads decide (`bannerFromWriteError`). */
  onBlocked?: (banner: ConnectionBanner | null) => void;
}

export type StoreSetupSaveResult =
  | { status: "not_started"; reason: "callbacks_refused"; error: unknown }
  | { status: "not_started"; reason: "draft_busy" }
  | {
    status: "settled";
    key: string;
    settlement: StoreSetupSettlement;
    /** The checked answer of a confirmed save (null when it failed or didn't match the contract). */
    saved: DropshipEbayListingSetupResponse | null;
    /** Why the view could not be refreshed after a confirmed save. */
    viewError: unknown;
  };

/**
 * Sends one W2 or W10 save and settles the step's draft with its outcome.
 *
 * - The page's counter starts first; when it refuses (a listing action is
 *   running), no key is taken and nothing is sent.
 * - Any 2xx is a confirmed save, whatever its `outcome` (changed, unchanged,
 *   or replayed from the first request with this key). The answer goes to
 *   the shared read; a re-read that fails leaves "Saved. We couldn't load the
 *   latest view." Then `onSaved`.
 * - A failure is classified (`classifyWriteFailure`); a blocked one also
 *   names its banner.
 * - The counter always settles.
 */
export async function runStoreSetupSave(input: RunStoreSetupSaveInput): Promise<StoreSetupSaveResult> {
  const { plan: savePlan, callbacks } = input;
  try {
    callbacks.onSaveStarted();
  } catch (error) {
    return { status: "not_started", reason: "callbacks_refused", error };
  }
  try {
    const key = input.startSave(savePlan.signature, savePlan.keyPrefix);
    if (key === null) return { status: "not_started", reason: "draft_busy" };

    let request: StoreSetupRequest;
    try {
      request = storeSetupRequest(savePlan.signature, key);
    } catch (error) {
      // Nothing was sent, so the next request gets a new key.
      const failure: WriteFailure = {
        phase: "refused",
        message: error instanceof Error ? error.message : LISTING_SETTINGS_SAVE_WORDS.uncertain,
        code: error instanceof StoreSetupRequestError ? error.code : null,
        status: null,
      };
      input.settle(key, { kind: "failure", failure });
      return { status: "settled", key, settlement: { kind: "failure", failure }, saved: null, viewError: null };
    }

    let answer: unknown;
    try {
      answer = await input.send(request);
    } catch (error) {
      const failure = classifyWriteFailure(savePlan.writer, error);
      const settlement: StoreSetupSettlement = { kind: "failure", failure };
      input.settle(key, settlement);
      if (failure.phase === "blocked") input.onBlocked?.(bannerFromWriteError(error));
      return { status: "settled", key, settlement, saved: null, viewError: null };
    }

    const saved = parseStoreSetupAnswer(answer, savePlan.storeConnectionId);
    let viewError: unknown = null;
    try {
      // An answer off the contract is not cached; the setup is read again instead.
      if (saved) await input.synchronize(saved);
      else await input.refresh();
    } catch (error) {
      viewError = error;
    }
    const settlement: StoreSetupSettlement = viewError === null ? { kind: "saved" } : { kind: "saved_view_stale" };
    input.settle(key, settlement);
    input.onSaved();
    return { status: "settled", key, settlement, saved, viewError };
  } finally {
    callbacks.onSaveSettled();
  }
}

// ---------------------------------------------------------------------------
// Policy editor rules
// ---------------------------------------------------------------------------

/** Whether this editor holds a store default policy (C19: the ship-from repair waits for it). */
export function isStoreDefaultPolicyEditor(editor: EditorId | null | undefined): boolean {
  return editor === "shipping" || editor === "return" || editor === "payment";
}

export type PolicySetupFacts = Pick<DropshipEbayListingSetupResponse, "selection" | "options" | "checks" | "storedNames" | "fulfillmentCapability">;

/** Whether this answer carries eBay's live lists (a server from before the checks always read eBay). */
export function setupReadEbay(setup: Pick<DropshipEbayListingSetupResponse, "checks">): boolean {
  return setup.checks === undefined || setup.checks.ebay === "checked";
}

function nonBlank(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

/** The store default saved for this kind, or null. */
export function savedStorePolicyId(setup: Pick<DropshipEbayListingSetupResponse, "selection">, kind: ListingSettingsPolicyKind): string | null {
  return nonBlank(setup.selection[POLICY_FIELD_BY_KIND[kind]]);
}

/**
 * The draft a policy editor opens with: the saved store default as
 * `{ policyId }`. The row and the step (the attention strip's [Choose],
 * R:508) open the editor through the drafts provider with this, so both
 * start from the same base.
 */
export function policyEditorBase(
  setup: Pick<DropshipEbayListingSetupResponse, "selection">,
  kind: ListingSettingsPolicyKind,
): { policyId: string | null } {
  return { policyId: savedStorePolicyId(setup, kind) };
}

export interface PolicyEditorChoice {
  id: string;
  name: string;
  /** Whether it can be picked and saved. A shipping policy must work with Card Shellz shipping. */
  choosable: boolean;
  /** Shipping only: whether it works with Card Shellz shipping, in words. */
  fit: ShippingPolicyFit | null;
}

/** The editor's choices, in eBay's order (R:192-193). Return and payment have no Card Shellz check. */
export function policyEditorChoices(setup: PolicySetupFacts, kind: ListingSettingsPolicyKind): PolicyEditorChoice[] {
  if (kind === "shipping") {
    return setup.options.fulfillmentPolicies.map((option) => {
      const fit = shippingPolicyFit(option, setup.fulfillmentCapability);
      return { id: option.id, name: option.name, choosable: option.compatible === true && option.compatibilityChecked !== false, fit };
    });
  }
  return setup.options[POLICY_OPTIONS_BY_KIND[kind]].map((option) => ({ id: option.id, name: option.name, choosable: true, fit: null }));
}

/**
 * The policy Card Shellz picks for the vendor when eBay offers exactly one
 * that can be used and none is saved (or the saved one can't be used any
 * more): "Suggested · not saved" (R:509). Only inside the open editor (C18).
 */
export function suggestedStorePolicyId(setup: PolicySetupFacts, kind: ListingSettingsPolicyKind): string | null {
  if (!setupReadEbay(setup)) return null;
  const choosable = policyEditorChoices(setup, kind).filter((choice) => choice.choosable);
  const saved = savedStorePolicyId(setup, kind);
  if (saved !== null && choosable.some((choice) => choice.id === saved)) return null;
  return choosable.length === 1 ? choosable[0].id : null;
}

export type SavedPolicyProblem =
  /** The saved shipping policy is on eBay but no longer works with Card Shellz shipping (R:512). */
  | { problem: "no_longer_fits"; name: string; reason: string }
  /** The saved policy is no longer on eBay (interim words). */
  | { problem: "gone"; name: string | null };

/** What is wrong with the saved policy, when eBay was read; null when nothing is (or it can't be told). */
export function savedPolicyProblem(setup: PolicySetupFacts, kind: ListingSettingsPolicyKind): SavedPolicyProblem | null {
  if (!setupReadEbay(setup)) return null;
  const saved = savedStorePolicyId(setup, kind);
  if (saved === null) return null;
  const options: ReadonlyArray<{ id: string; name: string }> = setup.options[POLICY_OPTIONS_BY_KIND[kind]];
  const live = options.find((option) => option.id === saved);
  if (!live) return { problem: "gone", name: nonBlank(setup.storedNames?.[POLICY_NAME_FIELD_BY_KIND[kind]]) };
  if (kind !== "shipping") return null;
  const option = setup.options.fulfillmentPolicies.find((policy) => policy.id === saved);
  if (!option) return null;
  const fit = shippingPolicyFit(option, setup.fulfillmentCapability);
  return fit.fit === "cant_use" ? { problem: "no_longer_fits", name: nonBlank(live.name) ?? nonBlank(setup.storedNames?.fulfillmentPolicyName) ?? "", reason: fit.reason } : null;
}

/** The red row's words (R:512; "gone" is interim). */
export function savedPolicyProblemWords(kind: ListingSettingsPolicyKind, problem: SavedPolicyProblem): string {
  const kindWords = POLICY_KIND_WORDS[kind];
  if (problem.problem === "no_longer_fits") {
    const named = problem.name ? ` “${problem.name}”` : "";
    return `Your shipping policy${named} changed on eBay and no longer works with Card Shellz shipping: ${problem.reason}.`;
  }
  return problem.name ? `Your ${kindWords} policy “${problem.name}” is no longer on eBay.` : `Your ${kindWords} policy is no longer on eBay.`;
}

/** The saved shipping policy works with Card Shellz shipping (R:124): the closed row says so. */
export function savedShippingPolicyWorks(setup: PolicySetupFacts): boolean {
  if (!setupReadEbay(setup)) return false;
  const saved = savedStorePolicyId(setup, "shipping");
  const option = saved === null ? undefined : setup.options.fulfillmentPolicies.find((policy) => policy.id === saved);
  return option !== undefined && shippingPolicyFit(option, setup.fulfillmentCapability).fit === "works";
}

// ---------------------------------------------------------------------------
// Shelf editor rules
// ---------------------------------------------------------------------------

/** The shelf editor's draft: two independent pickers. */
export interface ShelfDraftValue {
  first: string | null;
  second: string | null;
  [field: string]: unknown;
}

/** The saved store shelf default as the editor starts from it. */
export function shelfDraftFromSetup(setup: Pick<DropshipEbayListingSetupResponse, "storeShelfDefault">): ShelfDraftValue {
  const ids = setup.storeShelfDefault?.ids ?? [];
  return { first: nonBlank(ids[0]), second: nonBlank(ids[1]) };
}

/** Why the shelf draft can't be saved yet, or null. */
export function shelfDraftProblem(value: Pick<ShelfDraftValue, "first" | "second">): string | null {
  if (value.first === null && value.second !== null) return STORE_DEFAULT_EDITOR_WORDS.pickFirstShelfFirst;
  if (value.first !== null && value.first === value.second) return STORE_DEFAULT_EDITOR_WORDS.sameShelfTwice;
  return null;
}

/** The ids the shelf draft saves: null for "None", else the first and (if any) the second. Throws while it has a problem. */
export function shelfIdsFromDraft(value: Pick<ShelfDraftValue, "first" | "second">): string[] | null {
  const problem = shelfDraftProblem(value);
  if (problem !== null) {
    throw new StoreSetupRequestError({ code: "DROPSHIP_LISTING_SETTINGS_SHELF_INVALID", message: problem, context: { reason: "draft" } });
  }
  if (value.first === null) return null;
  return value.second === null ? [value.first] : [value.first, value.second];
}

/** eBay store shelf paths come joined with ":" (the store category directory); the record shows "Supplies › Toploaders" (R:581). */
export function shelfPathWords(path: string): string {
  const parts = path.split(":").map((part) => part.trim()).filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(" › ") : path.trim();
}

/**
 * The shelves the pickers offer, in the record's words, plus each saved shelf
 * the live list doesn't have, so the picker still shows what is saved. When
 * the live list was read, such a shelf is marked as gone (a save that keeps
 * it is refused with "That shelf is gone from your eBay store."); while it
 * can't be read (`live` null), nothing is said about it.
 */
export function shelfPickerOptions(
  live: readonly DropshipEbayStoreCategoryOption[] | null,
  saved: Pick<DropshipEbayListingSetupResponse, "storeShelfDefault">["storeShelfDefault"],
): DropshipEbayStoreCategoryOption[] {
  const options = (live ?? []).map((shelf) => ({ ...shelf, path: shelfPathWords(shelf.path) }));
  const ids = saved?.ids ?? [];
  ids.forEach((id, index) => {
    if (options.some((option) => option.categoryId === id)) return;
    // Interim: a saved shelf with no stored name.
    const name = shelfPathWords(nonBlank(saved?.names[index]) ?? "A shelf");
    options.push({ categoryId: id, categoryName: name, path: live === null ? name : `${name} (no longer in your eBay store)`, level: 0 });
  });
  return options;
}

// ---------------------------------------------------------------------------
// Ship-from
// ---------------------------------------------------------------------------

/** eBay's listing location field the ship-from repair sets. */
const SHIP_FROM_FIELD = "merchantLocationKey";

/** Whether the store's listings must be pointed at the Card Shellz-managed eBay location again (R:513). */
export function shipFromRepairNeeded(setup: Pick<DropshipEbayListingSetupResponse, "missingFields">): boolean {
  return setup.missingFields.includes(SHIP_FROM_FIELD);
}

/**
 * What "Update now" may do, from the setup read again at the click (W10).
 * A new repair is never planned from the cached read: after a 409 it still
 * holds the revision the server refused, so every click would be refused
 * again; after a repair whose answer was lost it still says the location is
 * missing, so the repair would go again with a stale revision and the vendor
 * would be told "This changed in another window." about their own save.
 * - `repair`: the location is still missing; plan from this read.
 * - `not_needed`: it is right now (an earlier repair landed, or another window made it).
 * - `read_failed`: the read failed; nothing may be sent.
 */
export type ShipFromRepairStart =
  | { kind: "repair"; setup: DropshipEbayListingSetupResponse }
  | { kind: "not_needed" }
  | { kind: "read_failed"; error: unknown };

/**
 * Reads the setup again and decides `ShipFromRepairStart`. Never rejects.
 * `read` must reject when the read does not finish (React Query: `refetch({ throwOnError: true })`);
 * a refetch cancelled in flight otherwise resolves with the cached answer and no error.
 */
export async function readShipFromRepairStart(
  read: () => Promise<{ data?: DropshipEbayListingSetupResponse; error?: unknown }>,
): Promise<ShipFromRepairStart> {
  let answer: { data?: DropshipEbayListingSetupResponse; error?: unknown };
  try {
    answer = await read();
  } catch (error) {
    return { kind: "read_failed", error };
  }
  // React Query keeps the older answer beside a failed read's error; that answer is not this read's.
  if (answer.error !== undefined && answer.error !== null) return { kind: "read_failed", error: answer.error };
  if (answer.data === undefined) return { kind: "read_failed", error: null };
  return shipFromRepairNeeded(answer.data) ? { kind: "repair", setup: answer.data } : { kind: "not_needed" };
}
