import { and, asc, eq, inArray, sql } from "drizzle-orm";

import {
  shippingRateBooks,
  shippingRateTableRows,
  shippingRateTables,
  shippingServiceLevels,
} from "@shared/schema";
import { db } from "../../../db";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import {
  coverageGroupsFromDraftLayout,
  layoutWithSavedGroupIdentities,
  metadataRecord,
  readDraftLayout,
  type DraftLayoutInput,
} from "../application/rate-table-draft-layout";
import {
  RateProgramCloneError,
  type CreatedRateProgramDraft,
  type RateProgramBlockingRevision,
  type RateProgramCloneRepository,
  type RateProgramRecord,
  type RateProgramSourceRevision,
} from "../application/rate-program-clone.service";
import {
  saveRateCoverageManifest,
  type DraftRateCoverageGroup,
  type SavedRateCoverageGroup,
} from "../application/rate-coverage-admin.service";
import { cloneProductRules } from "../application/product-rate-policy-admin.service";
import { GRAMS_PER_POUND } from "../domain/rate-table-import";
import {
  loadRateTableCoverages,
  PostgresRateCoverageAdminTransaction,
} from "./rate-coverage.repository";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type SourceRateTable = typeof shippingRateTables.$inferSelect;
type SourceRateRow = Pick<
  typeof shippingRateTableRows.$inferSelect,
  | "originWarehouseId"
  | "destinationCountry"
  | "destinationRegion"
  | "postalPrefix"
  | "minMeasure"
  | "maxMeasure"
  | "maxShipmentWeightGrams"
  | "chargeModel"
  | "rateCents"
  | "perStartedPoundCents"
>;

const INSERT_CHUNK_SIZE = 1_000;

