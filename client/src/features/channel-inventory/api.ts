import { z } from "zod";

import { plannerShadowRunSchema } from "@shared/types/inventory-availability-planner";
import {
  channelExposureDraftSaveResultSchema,
  createInventoryPublicationTargetRequestSchema,
  inventoryChannelExposureAdminViewSchema,
  inventoryChannelExposurePreviewSchema,
  inventoryPublicationTargetCommandResultSchema,
  saveChannelExposurePolicyDraftRequestSchema,
  savePublicationSourceBindingDraftRequestSchema,
  savePublicationVariantMappingDraftRequestSchema,
  setInventoryPublicationTargetPreviewStateRequestSchema,
  stopInventoryPublicationTargetRequestSchema,
  type ChannelExposureDraftSaveResult,
  type ChannelExposurePolicyHead,
  type ChannelExposurePolicyScope,
  type ChannelExposurePolicyValue,
  type InventoryChannelExposureAdminView,
  type InventoryChannelExposurePreview,
  type InventoryPublicationTargetCommandResult,
  type PublicationSourceBindingHead,
  type PublicationVariantMappingHead,
} from "@shared/types/inventory-channel-exposure";
import {
  inventoryPublicationGlobalControlResultSchema,
  type InventoryPublicationGlobalControlRequest,
  type InventoryPublicationGlobalControlResult,
} from "@shared/types/inventory-publication-global-control";
import {
  inventoryPublicationTargetResumeResultSchema,
  inventoryPublicationTargetResumeReviewSchema,
  resumeInventoryPublicationTargetRequestSchema,
  reviewInventoryPublicationTargetResumeRequestSchema,
  type InventoryPublicationTargetResumeResult,
  type InventoryPublicationTargetResumeReview,
} from "@shared/types/inventory-publication-target-resume";

/**
 * HTTP boundary for the Channel Inventory workspace. Every response is parsed
 * against the shared contract before it reaches a component, and every command
 * body is parsed against the shared request schema before it leaves.
 */

const ADMIN_BASE = "/api/inventory-planning/admin/channel-exposure";

export const ENDPOINTS = {
  view: ADMIN_BASE,
  preview: `${ADMIN_BASE}/preview`,
  policyDraft: `${ADMIN_BASE}/policy-draft`,
  sourceBindingDraft: `${ADMIN_BASE}/source-binding-draft`,
  variantMappingDraft: `${ADMIN_BASE}/variant-mapping-draft`,
  target: `${ADMIN_BASE}/publication-target`,
  targetPreviewState: `${ADMIN_BASE}/publication-target-preview-state`,
  targetStop: `${ADMIN_BASE}/publication-target-stop`,
  targetResumeReview: `${ADMIN_BASE}/publication-target-resume-review`,
  targetResume: `${ADMIN_BASE}/publication-target-resume`,
  globalControl: "/api/inventory-planning/admin/publication-global-control",
  syncStatus: "/api/sync/status",
  shopifyLocations: (channelId: number) => `/api/channels/${channelId}/shopify-locations`,
  shadowRuns: (productId: number) =>
    `/api/inventory-planning/admin/supply-transformations/${productId}/shadow-runs`,
} as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ChannelInventoryApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = "ChannelInventoryApiError";
  }
}

export type ApiErrorKind = "conflict" | "validation" | "forbidden" | "not_found" | "unavailable" | "unknown";

export interface DescribedError {
  kind: ApiErrorKind;
  title: string;
  message: string;
  details: readonly string[];
}

