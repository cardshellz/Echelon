import { createHash } from "node:crypto";

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
  type ChannelExposureDraftSaveResult,
  type CreateInventoryPublicationTargetRequest,
  type InventoryChannelExposureAdminView,
  type InventoryChannelExposurePreview,
  type InventoryPublicationTargetCommandResult,
  type SaveChannelExposurePolicyDraftRequest,
  type SavePublicationSourceBindingDraftRequest,
  type SavePublicationVariantMappingDraftRequest,
  type SetInventoryPublicationTargetPreviewStateRequest,
} from "@shared/types/inventory-channel-exposure";
import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

import { logger } from "../../../platform/observability/logger";
import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";

/**
 * Narrow port onto the dropship module's own resolution of its single internal
 * channel. This page must not re-derive that rule from channel name/type, which
 * would drift from the owning module; it asks dropship instead.
 */
export interface DropshipDestinationChannelResolver {
  resolveChannelId(): Promise<number>;
}

const positiveDatabaseInteger = z.number().int().positive().max(2_147_483_647);
const actorSchema = z.string().trim().min(1).max(100);

export interface SaveChannelExposurePolicyDraftCommand
extends SaveChannelExposurePolicyDraftRequest {
  actorId: string;
  requestHash: string;
  occurredAt: Date;
}

export interface SavePublicationSourceBindingDraftCommand
extends SavePublicationSourceBindingDraftRequest {
  actorId: string;
  requestHash: string;
  occurredAt: Date;
}

export interface CreateInventoryPublicationTargetCommand
extends CreateInventoryPublicationTargetRequest {
  actorId: string;
  requestHash: string;
  occurredAt: Date;
}

export interface SetInventoryPublicationTargetPreviewStateCommand
extends SetInventoryPublicationTargetPreviewStateRequest {
  actorId: string;
  requestHash: string;
  occurredAt: Date;
}

export interface SavePublicationVariantMappingDraftCommand
extends SavePublicationVariantMappingDraftRequest {
  actorId: string;
  requestHash: string;
  occurredAt: Date;
}

/**
 * The exposure store owns everything in the `inventory` schema, but the
 * internal dropship channel is resolved by the dropship module, so the store
 * does not claim that field. The service composes the two.
 */
export type InventoryChannelExposureAdminStoreView =
  Omit<InventoryChannelExposureAdminView, "dropshipDestinationChannelId">;

export interface InventoryChannelExposureAdminStore {
  getAdminView(productId: number | null): Promise<InventoryChannelExposureAdminStoreView>;
  savePolicyDraft(
    command: SaveChannelExposurePolicyDraftCommand,
  ): Promise<ChannelExposureDraftSaveResult>;
  saveSourceBindingDraft(
    command: SavePublicationSourceBindingDraftCommand,
  ): Promise<ChannelExposureDraftSaveResult>;
  createPublicationTarget(
    command: CreateInventoryPublicationTargetCommand,
  ): Promise<InventoryPublicationTargetCommandResult>;
  setPublicationTargetPreviewState(
    command: SetInventoryPublicationTargetPreviewStateCommand,
  ): Promise<InventoryPublicationTargetCommandResult>;
  saveVariantMappingDraft(
    command: SavePublicationVariantMappingDraftCommand,
  ): Promise<ChannelExposureDraftSaveResult>;
  preview(publicationTargetId: number, productId: number): Promise<InventoryChannelExposurePreview>;
}

export interface InventoryChannelExposureClock { now(): Date }

const systemClock: InventoryChannelExposureClock = { now: () => new Date() };

export class InventoryChannelExposureAdminService {
  constructor(
    private readonly store: InventoryChannelExposureAdminStore,
    private readonly clock: InventoryChannelExposureClock = systemClock,
    private readonly dropshipChannel: DropshipDestinationChannelResolver | null = null,
  ) {}

  async getView(productInput?: number | null): Promise<InventoryChannelExposureAdminView> {
    const productId = productInput == null ? null : parseId(productInput, "product");
    const [view, dropshipDestinationChannelId] = await Promise.all([
      this.store.getAdminView(productId),
      this.resolveDropshipDestinationChannelId(),
    ]);
    return inventoryChannelExposureAdminViewSchema.parse({ ...view, dropshipDestinationChannelId });
  }