export class PostgresRateProgramCloneRepository
implements RateProgramCloneRepository {
  constructor(private readonly tx: Transaction) {}

  async lockRatePrograms(rateBookIds: readonly number[]): Promise<void> {
    // Copy is rare and may create several drafts. This lock keeps the
    // preflight conflict check atomic with draft inserts, including against
    // older admin writers that do not lock the pricing-program row.
    await this.tx.execute(sql`
      LOCK TABLE shipping.rate_tables IN SHARE ROW EXCLUSIVE MODE
    `);
    const orderedIds = [...new Set(rateBookIds)].sort((left, right) => left - right);
    for (const id of orderedIds) {
      await this.tx.execute(sql`
        SELECT id
        FROM shipping.rate_books
        WHERE id = ${id}
        FOR UPDATE
      `);
    }
  }

  async loadRatePrograms(
    rateBookIds: readonly number[],
  ): Promise<RateProgramRecord[]> {
    if (rateBookIds.length === 0) return [];
    return this.tx
      .select({
        id: shippingRateBooks.id,
        name: shippingRateBooks.name,
        status: shippingRateBooks.status,
      })
      .from(shippingRateBooks)
      .where(inArray(shippingRateBooks.id, [...rateBookIds]))
      .orderBy(asc(shippingRateBooks.id));
  }

  async loadActiveSourceRevisions(
    sourceRateBookId: number,
  ): Promise<RateProgramSourceRevision[]> {
    return this.tx
      .select({
        id: shippingRateTables.id,
        serviceLevelId: shippingRateTables.serviceLevelId,
        serviceLevelCode: shippingServiceLevels.code,
        serviceLevelName: shippingServiceLevels.displayName,
        serviceLevelSortOrder: shippingServiceLevels.sortOrder,
      })
      .from(shippingRateTables)
      .innerJoin(
        shippingServiceLevels,
        eq(shippingServiceLevels.id, shippingRateTables.serviceLevelId),
      )
      .where(and(
        eq(shippingRateTables.rateBookId, sourceRateBookId),
        eq(shippingRateTables.status, "active"),
      ))
      .orderBy(
        asc(shippingServiceLevels.sortOrder),
        asc(shippingServiceLevels.id),
        asc(shippingRateTables.id),
      );
  }

  async loadBlockingTargetRevisions(
    targetRateBookId: number,
  ): Promise<RateProgramBlockingRevision[]> {
    const rows = await this.tx
      .select({
        id: shippingRateTables.id,
        serviceLevelId: shippingRateTables.serviceLevelId,
        serviceLevelCode: shippingServiceLevels.code,
        serviceLevelName: shippingServiceLevels.displayName,
        status: shippingRateTables.status,
      })
      .from(shippingRateTables)
      .innerJoin(
        shippingServiceLevels,
        eq(shippingServiceLevels.id, shippingRateTables.serviceLevelId),
      )
      .where(and(
        eq(shippingRateTables.rateBookId, targetRateBookId),
        inArray(shippingRateTables.status, ["active", "draft"]),
      ))
      .orderBy(
        asc(shippingServiceLevels.sortOrder),
        asc(shippingRateTables.id),
      );
    return rows.map((row) => ({
      ...row,
      status: row.status as "active" | "draft",
    }));
  }

  async cloneRevision(input: {
    source: RateProgramSourceRevision;
    targetRateBookId: number;
    actor: string;
    now: Date;
  }): Promise<CreatedRateProgramDraft> {
    await this.tx.execute(sql`
      SELECT id
      FROM shipping.rate_tables
      WHERE id = ${input.source.id}
      FOR UPDATE
    `);
    const [sourceTable] = await this.tx
      .select()
      .from(shippingRateTables)
      .where(eq(shippingRateTables.id, input.source.id))
      .limit(1);
    if (sourceTable === undefined || sourceTable.status !== "active") {
      throw new RateProgramCloneError(
        409,
        "SHIPPING_ADMIN_COPY_SOURCE_CHANGED",
        `${input.source.serviceLevelName} is no longer a live source revision.`,
        { sourceRateTableId: input.source.id },
      );
    }

    const rows = await this.loadRows(sourceTable.id);
    const sourceCoverages = await loadRateTableCoverages(
      this.tx,
      [sourceTable.id],
    );
    const sourceLayout = readDraftLayout(sourceTable.metadata);
    const coverageGroups = sourceCoverages.length > 0
      ? sourceCoverages.map((coverage): DraftRateCoverageGroup => ({
          destinationGroupId: null,
          destinationGroupLockVersion: null,
          sourceDestinationScopeId: coverage.sourceDestinationScopeId,
          sourceDestinationScopeLockVersion:
            coverage.sourceDestinationScopeLockVersion,
          name: coverage.destinationGroupName,
          originWarehouseId: coverage.originWarehouseId,
          availability: coverage.availability,
          sortOrder: coverage.sortOrder,
          destinations: coverage.destinations,
        }))
      : sourceLayout === null
        ? []
        : coverageGroupsFromDraftLayout(sourceLayout, {
            clearDestinationGroupIdentity: true,
          });
    if (coverageGroups.length === 0) {
      throw new RateProgramCloneError(
        409,
        "SHIPPING_ADMIN_COPY_SOURCE_COVERAGE_MISSING",
        `${input.source.serviceLevelName} has no saved destination coverage to copy.`,
        { sourceRateTableId: sourceTable.id },
      );
    }

    const [draft] = await this.tx
      .insert(shippingRateTables)
      .values({
        rateBookId: input.targetRateBookId,
        serviceLevelId: sourceTable.serviceLevelId,
        pricingBasis: sourceTable.pricingBasis,
        currency: sourceTable.currency,
        status: "draft",
        effectiveFrom: input.now,
        effectiveTo: null,
        metadata: copyMetadata(sourceTable, input, rows.length),
      })
      .returning();
    await this.insertRows(draft.id, rows);
    await cloneProductRules(this.tx, sourceTable.id, draft.id);

    const saved = await saveRateCoverageManifest(
      new PostgresRateCoverageAdminTransaction(this.tx),
      {
        rateBookId: input.targetRateBookId,
        rateTableId: draft.id,
        groups: coverageGroups,
        actor: input.actor,
        now: input.now,
      },
    );
    const draftLayout = sourceLayout === null
      ? layoutFromCoverageAndRows(
          saved.groups,
          rows,
          sourceTable.pricingBasis,
        )
      : remapCrossProgramLayout(
          sourceLayout,
          sourceCoverages,
          saved.groups,
        );
    const [savedDraft] = await this.tx
      .update(shippingRateTables)
      .set({
        metadata: {
          ...metadataRecord(draft.metadata),
          draftLayout,
          coverageManifestVersion: 1,
        },
      })
      .where(eq(shippingRateTables.id, draft.id))
      .returning();

    await persistAuditEvent(this.tx, {
      actor: input.actor,
      action: "shipping.rate_table_draft.copied_between_programs",
      target: `shipping.rate_tables:${draft.id}`,
      changes: {
        before: null,
        after: {
          id: savedDraft.id,
          rateBookId: savedDraft.rateBookId,
          serviceLevelId: savedDraft.serviceLevelId,
          status: savedDraft.status,
          rowCount: rows.length,
          coverageCount: saved.coverages.length,
        },
      },
      context: {
        sourceRateTableId: sourceTable.id,
        sourceRateBookId: sourceTable.rateBookId,
        targetRateBookId: input.targetRateBookId,
      },
    }, { timestamp: input.now });

    return {
      id: savedDraft.id,
      sourceRateTableId: sourceTable.id,
      serviceLevelId: input.source.serviceLevelId,
      serviceLevelCode: input.source.serviceLevelCode,
      serviceLevelName: input.source.serviceLevelName,
      rowCount: rows.length,
      coverageCount: saved.coverages.length,
    };
  }

  async persistProgramCloneAudit(input: {
    actor: string;
    sourceRateBook: RateProgramRecord;
    targetRateBook: RateProgramRecord;
    createdDrafts: readonly CreatedRateProgramDraft[];
    now: Date;
  }): Promise<void> {
    await persistAuditEvent(this.tx, {
      actor: input.actor,
      action: "shipping.rate_program.live_rates_copied_as_drafts",
      target: `shipping.rate_books:${input.targetRateBook.id}`,
      changes: {
        before: { copiedDraftCount: 0 },
        after: {
          copiedDraftCount: input.createdDrafts.length,
          draftRateTableIds: input.createdDrafts.map((draft) => draft.id),
        },
      },
      context: {
        sourceRateBookId: input.sourceRateBook.id,
        sourceRateBookName: input.sourceRateBook.name,
        targetRateBookId: input.targetRateBook.id,
        targetRateBookName: input.targetRateBook.name,
        assignmentsCopied: false,
        liveRatesChanged: false,
      },
    }, { timestamp: input.now });
  }

  private async loadRows(rateTableId: number): Promise<SourceRateRow[]> {
    return this.tx
      .select({
        originWarehouseId: shippingRateTableRows.originWarehouseId,
        destinationCountry: shippingRateTableRows.destinationCountry,
        destinationRegion: shippingRateTableRows.destinationRegion,
        postalPrefix: shippingRateTableRows.postalPrefix,
        minMeasure: shippingRateTableRows.minMeasure,
        maxMeasure: shippingRateTableRows.maxMeasure,
        maxShipmentWeightGrams:
          shippingRateTableRows.maxShipmentWeightGrams,
        chargeModel: shippingRateTableRows.chargeModel,
        rateCents: shippingRateTableRows.rateCents,
        perStartedPoundCents:
          shippingRateTableRows.perStartedPoundCents,
      })
      .from(shippingRateTableRows)
      .where(eq(shippingRateTableRows.rateTableId, rateTableId))
      .orderBy(
        asc(shippingRateTableRows.destinationCountry),
        asc(shippingRateTableRows.destinationRegion),
        asc(shippingRateTableRows.postalPrefix),
        asc(shippingRateTableRows.originWarehouseId),
        asc(shippingRateTableRows.minMeasure),
      );
  }

  private async insertRows(
    rateTableId: number,
    rows: readonly SourceRateRow[],
  ): Promise<void> {
    for (let index = 0; index < rows.length; index += INSERT_CHUNK_SIZE) {
      await this.tx.insert(shippingRateTableRows).values(
        rows.slice(index, index + INSERT_CHUNK_SIZE).map((row) => ({
          ...row,
          rateTableId,
        })),
      );
    }
  }
}

