import { z } from "zod";

import {
  RateCoverageAdminError,
  type DraftRateCoverageGroup,
  type SavedRateCoverageGroup,
} from "./rate-coverage-admin.service";
import type { RateCoverageDestination } from "../domain/rate-coverage";

export const draftLayoutGroupSchema = z.object({
  destinationGroupId: z.number().int().positive().nullable().optional(),
  destinationGroupLockVersion:
    z.number().int().positive().nullable().optional(),
  sourceDestinationScopeId:
    z.number().int().positive().nullable().optional(),
  sourceDestinationScopeLockVersion:
    z.number().int().positive().nullable().optional(),
  name: z.string().trim().max(120),
  originWarehouseId: z.number().int().positive().nullable(),
  regions: z.array(z.string().trim().length(2)).max(60),
  zipEntries: z.array(z.object({
    state: z.string().trim().length(2),
    prefixes: z.array(z.string().regex(/^\d{1,5}$/)).max(500),
  })).max(200),
  bands: z.array(z.object({
    maxMeasure: z.string().max(20),
    rateUsd: z.string().max(20),
    maxShipmentWeightLb: z.string().max(20),
    openEnded: z.boolean().optional(),
  })).max(100),
  pricingModel: z.enum([
    "weight_bands",
    "base_plus_per_started_pound",
  ]).optional(),
  baseChargeUsd: z.string().max(20).optional(),
  perStartedPoundUsd: z.string().max(20).optional(),
  availability: z.enum(["offered", "not_offered"]).default("offered"),
});

export const draftLayoutSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  groups: z.array(draftLayoutGroupSchema).max(100),
});

export type DraftLayoutInput = z.infer<typeof draftLayoutSchema>;

export function readDraftLayout(metadata: unknown): DraftLayoutInput | null {
  const candidate = metadataRecord(metadata).draftLayout;
  const parsed = draftLayoutSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function metadataRecord(metadata: unknown): Record<string, unknown> {
  return metadata !== null
    && typeof metadata === "object"
    && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {};
}

export function coverageGroupsFromDraftLayout(
  layout: DraftLayoutInput,
  options: { clearDestinationGroupIdentity?: boolean } = {},
): DraftRateCoverageGroup[] {
  return layout.groups.map((group, index) => ({
    destinationGroupId: options.clearDestinationGroupIdentity
      ? null
      : group.destinationGroupId ?? null,
    destinationGroupLockVersion: options.clearDestinationGroupIdentity
      ? null
      : group.destinationGroupLockVersion ?? null,
    sourceDestinationScopeId: group.sourceDestinationScopeId ?? null,
    sourceDestinationScopeLockVersion:
      group.sourceDestinationScopeLockVersion ?? null,
    name: destinationGroupName(group, index),
    originWarehouseId: group.originWarehouseId,
    availability: group.availability,
    sortOrder: index,
    destinations: draftGroupDestinations(group),
  }));
}

export function layoutWithSavedGroupIdentities(
  layout: DraftLayoutInput,
  savedGroups: readonly SavedRateCoverageGroup[],
): DraftLayoutInput {
  if (layout.groups.length !== savedGroups.length) {
    throw new RateCoverageAdminError(
      500,
      "SHIPPING_ADMIN_COVERAGE_MANIFEST_MISMATCH",
      "Saved destination groups did not match the draft layout.",
    );
  }
  return {
    version: 3,
    groups: layout.groups.map((group, index) => ({
      ...group,
      destinationGroupId: savedGroups[index].destinationGroupId,
      destinationGroupLockVersion:
        savedGroups[index].destinationGroupLockVersion,
      sourceDestinationScopeId: savedGroups[index].sourceDestinationScopeId,
      sourceDestinationScopeLockVersion:
        savedGroups[index].sourceDestinationScopeLockVersion,
      name: savedGroups[index].name,
      availability: savedGroups[index].availability,
    })),
  };
}

function draftGroupDestinations(
  group: DraftLayoutInput["groups"][number],
): RateCoverageDestination[] {
  return [
    ...group.regions.map((region) => ({
      destinationCountry: "US",
      destinationRegion: region.trim().toUpperCase(),
      postalPrefix: null,
    })),
    ...group.zipEntries.flatMap((entry) =>
      entry.prefixes.map((prefix) => ({
        destinationCountry: "US",
        destinationRegion: entry.state.trim().toUpperCase(),
        postalPrefix: prefix.trim().toUpperCase(),
      }))),
  ];
}

function destinationGroupName(
  group: DraftLayoutInput["groups"][number],
  index: number,
): string {
  const explicit = group.name.trim();
  if (explicit !== "") return explicit;

  const regions = [...new Set(
    group.regions.map((region) => region.trim().toUpperCase()),
  )].sort();
  if (regions.length === 1) return regions[0];
  if (regions.length > 1) {
    const shown = regions.slice(0, 3).join(", ");
    return regions.length <= 3
      ? shown
      : `${shown} + ${regions.length - 3} more`;
  }
  const zipRegions = [...new Set(
    group.zipEntries.map((entry) => entry.state.trim().toUpperCase()),
  )].sort();
  if (zipRegions.length > 0) return `${zipRegions.join(", ")} ZIP overrides`;
  return `Destination group ${index + 1}`;
}