/** Turns any thrown value into a stable operator-facing description. */
export function describeError(error: unknown): DescribedError {
  if (error instanceof ChannelInventoryApiError) {
    const kind: ApiErrorKind = error.status === 409 ? "conflict"
      : error.status === 400 ? "validation"
        : error.status === 401 || error.status === 403 ? "forbidden"
          : error.status === 404 ? "not_found"
            : error.status >= 500 ? "unavailable"
              : "unknown";
    const title = kind === "conflict" ? "Not saved: something changed first"
      : kind === "validation" ? "Not saved: check the highlighted fields"
        : kind === "forbidden" ? "Not allowed"
          : kind === "not_found" ? "Not found"
            : kind === "unavailable" ? "The server could not complete this"
              : "Something went wrong";
    return { kind, title, message: error.message, details: error.details };
  }
  if (error instanceof z.ZodError) {
    return {
      kind: "unknown",
      title: "Unexpected server response",
      message: "The response did not match the expected contract. Reload and try again.",
      details: error.issues.map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`),
    };
  }
  return {
    kind: "unknown",
    title: "Something went wrong",
    message: error instanceof Error ? error.message : String(error),
    details: [],
  };
}

export function isConflict(error: unknown): boolean {
  return describeError(error).kind === "conflict";
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const errorBodySchema = z.object({
  error: z.object({
    code: z.string().optional(),
    message: z.string().optional(),
    details: z.array(z.string()).optional(),
  }).partial().optional(),
}).partial();

// Generic over the schema (not its output) so contracts whose input and output
// types differ, such as schemas with defaults, still parse to their output type.
export async function requestJson<TSchema extends z.ZodTypeAny>(
  url: string,
  schema: TSchema,
  init?: RequestInit,
): Promise<z.output<TSchema>> {
  const response = await fetch(url, { credentials: "include", ...init });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = errorBodySchema.safeParse(body);
    const error = parsed.success ? parsed.data.error : undefined;
    throw new ChannelInventoryApiError(
      response.status,
      error?.code ?? `HTTP_${response.status}`,
      error?.message ?? response.statusText ?? "Request failed.",
      error?.details ?? [],
    );
  }
  return schema.parse(body);
}

export function jsonInit(method: "POST" | "PUT", body: unknown): RequestInit {
  return {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function fetchView(productId: number | null): Promise<InventoryChannelExposureAdminView> {
  const query = productId === null ? "" : `?productId=${productId}`;
  return requestJson(`${ENDPOINTS.view}${query}`, inventoryChannelExposureAdminViewSchema);
}

export function fetchPreview(publicationTargetId: number, productId: number): Promise<InventoryChannelExposurePreview> {
  return requestJson(
    `${ENDPOINTS.preview}?publicationTargetId=${publicationTargetId}&productId=${productId}`,
    inventoryChannelExposurePreviewSchema,
  );
}

/** The global publishing switch is one row shared by every channel. */
export const publishingStatusSchema = z.object({
  global: z.object({
    globalEnabled: z.boolean(),
    sweepIntervalMinutes: z.number().int().min(1).max(1_440),
    // The legacy status route serializes the bigint revision as a string, but
    // accept a number too rather than fail the whole header on a formatting change.
    revision: z.union([z.string(), z.number()]).transform(String),
    changedBy: z.string().nullable().transform((value) => value ?? "unknown"),
    changeReason: z.string().nullable().transform((value) => value ?? ""),
    lastSweepAt: z.string().nullable(),
  }).passthrough(),
  summary: z.object({
    pushed: z.number(),
    dryRun: z.number(),
    errors: z.number(),
    skipped: z.number(),
  }).passthrough().optional(),
}).passthrough();

export type PublishingStatus = z.infer<typeof publishingStatusSchema>;

export function fetchPublishingStatus(): Promise<PublishingStatus> {
  return requestJson(ENDPOINTS.syncStatus, publishingStatusSchema);
}

export const shopifyLocationsSchema = z.object({
  locations: z.array(z.object({
    id: z.string(),
    name: z.string(),
    city: z.string().nullable().optional(),
    province: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    active: z.boolean().optional(),
  }).passthrough()),
}).passthrough();

export type ShopifyLocation = z.infer<typeof shopifyLocationsSchema>["locations"][number];

export function fetchShopifyLocations(channelId: number): Promise<ShopifyLocation[]> {
  return requestJson(ENDPOINTS.shopifyLocations(channelId), shopifyLocationsSchema).then((body) => body.locations);
}

// ---------------------------------------------------------------------------
// Request builders (pure; unit-tested)
// ---------------------------------------------------------------------------

export interface DraftCommandContext {
  note: string;
  idempotencyKey: string;
}

/** Empty or whitespace notes are sent as null: the contract never receives a fabricated reason. */
export function normalizeNote(note: string): string | null {
  const trimmed = note.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function buildPolicyDraftRequest(input: {
  scope: ChannelExposurePolicyScope;
  value: ChannelExposurePolicyValue;
  head: ChannelExposurePolicyHead | null;
} & DraftCommandContext) {
  return saveChannelExposurePolicyDraftRequestSchema.parse({
    scope: input.scope,
    value: input.value,
    expectedHeadRevision: input.head?.revision ?? "0",
    expectedDraftPolicyId: input.head?.draftPolicy?.policyId ?? null,
    expectedDraftDefinitionHash: input.head?.draftPolicy?.definitionHash ?? null,
    changeReason: normalizeNote(input.note),
    idempotencyKey: input.idempotencyKey,
  });
}

export function buildSupplyDraftRequest(input: {
  publicationTargetId: number;
  fulfillmentNodeIds: readonly number[];
  head: PublicationSourceBindingHead | null;
} & DraftCommandContext) {
  return savePublicationSourceBindingDraftRequestSchema.parse({
    publicationTargetId: input.publicationTargetId,
    fulfillmentNodeIds: [...input.fulfillmentNodeIds].sort((left, right) => left - right),
    expectedHeadRevision: input.head?.revision ?? "0",
    expectedDraftBindingId: input.head?.draftBinding?.bindingId ?? null,
    expectedDraftDefinitionHash: input.head?.draftBinding?.definitionHash ?? null,
    changeReason: normalizeNote(input.note),
    idempotencyKey: input.idempotencyKey,
  });
}

export function buildIdentityDraftRequest(input: {
  publicationTargetId: number;
  productVariantId: number;
  externalInventoryItemId: string;
  externalSku: string;
  head: PublicationVariantMappingHead | null;
} & DraftCommandContext) {
  return savePublicationVariantMappingDraftRequestSchema.parse({
    publicationTargetId: input.publicationTargetId,
    productVariantId: input.productVariantId,
    externalInventoryItemId: input.externalInventoryItemId.trim(),
    externalSku: input.externalSku.trim().length === 0 ? null : input.externalSku.trim(),
    expectedHeadRevision: input.head?.revision ?? "0",
    expectedDraftMappingId: input.head?.draftMapping?.mappingId ?? null,
    expectedDraftDefinitionHash: input.head?.draftMapping?.definitionHash ?? null,
    changeReason: normalizeNote(input.note),
    idempotencyKey: input.idempotencyKey,
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function savePolicyDraft(
  request: ReturnType<typeof buildPolicyDraftRequest>,
): Promise<ChannelExposureDraftSaveResult> {
  return requestJson(ENDPOINTS.policyDraft, channelExposureDraftSaveResultSchema, jsonInit("PUT", request));
}

export function saveSupplyDraft(
  request: ReturnType<typeof buildSupplyDraftRequest>,
): Promise<ChannelExposureDraftSaveResult> {
  return requestJson(ENDPOINTS.sourceBindingDraft, channelExposureDraftSaveResultSchema, jsonInit("PUT", request));
}

export function saveIdentityDraft(
  request: ReturnType<typeof buildIdentityDraftRequest>,
): Promise<ChannelExposureDraftSaveResult> {
  return requestJson(ENDPOINTS.variantMappingDraft, channelExposureDraftSaveResultSchema, jsonInit("PUT", request));
}

export function registerDestination(
  request: z.input<typeof createInventoryPublicationTargetRequestSchema>,
): Promise<InventoryPublicationTargetCommandResult> {
  const parsed = createInventoryPublicationTargetRequestSchema.parse(request);
  return requestJson(ENDPOINTS.target, inventoryPublicationTargetCommandResultSchema, jsonInit("POST", parsed));
}

export function setReadinessInclusion(
  request: z.input<typeof setInventoryPublicationTargetPreviewStateRequestSchema>,
): Promise<InventoryPublicationTargetCommandResult> {
  const parsed = setInventoryPublicationTargetPreviewStateRequestSchema.parse(request);
  return requestJson(ENDPOINTS.targetPreviewState, inventoryPublicationTargetCommandResultSchema, jsonInit("PUT", parsed));
}

export function stopDestination(
  request: z.input<typeof stopInventoryPublicationTargetRequestSchema>,
): Promise<InventoryPublicationTargetCommandResult> {
  const parsed = stopInventoryPublicationTargetRequestSchema.parse(request);
  return requestJson(ENDPOINTS.targetStop, inventoryPublicationTargetCommandResultSchema, jsonInit("PUT", parsed));
}

export function reviewResume(
  request: z.input<typeof reviewInventoryPublicationTargetResumeRequestSchema>,
): Promise<InventoryPublicationTargetResumeReview> {
  const parsed = reviewInventoryPublicationTargetResumeRequestSchema.parse(request);
  return requestJson(ENDPOINTS.targetResumeReview, inventoryPublicationTargetResumeReviewSchema, jsonInit("POST", parsed));
}

export function resumeDestination(
  request: z.input<typeof resumeInventoryPublicationTargetRequestSchema>,
): Promise<InventoryPublicationTargetResumeResult> {
  const parsed = resumeInventoryPublicationTargetRequestSchema.parse(request);
  return requestJson(ENDPOINTS.targetResume, inventoryPublicationTargetResumeResultSchema, jsonInit("POST", parsed));
}

export function changeGlobalPublishing(
  request: InventoryPublicationGlobalControlRequest,
): Promise<InventoryPublicationGlobalControlResult> {
  return requestJson(ENDPOINTS.globalControl, inventoryPublicationGlobalControlResultSchema, jsonInit("PUT", request));
}

/** Captures a fresh canonical availability snapshot for one product (no provider write). */
export function runAvailabilitySnapshot(
  productId: number,
  idempotencyKey: string,
): Promise<z.infer<typeof plannerShadowRunSchema>> {
  return requestJson(ENDPOINTS.shadowRuns(productId), plannerShadowRunSchema, jsonInit("POST", { idempotencyKey }));
}