function copyMetadata(
  sourceTable: SourceRateTable,
  input: {
    targetRateBookId: number;
    actor: string;
    now: Date;
  },
  rowCount: number,
): Record<string, unknown> {
  const source = metadataRecord(sourceTable.metadata);
  const {
    activatedAt: _activatedAt,
    activatedBy: _activatedBy,
    draftLayout: _draftLayout,
    ...copyable
  } = source;
  return {
    ...copyable,
    source: "admin-program-copy",
    copiedFromRateBookId: sourceTable.rateBookId,
    copiedFromRateTableId: sourceTable.id,
    copiedToRateBookId: input.targetRateBookId,
    copiedBy: input.actor,
    copiedAt: input.now.toISOString(),
    rowCount,
  };
}

function remapCrossProgramLayout(
  sourceLayout: DraftLayoutInput,
  sourceCoverages: Awaited<ReturnType<typeof loadRateTableCoverages>>,
  savedGroups: readonly SavedRateCoverageGroup[],
): DraftLayoutInput {
  if (sourceCoverages.length === 0) {
    return layoutWithSavedGroupIdentities(sourceLayout, savedGroups);
  }
  if (sourceCoverages.length !== savedGroups.length) {
    throw new RateProgramCloneError(
      409,
      "SHIPPING_ADMIN_COPY_SOURCE_LAYOUT_STALE",
      "The source destination layout no longer matches its live coverage.",
    );
  }
  const targetBySourceScope = new Map(
    sourceCoverages.map((coverage, index) => [
      coverageScopeKey(
        coverage.destinationGroupId,
        coverage.originWarehouseId,
      ),
      savedGroups[index],
    ]),
  );
  return {
    version: 2,
    groups: sourceLayout.groups.map((group) => {
      const sourceGroupId = group.destinationGroupId ?? null;
      const saved = sourceGroupId === null
        ? null
        : targetBySourceScope.get(
            coverageScopeKey(sourceGroupId, group.originWarehouseId),
          ) ?? null;
      if (saved === null) {
        throw new RateProgramCloneError(
          409,
          "SHIPPING_ADMIN_COPY_SOURCE_LAYOUT_STALE",
          "The source destination layout no longer matches its live coverage.",
          {
            destinationGroupId: sourceGroupId,
            originWarehouseId: group.originWarehouseId,
          },
        );
      }
      return {
        ...group,
        destinationGroupId: saved.destinationGroupId,
        destinationGroupLockVersion:
          saved.destinationGroupLockVersion,
        name: saved.name,
        availability: saved.availability,
      };
    }),
  };
}

