import { createHash } from "node:crypto";

import {
  channelExposureDraftSaveResultSchema,
  inventoryChannelExposureAdminViewSchema,
  inventoryChannelExposurePreviewSchema,
  saveChannelExposurePolicyDraftRequestSchema,
  savePublicationSourceBindingDraftRequestSchema,
  type ChannelExposureDraftSaveResult,
  type InventoryChannelExposureAdminView,
  type InventoryChannelExposurePreview,
  type SaveChannelExposurePolicyDraftRequest,
  type SavePublicationSourceBindingDraftRequest,
} from "@shared/types/inventory-channel-exposure";
import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";

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

export interface InventoryChannelExposureAdminStore {
  getAdminView(productId: number | null): Promise<InventoryChannelExposureAdminView>;
  savePolicyDraft(
    command: SaveChannelExposurePolicyDraftCommand,
  ): Promise<ChannelExposureDraftSaveResult>;
  saveSourceBindingDraft(
    command: SavePublicationSourceBindingDraftCommand,
  ): Promise<ChannelExposureDraftSaveResult>;
  preview(publicationTargetId: number, productId: number): Promise<InventoryChannelExposurePreview>;
}

export interface InventoryChannelExposureClock { now(): Date }

const systemClock: InventoryChannelExposureClock = { now: () => new Date() };

export class InventoryChannelExposureAdminService {
  constructor(
    private readonly store: InventoryChannelExposureAdminStore,
    private readonly clock: InventoryChannelExposureClock = systemClock,
  ) {}

  async getView(productInput?: number | null): Promise<InventoryChannelExposureAdminView> {
    const productId = productInput == null ? null : parseId(productInput, "product");
    return inventoryChannelExposureAdminViewSchema.parse(await this.store.getAdminView(productId));
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

function parseRequest<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: string,
): T {
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
