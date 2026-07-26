import {
  and,
  asc,
  eq,
  inArray,
  sql,
} from "drizzle-orm";
import {
  shippingRateBookDestinationGroupMembers,
  shippingRateBookDestinationGroups,
  shippingRateTableCoverageDestinations,
  shippingRateTableCoverages,
  shippingRateTableRows,
} from "@shared/schema";
import { db } from "../../../db";
import {
  persistAuditEvent,
  type AuditLogPayload,
} from "../../../infrastructure/auditLogger";
import type {
  RateBookDestinationGroupRecord,
  RateCoverageAdminTransaction,
  RateTableCoverageRecord,
  SavedRateCoverageGroup,
} from "../application/rate-coverage-admin.service";
import type {
  RateCoverageDestination,
} from "../domain/rate-coverage";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Transaction;

export class PostgresRateCoverageAdminTransaction
implements RateCoverageAdminTransaction {
  constructor(private readonly tx: Transaction) {}

  async getDestinationGroupForUpdate(
    destinationGroupId: number,
  ): Promise<RateBookDestinationGroupRecord | null> {
    await this.tx.execute(sql`
      SELECT id
      FROM shipping.rate_book_destination_groups
      WHERE id = ${destinationGroupId}
      FOR UPDATE
    `);
    return loadDestinationGroup(this.tx, destinationGroupId);
  }

  async findActiveDestinationGroupByName(
    rateBookId: number,
    name: string,
  ): Promise<RateBookDestinationGroupRecord | null> {
    const [group] = await this.tx
      .select({ id: shippingRateBookDestinationGroups.id })
      .from(shippingRateBookDestinationGroups)
      .where(and(
        eq(shippingRateBookDestinationGroups.rateBookId, rateBookId),
        eq(shippingRateBookDestinationGroups.status, "active"),
        sql`lower(${shippingRateBookDestinationGroups.name}) = lower(${name})`,
      ))
      .limit(1);
    if (!group) return null;
    return this.getDestinationGroupForUpdate(group.id);
  }

  async insertDestinationGroup(input: {
    rateBookId: number;
    name: string;
    sortOrder: number;
    actor: string;
    now: Date;
    destinations: readonly RateCoverageDestination[];
  }): Promise<RateBookDestinationGroupRecord> {
    const [created] = await this.tx
      .insert(shippingRateBookDestinationGroups)
      .values({
        rateBookId: input.rateBookId,
        name: input.name,
        status: "active",
        sortOrder: input.sortOrder,
        lockVersion: 1,
        createdBy: input.actor,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning({ id: shippingRateBookDestinationGroups.id });
    await insertDestinationMembers(this.tx, created.id, input.destinations);
    const result = await loadDestinationGroup(this.tx, created.id);
    if (result === null) {
      throw new Error(`Destination group ${created.id} was not readable after insert.`);
    }
    return result;
  }

  async updateDestinationGroup(input: {
    destinationGroupId: number;
    expectedLockVersion: number;
    name: string;
    sortOrder: number;
    now: Date;
    destinations: readonly RateCoverageDestination[];
  }): Promise<RateBookDestinationGroupRecord | null> {
    const [updated] = await this.tx
      .update(shippingRateBookDestinationGroups)
      .set({
        name: input.name,
        sortOrder: input.sortOrder,
        lockVersion: sql`${shippingRateBookDestinationGroups.lockVersion} + 1`,
        updatedAt: input.now,
      })
      .where(and(
        eq(shippingRateBookDestinationGroups.id, input.destinationGroupId),
        eq(shippingRateBookDestinationGroups.status, "active"),
        eq(
          shippingRateBookDestinationGroups.lockVersion,
          input.expectedLockVersion,
        ),
      ))
      .returning({ id: shippingRateBookDestinationGroups.id });
    if (!updated) return null;

    await this.tx
      .delete(shippingRateBookDestinationGroupMembers)
      .where(eq(
        shippingRateBookDestinationGroupMembers.destinationGroupId,
        input.destinationGroupId,
      ));
    await insertDestinationMembers(
      this.tx,
      input.destinationGroupId,
      input.destinations,
    );
    return loadDestinationGroup(this.tx, input.destinationGroupId);
  }

  loadRateTableCoverages(
    rateTableId: number,
  ): Promise<RateTableCoverageRecord[]> {
    return loadRateTableCoverages(this.tx, [rateTableId]);
  }

  async replaceRateTableCoverages(input: {
    rateTableId: number;
    groups: readonly SavedRateCoverageGroup[];
  }): Promise<RateTableCoverageRecord[]> {
    await this.tx
      .delete(shippingRateTableCoverages)
      .where(eq(shippingRateTableCoverages.rateTableId, input.rateTableId));

    for (const group of input.groups) {
      const [coverage] = await this.tx
        .insert(shippingRateTableCoverages)
        .values({
          rateTableId: input.rateTableId,
          destinationGroupId: group.destinationGroupId,
          originWarehouseId: group.originWarehouseId,
          availability: group.availability,
          destinationGroupLockVersion:
            group.destinationGroupLockVersion,
          destinationGroupName: group.name,
          sortOrder: group.sortOrder,
        })
        .returning({ id: shippingRateTableCoverages.id });
      await insertCoverageDestinations(
        this.tx,
        coverage.id,
        group.destinations,
      );
    }

    return loadRateTableCoverages(this.tx, [input.rateTableId]);
  }

  persistAudit(payload: AuditLogPayload, now: Date): Promise<void> {
    return persistAuditEvent(this.tx, payload, { timestamp: now });
  }
}

export async function loadRateBookDestinationGroups(
  executor: Executor = db,
  rateBookIds?: readonly number[],
): Promise<RateBookDestinationGroupRecord[]> {
  if (rateBookIds !== undefined && rateBookIds.length === 0) return [];
  const groups = await executor
    .select({
      id: shippingRateBookDestinationGroups.id,
      rateBookId: shippingRateBookDestinationGroups.rateBookId,
      name: shippingRateBookDestinationGroups.name,
      status: shippingRateBookDestinationGroups.status,
      sortOrder: shippingRateBookDestinationGroups.sortOrder,
      lockVersion: shippingRateBookDestinationGroups.lockVersion,
    })
    .from(shippingRateBookDestinationGroups)
    .where(rateBookIds === undefined
      ? undefined
      : inArray(shippingRateBookDestinationGroups.rateBookId, [...rateBookIds]))
    .orderBy(
      asc(shippingRateBookDestinationGroups.rateBookId),
      asc(shippingRateBookDestinationGroups.sortOrder),
      asc(shippingRateBookDestinationGroups.id),
    );
  if (groups.length === 0) return [];

  const members = await executor
    .select({
      destinationGroupId:
        shippingRateBookDestinationGroupMembers.destinationGroupId,
      destinationCountry:
        shippingRateBookDestinationGroupMembers.destinationCountry,
      destinationRegion:
        shippingRateBookDestinationGroupMembers.destinationRegion,
      postalPrefix: shippingRateBookDestinationGroupMembers.postalPrefix,
    })
    .from(shippingRateBookDestinationGroupMembers)
    .where(inArray(
      shippingRateBookDestinationGroupMembers.destinationGroupId,
      groups.map((group) => group.id),
    ))
    .orderBy(
      asc(shippingRateBookDestinationGroupMembers.destinationCountry),
      asc(shippingRateBookDestinationGroupMembers.destinationRegion),
      asc(shippingRateBookDestinationGroupMembers.postalPrefix),
    );
  const membersByGroup = groupBy(
    members,
    (member) => member.destinationGroupId,
  );
  return groups.map((group) => ({
    ...group,
    status: group.status as "active" | "retired",
    destinations: (membersByGroup.get(group.id) ?? []).map(
      ({ destinationGroupId: _destinationGroupId, ...member }) => member,
    ),
  }));
}

export async function loadRateTableCoverages(
  executor: Executor = db,
  rateTableIds?: readonly number[],
): Promise<RateTableCoverageRecord[]> {
  if (rateTableIds !== undefined && rateTableIds.length === 0) return [];
  const coverages = await executor
    .select({
      id: shippingRateTableCoverages.id,
      rateTableId: shippingRateTableCoverages.rateTableId,
      destinationGroupId: shippingRateTableCoverages.destinationGroupId,
      originWarehouseId: shippingRateTableCoverages.originWarehouseId,
      availability: shippingRateTableCoverages.availability,
      destinationGroupLockVersion:
        shippingRateTableCoverages.destinationGroupLockVersion,
      destinationGroupName: shippingRateTableCoverages.destinationGroupName,
      sortOrder: shippingRateTableCoverages.sortOrder,
    })
    .from(shippingRateTableCoverages)
    .where(rateTableIds === undefined
      ? undefined
      : inArray(shippingRateTableCoverages.rateTableId, [...rateTableIds]))
    .orderBy(
      asc(shippingRateTableCoverages.rateTableId),
      asc(shippingRateTableCoverages.sortOrder),
      asc(shippingRateTableCoverages.id),
    );
  if (coverages.length === 0) return [];

  const destinations = await executor
    .select({
      rateTableCoverageId:
        shippingRateTableCoverageDestinations.rateTableCoverageId,
      destinationCountry:
        shippingRateTableCoverageDestinations.destinationCountry,
      destinationRegion:
        shippingRateTableCoverageDestinations.destinationRegion,
      postalPrefix:
        shippingRateTableCoverageDestinations.postalPrefix,
    })
    .from(shippingRateTableCoverageDestinations)
    .where(inArray(
      shippingRateTableCoverageDestinations.rateTableCoverageId,
      coverages.map((coverage) => coverage.id),
    ))
    .orderBy(
      asc(shippingRateTableCoverageDestinations.destinationCountry),
      asc(shippingRateTableCoverageDestinations.destinationRegion),
      asc(shippingRateTableCoverageDestinations.postalPrefix),
    );
  const rateCounts = await executor
    .select({
      rateTableCoverageId: shippingRateTableCoverages.id,
      rateRowCount: sql<number>`count(${shippingRateTableRows.id})::int`,
    })
    .from(shippingRateTableCoverages)
    .innerJoin(
      shippingRateTableCoverageDestinations,
      eq(
        shippingRateTableCoverageDestinations.rateTableCoverageId,
        shippingRateTableCoverages.id,
      ),
    )
    .leftJoin(
      shippingRateTableRows,
      and(
        eq(
          shippingRateTableRows.rateTableId,
          shippingRateTableCoverages.rateTableId,
        ),
        sql`
          COALESCE(${shippingRateTableRows.originWarehouseId}, 0)
          = COALESCE(${shippingRateTableCoverages.originWarehouseId}, 0)
        `,
        eq(
          shippingRateTableRows.destinationCountry,
          shippingRateTableCoverageDestinations.destinationCountry,
        ),
        sql`
          COALESCE(${shippingRateTableRows.destinationRegion}, '')
          = COALESCE(${shippingRateTableCoverageDestinations.destinationRegion}, '')
        `,
        sql`
          COALESCE(${shippingRateTableRows.postalPrefix}, '')
          = COALESCE(${shippingRateTableCoverageDestinations.postalPrefix}, '')
        `,
      ),
    )
    .where(inArray(
      shippingRateTableCoverages.id,
      coverages.map((coverage) => coverage.id),
    ))
    .groupBy(shippingRateTableCoverages.id);
  const destinationsByCoverage = groupBy(
    destinations,
    (destination) => destination.rateTableCoverageId,
  );
  const rateCountByCoverage = new Map(
    rateCounts.map((item) => [item.rateTableCoverageId, item.rateRowCount]),
  );
  return coverages.map((coverage) => ({
    ...coverage,
    name: coverage.destinationGroupName,
    rateRowCount: rateCountByCoverage.get(coverage.id) ?? 0,
    destinations: (destinationsByCoverage.get(coverage.id) ?? []).map(
      ({ rateTableCoverageId: _rateTableCoverageId, ...destination }) =>
        destination,
    ),
  }));
}

export async function cloneRateTableCoverages(
  tx: Transaction,
  sourceRateTableId: number,
  targetRateTableId: number,
): Promise<number> {
  const source = await loadRateTableCoverages(tx, [sourceRateTableId]);
  for (const coverage of source) {
    const [created] = await tx
      .insert(shippingRateTableCoverages)
      .values({
        rateTableId: targetRateTableId,
        destinationGroupId: coverage.destinationGroupId,
        originWarehouseId: coverage.originWarehouseId,
        availability: coverage.availability,
        destinationGroupLockVersion: coverage.destinationGroupLockVersion,
        destinationGroupName: coverage.destinationGroupName,
        sortOrder: coverage.sortOrder,
      })
      .returning({ id: shippingRateTableCoverages.id });
    await insertCoverageDestinations(
      tx,
      created.id,
      coverage.destinations,
    );
  }
  return source.length;
}

async function loadDestinationGroup(
  executor: Executor,
  destinationGroupId: number,
): Promise<RateBookDestinationGroupRecord | null> {
  const groups = await executor
    .select({
      id: shippingRateBookDestinationGroups.id,
      rateBookId: shippingRateBookDestinationGroups.rateBookId,
      name: shippingRateBookDestinationGroups.name,
      status: shippingRateBookDestinationGroups.status,
      sortOrder: shippingRateBookDestinationGroups.sortOrder,
      lockVersion: shippingRateBookDestinationGroups.lockVersion,
    })
    .from(shippingRateBookDestinationGroups)
    .where(eq(shippingRateBookDestinationGroups.id, destinationGroupId))
    .limit(1);
  const [group] = groups;
  if (!group) return null;
  const members = await executor
    .select({
      destinationCountry:
        shippingRateBookDestinationGroupMembers.destinationCountry,
      destinationRegion:
        shippingRateBookDestinationGroupMembers.destinationRegion,
      postalPrefix: shippingRateBookDestinationGroupMembers.postalPrefix,
    })
    .from(shippingRateBookDestinationGroupMembers)
    .where(eq(
      shippingRateBookDestinationGroupMembers.destinationGroupId,
      destinationGroupId,
    ))
    .orderBy(
      asc(shippingRateBookDestinationGroupMembers.destinationCountry),
      asc(shippingRateBookDestinationGroupMembers.destinationRegion),
      asc(shippingRateBookDestinationGroupMembers.postalPrefix),
    );
  return {
    ...group,
    status: group.status as "active" | "retired",
    destinations: members,
  };
}

async function insertDestinationMembers(
  tx: Transaction,
  destinationGroupId: number,
  destinations: readonly RateCoverageDestination[],
): Promise<void> {
  if (destinations.length === 0) return;
  await tx.insert(shippingRateBookDestinationGroupMembers).values(
    destinations.map((destination) => ({
      destinationGroupId,
      destinationCountry: destination.destinationCountry,
      destinationRegion: destination.destinationRegion,
      postalPrefix: destination.postalPrefix,
    })),
  );
}

async function insertCoverageDestinations(
  tx: Transaction,
  rateTableCoverageId: number,
  destinations: readonly RateCoverageDestination[],
): Promise<void> {
  if (destinations.length === 0) return;
  await tx.insert(shippingRateTableCoverageDestinations).values(
    destinations.map((destination) => ({
      rateTableCoverageId,
      destinationCountry: destination.destinationCountry,
      destinationRegion: destination.destinationRegion,
      postalPrefix: destination.postalPrefix,
    })),
  );
}

function groupBy<T, K>(
  items: readonly T[],
  key: (item: T) => K,
): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const item of items) {
    grouped.set(key(item), [...(grouped.get(key(item)) ?? []), item]);
  }
  return grouped;
}