function layoutFromCoverageAndRows(
  groups: readonly SavedRateCoverageGroup[],
  rows: readonly SourceRateRow[],
  pricingBasis: string,
): DraftLayoutInput {
  return {
    version: 2,
    groups: groups.map((group) => {
      const schedules = group.destinations.map((destination) =>
        rowsForDestination(rows, group.originWarehouseId, destination));
      const firstSchedule = schedules[0] ?? [];
      const signature = rateScheduleSignature(firstSchedule);
      if (
        schedules.some((schedule) =>
          rateScheduleSignature(schedule) !== signature)
      ) {
        throw new RateProgramCloneError(
          409,
          "SHIPPING_ADMIN_COPY_SOURCE_RATE_GROUP_INCONSISTENT",
          `${group.name} does not use one consistent rate schedule.`,
        );
      }
      const formula = firstSchedule.find(
        (row) => row.chargeModel === "base_plus_per_started_pound",
      );
      const regions = group.destinations
        .filter((destination) => destination.postalPrefix === null)
        .flatMap((destination) =>
          destination.destinationRegion === null
            ? []
            : [destination.destinationRegion]);
      const zipByRegion = new Map<string, string[]>();
      for (const destination of group.destinations) {
        if (
          destination.destinationRegion === null
          || destination.postalPrefix === null
        ) {
          continue;
        }
        zipByRegion.set(destination.destinationRegion, [
          ...(zipByRegion.get(destination.destinationRegion) ?? []),
          destination.postalPrefix,
        ]);
      }
      return {
        destinationGroupId: group.destinationGroupId,
        destinationGroupLockVersion:
          group.destinationGroupLockVersion,
        name: group.name,
        originWarehouseId: group.originWarehouseId,
        regions,
        zipEntries: [...zipByRegion.entries()].map(([state, prefixes]) => ({
          state,
          prefixes,
        })),
        availability: group.availability,
        pricingModel: formula === undefined
          ? "weight_bands"
          : "base_plus_per_started_pound",
        baseChargeUsd: formula === undefined
          ? ""
          : centsToUsd(formula.rateCents),
        perStartedPoundUsd: formula?.perStartedPoundCents == null
          ? ""
          : centsToUsd(formula.perStartedPoundCents),
        bands: firstSchedule
          .filter((row) => row.chargeModel === "fixed_band")
          .map((row) => ({
            maxMeasure: row.maxMeasure === null
              ? ""
              : pricingBasis === "pallet_count"
                ? String(row.maxMeasure)
                : poundsFromGrams(row.maxMeasure, 3),
            rateUsd: centsToUsd(row.rateCents),
            maxShipmentWeightLb:
              row.maxShipmentWeightGrams === null
                ? ""
                : poundsFromGrams(row.maxShipmentWeightGrams, 1),
            openEnded: row.maxMeasure === null,
          })),
      };
    }),
  };
}