  /**
   * A missing or ambiguous dropship channel is a configuration state, not a
   * failure of this page: every other channel still needs to be editable. It is
   * reported as null and logged with the owning module's structured code so the
   * condition stays visible, rather than failing the whole read.
   */
  private async resolveDropshipDestinationChannelId(): Promise<number | null> {
    if (!this.dropshipChannel) return null;
    try {
      return await this.dropshipChannel.resolveChannelId();
    } catch (error) {
      logger.warn("inventory_channel_exposure.dropship_channel_unresolved", {
        outcome: "degraded",
        error_code: error instanceof Error && "code" in error ? String(error.code) : "UNKNOWN",
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async savePolicyDraft(
    input: SaveChannelExposurePolicyDraftRequest,
    actorInput: string,
  ): Promise<ChannelExposureDraftSaveResult> {
    const request = parseRequest(
      saveChannelExposurePolicyDraftRequestSchema,
      input,
      "INVENTORY_CHANNEL_EXPOSURE_INVALID_POLICY_DRAFT",
    );
    const actorId = parseActor(actorInput);
    const requestHash = requestHashFor("channel_exposure_policy_draft_save", actorId, request);
    return channelExposureDraftSaveResultSchema.parse(await this.store.savePolicyDraft({
      ...request,
      actorId,
      requestHash,
      occurredAt: validNow(this.clock),
    }));
  }

  async saveSourceBindingDraft(
    input: SavePublicationSourceBindingDraftRequest,
    actorInput: string,
  ): Promise<ChannelExposureDraftSaveResult> {
    const request = parseRequest(
      savePublicationSourceBindingDraftRequestSchema,
      input,
      "INVENTORY_CHANNEL_EXPOSURE_INVALID_SOURCE_BINDING",
    );
    const actorId = parseActor(actorInput);
    const normalizedRequest = {
      ...request,
      fulfillmentNodeIds: [...request.fulfillmentNodeIds].sort((left, right) => left - right),
    };
    const requestHash = requestHashFor(
      "publication_source_binding_draft_save",
      actorId,
      normalizedRequest,
    );
    return channelExposureDraftSaveResultSchema.parse(await this.store.saveSourceBindingDraft({
      ...normalizedRequest,
      actorId,
      requestHash,
      occurredAt: validNow(this.clock),
    }));
  }

  async createPublicationTarget(
    input: CreateInventoryPublicationTargetRequest,
    actorInput: string,
  ): Promise<InventoryPublicationTargetCommandResult> {
    const request = parseRequest(
      createInventoryPublicationTargetRequestSchema,
      input,
      "INVENTORY_CHANNEL_EXPOSURE_INVALID_PUBLICATION_TARGET",
    );
    const actorId = parseActor(actorInput);
    return inventoryPublicationTargetCommandResultSchema.parse(await this.store.createPublicationTarget({
      ...request,
      actorId,
      requestHash: requestHashFor("inventory_publication_target_create", actorId, request),
      occurredAt: validNow(this.clock),
    }));
  }

  async setPublicationTargetPreviewState(
    input: SetInventoryPublicationTargetPreviewStateRequest,
    actorInput: string,
  ): Promise<InventoryPublicationTargetCommandResult> {
    const request = parseRequest(
      setInventoryPublicationTargetPreviewStateRequestSchema,
      input,
      "INVENTORY_CHANNEL_EXPOSURE_INVALID_TARGET_PREVIEW_STATE",
    );
    const actorId = parseActor(actorInput);
    return inventoryPublicationTargetCommandResultSchema.parse(
      await this.store.setPublicationTargetPreviewState({
        ...request,
        actorId,
        requestHash: requestHashFor("inventory_publication_target_preview_state", actorId, request),
        occurredAt: validNow(this.clock),
      }),
    );
  }

  async saveVariantMappingDraft(
    input: SavePublicationVariantMappingDraftRequest,
    actorInput: string,
  ): Promise<ChannelExposureDraftSaveResult> {
    const request = parseRequest(
      savePublicationVariantMappingDraftRequestSchema,
      input,
      "INVENTORY_CHANNEL_EXPOSURE_INVALID_VARIANT_MAPPING",
    );
    const actorId = parseActor(actorInput);
    return channelExposureDraftSaveResultSchema.parse(await this.store.saveVariantMappingDraft({
      ...request,
      actorId,
      requestHash: requestHashFor("publication_variant_mapping_draft_save", actorId, request),
      occurredAt: validNow(this.clock),
    }));
  }

  async preview(
    publicationTargetInput: number,
    productInput: number,
  ): Promise<InventoryChannelExposurePreview> {
    return inventoryChannelExposurePreviewSchema.parse(await this.store.preview(
      parseId(publicationTargetInput, "publication target"),
      parseId(productInput, "product"),
    ));
  }
}

function requestHashFor(commandType: string, actorId: string, request: unknown): string {
  return createHash("sha256").update(canonicalJson({ commandType, actorId, request }), "utf8").digest("hex");
}

function parseRequest<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  code: string,
): z.output<TSchema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      400,
      code,
      "Review the channel-exposure draft fields.",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
    );
  }
  return parsed.data;
}

function parseId(value: number, label: string): number {
  const parsed = positiveDatabaseInteger.safeParse(value);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      400,
      "INVENTORY_CHANNEL_EXPOSURE_INVALID_IDENTIFIER",
      `The ${label} identifier is invalid.`,
    );
  }
  return parsed.data;
}

function parseActor(value: string): string {
  const parsed = actorSchema.safeParse(value);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      401,
      "INVENTORY_AVAILABILITY_ACTOR_REQUIRED",
      "An authenticated operator is required.",
    );
  }
  return parsed.data;
}

function validNow(clock: InventoryChannelExposureClock): Date {
  const now = clock.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new InventoryAvailabilityMasterDataError(
      500,
      "INVENTORY_CHANNEL_EXPOSURE_INVALID_CLOCK",
      "The channel-exposure clock returned an invalid time.",
    );
  }
  return now;
}
