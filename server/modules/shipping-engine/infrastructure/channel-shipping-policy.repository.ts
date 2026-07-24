import {
  and,
  asc,
  desc,
  eq,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import {
  channels,
  shippingChannelPolicies,
  shippingChannelPolicyRouteDestinations,
  shippingChannelPolicyRoutes,
  shippingDestinationScopeMembers,
  shippingDestinationScopes,
  shippingQuoteSnapshots,
  shippingRateBooks,
  shippingRateTables,
  warehouses,
} from "@shared/schema";
import type {
  ShippingChannelPolicyPurpose,
  ShippingChannelPolicyStatus,
  ShippingChannelPolicyView,
  ShippingDestinationScopeMember,
  ShippingDestinationScopeSummary,
} from "@shared/types/shipping-channel-routing";
import { db } from "../../../db";
import {
  persistAuditEvent,
  type AuditLogPayload,
} from "../../../infrastructure/auditLogger";
import type {
  ChannelShippingPolicyAdminStore,
  ChannelShippingPolicyStoreOverview,
  ChannelShippingPolicyAdminTransaction,
  PreparedPolicyRoute,
} from "../application/channel-shipping-policy-admin.service";
import { selectRateBookAssignment } from "../domain/rate-book";
import type { ShippingRateContext } from "../domain/shipping-channel";
import { loadActiveRateBookAssignments } from "./rate-book.repository";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Transaction;

interface PolicyMetadata {
  notes?: unknown;
}

export class PostgresChannelShippingPolicyAdminStore
implements ChannelShippingPolicyAdminStore {
  async listOverview(): Promise<ChannelShippingPolicyStoreOverview> {
    const channelRows = await db
      .select({
        id: channels.id,
        name: channels.name,
        provider: channels.provider,
        status: channels.status,
      })
      .from(channels)
      .orderBy(asc(channels.name), asc(channels.id));
    const policyRows = await db
      .select({
        id: shippingChannelPolicies.id,
        channelId: shippingChannelPolicies.channelId,
        purpose: shippingChannelPolicies.purpose,
        version: shippingChannelPolicies.version,
        status: shippingChannelPolicies.status,
        lockVersion: shippingChannelPolicies.lockVersion,
        activatedAt: shippingChannelPolicies.activatedAt,
        updatedAt: shippingChannelPolicies.updatedAt,
      })
      .from(shippingChannelPolicies)
      .where(or(
        eq(shippingChannelPolicies.status, "active"),
        eq(shippingChannelPolicies.status, "draft"),
      ))
      .orderBy(
        asc(shippingChannelPolicies.channelId),
        asc(shippingChannelPolicies.purpose),
        desc(shippingChannelPolicies.version),
      );
    const destinationScopes = await loadDestinationScopes(db);
    const rateBooks = await loadRateBookOptions(db);
    const warehouseRows = await db
      .select({
        id: warehouses.id,
        code: warehouses.code,
        name: warehouses.name,
        isActive: warehouses.isActive,
      })
      .from(warehouses)
      .orderBy(asc(warehouses.name), asc(warehouses.id));

    return {
      channels: channelRows.map((channel) => ({
        ...channel,
        customerCheckout: policySlot(
          policyRows,
          channel.id,
          "customer_checkout",
        ),
        vendorFulfillmentCharge: policySlot(
          policyRows,
          channel.id,
          "vendor_fulfillment_charge",
        ),
      })),
      destinationScopes,
      rateBooks,
      warehouses: warehouseRows.map((warehouse) => ({
        ...warehouse,
        isActive: warehouse.isActive === 1,
      })),
    };
  }

  async getPolicy(policyId: number): Promise<ShippingChannelPolicyView | null> {
    return loadPolicy(db, policyId);
  }

  async getChannel(channelId: number) {
    const [channel] = await db
      .select({
        id: channels.id,
        name: channels.name,
        provider: channels.provider,
      })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    return channel ?? null;
  }

  async transaction<T>(
    work: (tx: ChannelShippingPolicyAdminTransaction) => Promise<T>,
  ): Promise<T> {
    return db.transaction((tx) => work(
      new PostgresChannelShippingPolicyAdminTransaction(tx),
    ));
  }

  async resolveLegacyRateBook(
    context: ShippingRateContext,
    originWarehouseId: number,
  ): Promise<
    | { ok: true; rateBookId: number }
    | { ok: false; code: string; message: string }
  > {
    const candidates = await loadActiveRateBookAssignments(
      context,
      originWarehouseId,
    );
    const selection = selectRateBookAssignment(candidates, {
      ...context,
      originWarehouseId,
    });
    if (!selection.ok) return selection;
    return { ok: true, rateBookId: selection.assignment.rateBookId };
  }

  async persistShadowComparison(
    input: Parameters<
      ChannelShippingPolicyAdminStore["persistShadowComparison"]
    >[0],
  ): Promise<number> {
    const [created] = await db
      .insert(shippingQuoteSnapshots)
      .values({
        source: "shadow",
        destinationCountry: input.resolutionInput.destination.country
          .trim()
          .toUpperCase(),
        destinationPostalCode:
          input.resolutionInput.destination.postalCode?.trim().toUpperCase()
          || null,
        requestPayload: {
          kind: "channel_policy_decision",
          channelId: input.policy.channelId,
          purpose: input.policy.purpose,
          policyId: input.policy.id,
          policyVersion: input.policy.version,
          originWarehouseId: input.resolutionInput.originWarehouseId,
          destination: input.resolutionInput.destination,
          legacyProfile: input.legacyProfile,
        },
        rates: {
          canonical: input.canonical,
          legacy: input.legacy,
        },
        metadata: {
          actor: input.actor,
          matchesLegacy: input.matchesLegacy,
          differences: input.differences,
        },
        createdAt: input.now,
      })
      .returning({ id: shippingQuoteSnapshots.id });
    return created.id;
  }
}

class PostgresChannelShippingPolicyAdminTransaction
implements ChannelShippingPolicyAdminTransaction {
  constructor(private readonly tx: Transaction) {}

  async getChannelForUpdate(channelId: number) {
    await this.tx.execute(sql`
      SELECT id
      FROM channels.channels
      WHERE id = ${channelId}
      FOR UPDATE
    `);
    const [channel] = await this.tx
      .select({
        id: channels.id,
        name: channels.name,
        provider: channels.provider,
      })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    return channel ?? null;
  }

  async getPolicyForUpdate(
    policyId: number,
  ): Promise<ShippingChannelPolicyView | null> {
    const [candidate] = await this.tx
      .select({ channelId: shippingChannelPolicies.channelId })
      .from(shippingChannelPolicies)
      .where(eq(shippingChannelPolicies.id, policyId))
      .limit(1);
    if (!candidate) return null;

    // Every policy command locks the owning channel before the policy row.
    // Draft creation uses the same order, preventing create/save/activate
    // deadlocks while the partial unique indexes enforce slot cardinality.
    await this.tx.execute(sql`
      SELECT id
      FROM channels.channels
      WHERE id = ${candidate.channelId}
      FOR UPDATE
    `);
    await this.tx.execute(sql`
      SELECT id
      FROM shipping.channel_policies
      WHERE id = ${policyId}
      FOR UPDATE
    `);
    return loadPolicy(this.tx, policyId);
  }

  async findDraftPolicy(
    channelId: number,
    purpose: ShippingChannelPolicyPurpose,
  ): Promise<ShippingChannelPolicyView | null> {
    return findPolicy(this.tx, channelId, purpose, "draft");
  }

  async findActivePolicy(
    channelId: number,
    purpose: ShippingChannelPolicyPurpose,
  ): Promise<ShippingChannelPolicyView | null> {
    return findPolicy(this.tx, channelId, purpose, "active");
  }

  async nextPolicyVersion(
    channelId: number,
    purpose: ShippingChannelPolicyPurpose,
  ): Promise<number> {
    const [row] = await this.tx
      .select({
        version: sql<number>`
          COALESCE(MAX(${shippingChannelPolicies.version}), 0)::int + 1
        `,
      })
      .from(shippingChannelPolicies)
      .where(and(
        eq(shippingChannelPolicies.channelId, channelId),
        eq(shippingChannelPolicies.purpose, purpose),
      ));
    return row.version;
  }

  async insertPolicyDraft(input: {
    channelId: number;
    purpose: ShippingChannelPolicyPurpose;
    version: number;
    notes: string | null;
    actor: string;
    now: Date;
  }): Promise<number> {
    const [created] = await this.tx
      .insert(shippingChannelPolicies)
      .values({
        channelId: input.channelId,
        purpose: input.purpose,
        version: input.version,
        status: "draft",
        metadata: metadataWithNotes(input.notes),
        createdBy: input.actor,
        lockVersion: 1,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning({ id: shippingChannelPolicies.id });
    return created.id;
  }

  async replacePolicyRoutes(
    policyId: number,
    routes: readonly PreparedPolicyRoute[],
    now: Date,
  ): Promise<void> {
    await this.tx
      .delete(shippingChannelPolicyRoutes)
      .where(eq(shippingChannelPolicyRoutes.policyId, policyId));

    for (const route of routes) {
      const [created] = await this.tx
        .insert(shippingChannelPolicyRoutes)
        .values({
          policyId,
          sourceDestinationScopeId: route.destinationScopeId,
          originWarehouseId: route.originWarehouseId,
          mode: route.mode,
          eligibilityMode: route.eligibilityMode,
          rateBookId: route.rateBookId,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: shippingChannelPolicyRoutes.id });
      if (route.destinationMembers.length > 0) {
        await this.tx
          .insert(shippingChannelPolicyRouteDestinations)
          .values(route.destinationMembers.map((member) => ({
            routeId: created.id,
            destinationCountry: member.country,
            destinationRegion: member.region,
            postalPrefix: member.postalPrefix,
            createdAt: now,
          })));
      }
    }
  }

  async updatePolicyDraft(input: {
    policyId: number;
    expectedLockVersion: number;
    notes: string | null;
    now: Date;
  }): Promise<boolean> {
    const updated = await this.tx
      .update(shippingChannelPolicies)
      .set({
        metadata: metadataWithNotes(input.notes),
        lockVersion: sql`${shippingChannelPolicies.lockVersion} + 1`,
        updatedAt: input.now,
      })
      .where(and(
        eq(shippingChannelPolicies.id, input.policyId),
        eq(shippingChannelPolicies.status, "draft"),
        eq(shippingChannelPolicies.lockVersion, input.expectedLockVersion),
      ))
      .returning({ id: shippingChannelPolicies.id });
    return updated.length === 1;
  }

  async activatePolicy(input: {
    policyId: number;
    expectedLockVersion: number;
    actor: string;
    now: Date;
  }): Promise<boolean> {
    const updated = await this.tx
      .update(shippingChannelPolicies)
      .set({
        status: "active",
        activatedBy: input.actor,
        activatedAt: input.now,
        lockVersion: sql`${shippingChannelPolicies.lockVersion} + 1`,
        updatedAt: input.now,
      })
      .where(and(
        eq(shippingChannelPolicies.id, input.policyId),
        eq(shippingChannelPolicies.status, "draft"),
        eq(shippingChannelPolicies.lockVersion, input.expectedLockVersion),
      ))
      .returning({ id: shippingChannelPolicies.id });
    return updated.length === 1;
  }

  async retirePolicy(input: {
    policyId: number;
    expectedLockVersion: number;
    now: Date;
  }): Promise<boolean> {
    const updated = await this.tx
      .update(shippingChannelPolicies)
      .set({
        status: "retired",
        retiredAt: input.now,
        lockVersion: sql`${shippingChannelPolicies.lockVersion} + 1`,
        updatedAt: input.now,
      })
      .where(and(
        eq(shippingChannelPolicies.id, input.policyId),
        eq(shippingChannelPolicies.status, "active"),
        eq(shippingChannelPolicies.lockVersion, input.expectedLockVersion),
      ))
      .returning({ id: shippingChannelPolicies.id });
    return updated.length === 1;
  }

  async discardPolicyDraft(input: {
    policyId: number;
    expectedLockVersion: number;
    now: Date;
  }): Promise<boolean> {
    const updated = await this.tx
      .update(shippingChannelPolicies)
      .set({
        status: "retired",
        retiredAt: input.now,
        lockVersion: sql`${shippingChannelPolicies.lockVersion} + 1`,
        updatedAt: input.now,
      })
      .where(and(
        eq(shippingChannelPolicies.id, input.policyId),
        eq(shippingChannelPolicies.status, "draft"),
        eq(shippingChannelPolicies.lockVersion, input.expectedLockVersion),
      ))
      .returning({ id: shippingChannelPolicies.id });
    return updated.length === 1;
  }

  async getDestinationScopesByIds(
    ids: readonly number[],
  ): Promise<ShippingDestinationScopeSummary[]> {
    return loadDestinationScopes(this.tx, ids);
  }

  async getRateBooksByIds(ids: readonly number[]) {
    if (ids.length === 0) return [];
    const rows = await loadRateBookOptions(this.tx, ids);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      activeRateTableCount: row.activeRateTableCount,
    }));
  }

  async getWarehousesByIds(ids: readonly number[]) {
    if (ids.length === 0) return [];
    const rows = await this.tx
      .select({
        id: warehouses.id,
        name: warehouses.name,
        isActive: warehouses.isActive,
      })
      .from(warehouses)
      .where(inArray(warehouses.id, [...ids]));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      isActive: row.isActive === 1,
    }));
  }

  async insertDestinationScope(input: {
    code: string;
    name: string;
    members: ShippingDestinationScopeMember[];
    actor: string;
    now: Date;
  }): Promise<number> {
    const [created] = await this.tx
      .insert(shippingDestinationScopes)
      .values({
        code: input.code,
        name: input.name,
        status: "active",
        createdBy: input.actor,
        lockVersion: 1,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning({ id: shippingDestinationScopes.id });
    await this.replaceDestinationMembers(created.id, input.members, input.now);
    return created.id;
  }

  async getDestinationScopeForUpdate(
    scopeId: number,
  ): Promise<ShippingDestinationScopeSummary | null> {
    await this.tx.execute(sql`
      SELECT id
      FROM shipping.destination_scopes
      WHERE id = ${scopeId}
      FOR UPDATE
    `);
    return loadDestinationScope(this.tx, scopeId);
  }

  async updateDestinationScope(input: {
    scopeId: number;
    expectedLockVersion: number;
    code: string;
    name: string;
    members: ShippingDestinationScopeMember[];
    now: Date;
  }): Promise<boolean> {
    const updated = await this.tx
      .update(shippingDestinationScopes)
      .set({
        code: input.code,
        name: input.name,
        lockVersion: sql`${shippingDestinationScopes.lockVersion} + 1`,
        updatedAt: input.now,
      })
      .where(and(
        eq(shippingDestinationScopes.id, input.scopeId),
        eq(shippingDestinationScopes.lockVersion, input.expectedLockVersion),
        or(
          eq(shippingDestinationScopes.status, "active"),
          eq(shippingDestinationScopes.status, "draft"),
        ),
      ))
      .returning({ id: shippingDestinationScopes.id });
    if (updated.length !== 1) return false;
    await this.replaceDestinationMembers(
      input.scopeId,
      input.members,
      input.now,
    );
    return true;
  }

  async retireDestinationScope(input: {
    scopeId: number;
    expectedLockVersion: number;
    now: Date;
  }): Promise<boolean> {
    const updated = await this.tx
      .update(shippingDestinationScopes)
      .set({
        status: "retired",
        lockVersion: sql`${shippingDestinationScopes.lockVersion} + 1`,
        updatedAt: input.now,
      })
      .where(and(
        eq(shippingDestinationScopes.id, input.scopeId),
        eq(shippingDestinationScopes.lockVersion, input.expectedLockVersion),
        or(
          eq(shippingDestinationScopes.status, "active"),
          eq(shippingDestinationScopes.status, "draft"),
        ),
      ))
      .returning({ id: shippingDestinationScopes.id });
    return updated.length === 1;
  }

  async persistAudit(payload: AuditLogPayload, now: Date): Promise<void> {
    await persistAuditEvent(this.tx, payload, {
      timestamp: now,
      emitStructuredLog: false,
    });
  }

  private async replaceDestinationMembers(
    scopeId: number,
    members: readonly ShippingDestinationScopeMember[],
    now: Date,
  ): Promise<void> {
    await this.tx
      .delete(shippingDestinationScopeMembers)
      .where(eq(shippingDestinationScopeMembers.destinationScopeId, scopeId));
    await this.tx
      .insert(shippingDestinationScopeMembers)
      .values(members.map((member) => ({
        destinationScopeId: scopeId,
        destinationCountry: member.country,
        destinationRegion: member.region,
        postalPrefix: member.postalPrefix,
        createdAt: now,
      })));
  }
}

async function findPolicy(
  executor: Executor,
  channelId: number,
  purpose: ShippingChannelPolicyPurpose,
  status: Extract<ShippingChannelPolicyStatus, "draft" | "active">,
): Promise<ShippingChannelPolicyView | null> {
  const [row] = await executor
    .select({ id: shippingChannelPolicies.id })
    .from(shippingChannelPolicies)
    .where(and(
      eq(shippingChannelPolicies.channelId, channelId),
      eq(shippingChannelPolicies.purpose, purpose),
      eq(shippingChannelPolicies.status, status),
    ))
    .limit(1);
  return row ? loadPolicy(executor, row.id) : null;
}

async function loadPolicy(
  executor: Executor,
  policyId: number,
): Promise<ShippingChannelPolicyView | null> {
  const [policy] = await executor
    .select()
    .from(shippingChannelPolicies)
    .where(eq(shippingChannelPolicies.id, policyId))
    .limit(1);
  if (!policy) return null;

  const routeRows = await executor
    .select({
      id: shippingChannelPolicyRoutes.id,
      originWarehouseId: shippingChannelPolicyRoutes.originWarehouseId,
      originWarehouseName: warehouses.name,
      originWarehouseActive: warehouses.isActive,
      destinationScopeId:
        shippingChannelPolicyRoutes.sourceDestinationScopeId,
      destinationScopeName: shippingDestinationScopes.name,
      destinationScopeStatus: shippingDestinationScopes.status,
      mode: shippingChannelPolicyRoutes.mode,
      eligibilityMode: shippingChannelPolicyRoutes.eligibilityMode,
      rateBookId: shippingChannelPolicyRoutes.rateBookId,
      rateBookName: shippingRateBooks.name,
      rateBookStatus: shippingRateBooks.status,
      activeRateTableCount: sql<number>`
        (
          SELECT COUNT(*)::int
          FROM shipping.rate_tables active_table
          WHERE active_table.rate_book_id = ${shippingChannelPolicyRoutes.rateBookId}
            AND active_table.status = 'active'
            AND active_table.effective_from <= CURRENT_TIMESTAMP
            AND (
              active_table.effective_to IS NULL
              OR active_table.effective_to > CURRENT_TIMESTAMP
            )
        )
      `,
    })
    .from(shippingChannelPolicyRoutes)
    .leftJoin(
      warehouses,
      eq(warehouses.id, shippingChannelPolicyRoutes.originWarehouseId),
    )
    .leftJoin(
      shippingDestinationScopes,
      eq(
        shippingDestinationScopes.id,
        shippingChannelPolicyRoutes.sourceDestinationScopeId,
      ),
    )
    .leftJoin(
      shippingRateBooks,
      eq(shippingRateBooks.id, shippingChannelPolicyRoutes.rateBookId),
    )
    .where(eq(shippingChannelPolicyRoutes.policyId, policyId))
    .orderBy(asc(shippingChannelPolicyRoutes.id));
  const routeIds = routeRows.map((route) => route.id);
  const destinationRows = routeIds.length === 0
    ? []
    : await executor
        .select({
          routeId: shippingChannelPolicyRouteDestinations.routeId,
          country:
            shippingChannelPolicyRouteDestinations.destinationCountry,
          region: shippingChannelPolicyRouteDestinations.destinationRegion,
          postalPrefix:
            shippingChannelPolicyRouteDestinations.postalPrefix,
        })
        .from(shippingChannelPolicyRouteDestinations)
        .where(inArray(
          shippingChannelPolicyRouteDestinations.routeId,
          routeIds,
        ))
        .orderBy(
          asc(shippingChannelPolicyRouteDestinations.routeId),
          asc(shippingChannelPolicyRouteDestinations.destinationCountry),
          asc(shippingChannelPolicyRouteDestinations.destinationRegion),
          asc(shippingChannelPolicyRouteDestinations.postalPrefix),
        );
  const destinationsByRoute = groupDestinations(destinationRows);

  return {
    id: policy.id,
    channelId: policy.channelId,
    purpose: policy.purpose,
    version: policy.version,
    status: policy.status,
    lockVersion: policy.lockVersion,
    notes: metadataNotes(policy.metadata),
    createdBy: policy.createdBy,
    activatedBy: policy.activatedBy,
    activatedAt: isoDate(policy.activatedAt),
    retiredAt: isoDate(policy.retiredAt),
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
    routes: routeRows.map((route) => ({
      ...route,
      destinationMembers: destinationsByRoute.get(route.id) ?? [],
      originWarehouseActive: route.originWarehouseActive === null
        ? null
        : route.originWarehouseActive === 1,
      rateBookStatus: normalizeRateBookStatus(route.rateBookStatus),
    })),
    activationErrors: [],
  };
}

async function loadDestinationScopes(
  executor: Executor,
  ids?: readonly number[],
): Promise<ShippingDestinationScopeSummary[]> {
  if (ids && ids.length === 0) return [];
  const rows = await executor
    .select({
      id: shippingDestinationScopes.id,
      code: shippingDestinationScopes.code,
      name: shippingDestinationScopes.name,
      status: shippingDestinationScopes.status,
      lockVersion: shippingDestinationScopes.lockVersion,
      updatedAt: shippingDestinationScopes.updatedAt,
    })
    .from(shippingDestinationScopes)
    .where(ids ? inArray(shippingDestinationScopes.id, [...ids]) : undefined)
    .orderBy(asc(shippingDestinationScopes.name), asc(shippingDestinationScopes.id));
  if (rows.length === 0) return [];

  const members = await executor
    .select({
      destinationScopeId:
        shippingDestinationScopeMembers.destinationScopeId,
      country: shippingDestinationScopeMembers.destinationCountry,
      region: shippingDestinationScopeMembers.destinationRegion,
      postalPrefix: shippingDestinationScopeMembers.postalPrefix,
    })
    .from(shippingDestinationScopeMembers)
    .where(inArray(
      shippingDestinationScopeMembers.destinationScopeId,
      rows.map((row) => row.id),
    ))
    .orderBy(
      asc(shippingDestinationScopeMembers.destinationScopeId),
      asc(shippingDestinationScopeMembers.destinationCountry),
      asc(shippingDestinationScopeMembers.destinationRegion),
      asc(shippingDestinationScopeMembers.postalPrefix),
    );
  const membersByScope = new Map<number, ShippingDestinationScopeMember[]>();
  for (const member of members) {
    const list = membersByScope.get(member.destinationScopeId) ?? [];
    list.push({
      country: member.country,
      region: member.region,
      postalPrefix: member.postalPrefix,
    });
    membersByScope.set(member.destinationScopeId, list);
  }
  return rows.map((row) => ({
    ...row,
    members: membersByScope.get(row.id) ?? [],
    updatedAt: row.updatedAt.toISOString(),
  }));
}

async function loadDestinationScope(
  executor: Executor,
  scopeId: number,
): Promise<ShippingDestinationScopeSummary | null> {
  const scopes = await loadDestinationScopes(executor, [scopeId]);
  return scopes[0] ?? null;
}

async function loadRateBookOptions(
  executor: Executor,
  ids?: readonly number[],
) {
  if (ids && ids.length === 0) return [];
  const tableCounts = await executor
    .select({
      rateBookId: shippingRateTables.rateBookId,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(shippingRateTables)
    .where(and(
      eq(shippingRateTables.status, "active"),
      sql`${shippingRateTables.effectiveFrom} <= CURRENT_TIMESTAMP`,
      sql`(
        ${shippingRateTables.effectiveTo} IS NULL
        OR ${shippingRateTables.effectiveTo} > CURRENT_TIMESTAMP
      )`,
      ids ? inArray(shippingRateTables.rateBookId, [...ids]) : undefined,
    ))
    .groupBy(shippingRateTables.rateBookId);
  const countByBook = new Map(
    tableCounts.map((row) => [row.rateBookId, row.count]),
  );
  const books = await executor
    .select({
      id: shippingRateBooks.id,
      code: shippingRateBooks.code,
      name: shippingRateBooks.name,
      status: shippingRateBooks.status,
    })
    .from(shippingRateBooks)
    .where(ids ? inArray(shippingRateBooks.id, [...ids]) : undefined)
    .orderBy(asc(shippingRateBooks.name), asc(shippingRateBooks.id));
  return books.map((book) => ({
    ...book,
    activeRateTableCount: countByBook.get(book.id) ?? 0,
  }));
}

function policySlot(
  policies: readonly {
    id: number;
    channelId: number;
    purpose: ShippingChannelPolicyPurpose;
    version: number;
    status: ShippingChannelPolicyStatus;
    lockVersion: number;
    activatedAt: Date | null;
    updatedAt: Date;
  }[],
  channelId: number,
  purpose: ShippingChannelPolicyPurpose,
) {
  const matching = policies.filter((policy) =>
    policy.channelId === channelId && policy.purpose === purpose);
  const active = matching.find((policy) => policy.status === "active");
  const draft = matching.find((policy) => policy.status === "draft");
  return {
    active: active
      ? {
          id: active.id,
          version: active.version,
          lockVersion: active.lockVersion,
          activatedAt: active.activatedAt?.toISOString() ?? "",
        }
      : null,
    draft: draft
      ? {
          id: draft.id,
          version: draft.version,
          lockVersion: draft.lockVersion,
          updatedAt: draft.updatedAt.toISOString(),
        }
      : null,
  };
}

function groupDestinations(
  rows: readonly {
    routeId: number;
    country: string;
    region: string | null;
    postalPrefix: string | null;
  }[],
): Map<number, ShippingDestinationScopeMember[]> {
  const result = new Map<number, ShippingDestinationScopeMember[]>();
  for (const row of rows) {
    const destinations = result.get(row.routeId) ?? [];
    destinations.push({
      country: row.country,
      region: row.region,
      postalPrefix: row.postalPrefix,
    });
    result.set(row.routeId, destinations);
  }
  return result;
}

function metadataWithNotes(notes: string | null): Record<string, string> {
  return notes === null ? {} : { notes };
}

function metadataNotes(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const notes = (metadata as PolicyMetadata).notes;
  return typeof notes === "string" ? notes : null;
}

function normalizeRateBookStatus(
  status: string | null,
): "draft" | "active" | "retired" | null {
  return status === "draft" || status === "active" || status === "retired"
    ? status
    : status === null
      ? null
      : "retired";
}

function isoDate(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}