function rowsForDestination(
  rows: readonly SourceRateRow[],
  originWarehouseId: number | null,
  destination: {
    destinationCountry: string;
    destinationRegion: string | null;
    postalPrefix: string | null;
  },
): SourceRateRow[] {
  return rows
    .filter((row) =>
      row.originWarehouseId === originWarehouseId
      && row.destinationCountry === destination.destinationCountry
      && row.destinationRegion === destination.destinationRegion
      && row.postalPrefix === destination.postalPrefix)
    .sort((left, right) => left.minMeasure - right.minMeasure);
}

function rateScheduleSignature(rows: readonly SourceRateRow[]): string {
  return JSON.stringify(rows.map((row) => ({
    minMeasure: row.minMeasure,
    maxMeasure: row.maxMeasure,
    maxShipmentWeightGrams: row.maxShipmentWeightGrams,
    chargeModel: row.chargeModel,
    rateCents: row.rateCents,
    perStartedPoundCents: row.perStartedPoundCents,
  })));
}

function coverageScopeKey(
  destinationGroupId: number,
  originWarehouseId: number | null,
): string {
  return `${destinationGroupId}:${originWarehouseId ?? "all"}`;
}

function centsToUsd(cents: number): string {
  const wholeDollars = Math.trunc(cents / 100);
  const remainder = Math.abs(cents % 100);
  return `${wholeDollars}.${String(remainder).padStart(2, "0")}`;
}

function poundsFromGrams(grams: number, precision: number): string {
  return String(Number((grams / GRAMS_PER_POUND).toFixed(precision)));
}
