import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  channels,
  dropshipStoreConnections,
  dropshipVendors,
  returnPolicies,
  returnPolicyCommands,
  type ReturnPolicy,
} from "@shared/schema";
import { db } from "../../../db";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import {
  ReturnPolicyAdminError,
  type PublicReturnPolicyScopeInput,
  type ReturnPolicyAdminStore,
  type ReturnPolicyAdminTransaction,
  type ReturnPolicyChannelReference,
  type ReturnPolicyCommandRecord,
  type ReturnPolicyOverview,
  type ReturnPolicyStoreReference,
  type ReturnPolicyVendorReference,
  type ScopeReferences,
} from "../application/return-policy-admin.service";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type QueryExecutor = typeof db | Transaction;

export class PostgresReturnPolicyAdminStore implements ReturnPolicyAdminStore {
  async listOverview(): Promise<ReturnPolicyOverview> {
    const [policies, channelRows, dropshipOmsChannel] = await Promise.all([
      db.select().from(returnPolicies).orderBy(asc(returnPolicies.scopeKey), desc(returnPolicies.version)),
      db.select(channelSelection).from(channels).orderBy(asc(channels.name)),
      loadDropshipOmsChannel(db),
    ]);
    const vendorIds = uniqueIds(policies.map((policy) => policy.vendorId));
    const storeIds = uniqueIds(policies.map((policy) => policy.storeConnectionId));
    const [referencedVendors, referencedStores] = await Promise.all([
      vendorIds.length === 0
        ? Promise.resolve([])
        : db.select(vendorSelection).from(dropshipVendors).where(inArray(dropshipVendors.id, vendorIds)).orderBy(asc(dropshipVendors.businessName), asc(dropshipVendors.email)),
      storeIds.length === 0
        ? Promise.resolve([])
        : db.select(storeSelection).from(dropshipStoreConnections).where(inArray(dropshipStoreConnections.id, storeIds)).orderBy(asc(dropshipStoreConnections.externalDisplayName), asc(dropshipStoreConnections.id)),
    ]);
    return {
      policies,
      channels: channelRows,
      referencedVendors,
      referencedStores,
      dropshipOmsChannelId: dropshipOmsChannel.id,
    };
  }

  listActivePolicies(): Promise<ReturnPolicy[]> {
    return db.select().from(returnPolicies).where(eq(returnPolicies.status, "active"));
  }

  getDropshipOmsChannel(): Promise<ReturnPolicyChannelReference> {
    return loadDropshipOmsChannel(db);
  }

  searchVendors(search: string, limit: number): Promise<ReturnPolicyVendorReference[]> {
    const pattern = `%${search}%`;
    return db.select(vendorSelection)
      .from(dropshipVendors)
      .where(search ? or(
        ilike(dropshipVendors.businessName, pattern),
        ilike(dropshipVendors.email, pattern),
        ilike(dropshipVendors.memberId, pattern),
      ) : undefined)
      .orderBy(asc(dropshipVendors.businessName), asc(dropshipVendors.email), asc(dropshipVendors.id))
      .limit(limit);
  }

  searchStores(vendorId: number, search: string, limit: number): Promise<ReturnPolicyStoreReference[]> {
    const pattern = `%${search}%`;
    return db.select(storeSelection)
      .from(dropshipStoreConnections)
      .where(and(
        eq(dropshipStoreConnections.vendorId, vendorId),
        search ? or(
          ilike(dropshipStoreConnections.externalDisplayName, pattern),
          ilike(dropshipStoreConnections.shopDomain, pattern),
          ilike(dropshipStoreConnections.platform, pattern),
        ) : undefined,
      ))
      .orderBy(asc(dropshipStoreConnections.externalDisplayName), asc(dropshipStoreConnections.id))
      .limit(limit);
  }

  transaction<T>(work: (tx: ReturnPolicyAdminTransaction) => Promise<T>): Promise<T> {
    return db.transaction((tx) => work(new PostgresReturnPolicyAdminTransaction(tx)));
  }
}

class PostgresReturnPolicyAdminTransaction implements ReturnPolicyAdminTransaction {
  constructor(private readonly tx: Transaction) {}

  async lockCommand(idempotencyKey: string): Promise<void> {
    await this.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`return-policy-command:${idempotencyKey}`}))`);
  }

  async findCommand(idempotencyKey: string): Promise<ReturnPolicyCommandRecord | null> {
    const [row] = await this.tx
      .select({ requestHash: returnPolicyCommands.requestHash, response: returnPolicyCommands.response })
      .from(returnPolicyCommands)
      .where(eq(returnPolicyCommands.idempotencyKey, idempotencyKey))
      .limit(1);
    if (!row) return null;
    return { requestHash: row.requestHash, response: hydratePolicy(row.response) };
  }

  async getScopeReferences(scope: PublicReturnPolicyScopeInput): Promise<ScopeReferences> {
    const [channel, vendor, store, dropshipOmsChannel] = await Promise.all([
      scope.channelId === null
        ? Promise.resolve(null)
        : this.tx.select(channelSelection).from(channels).where(eq(channels.id, scope.channelId)).limit(1).then((rows) => rows[0] ?? null),
      scope.vendorId === null
        ? Promise.resolve(null)
        : this.tx.select(vendorSelection).from(dropshipVendors).where(eq(dropshipVendors.id, scope.vendorId)).limit(1).then((rows) => rows[0] ?? null),
      scope.storeConnectionId === null
        ? Promise.resolve(null)
        : this.tx.select(storeSelection).from(dropshipStoreConnections).where(eq(dropshipStoreConnections.id, scope.storeConnectionId)).limit(1).then((rows) => rows[0] ?? null),
      loadDropshipOmsChannel(this.tx),
    ]);
    return { channel, vendor, store, dropshipOmsChannel };
  }

  async getActivePolicyForUpdate(scopeKey: string): Promise<ReturnPolicy | null> {
    await this.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`return-policy-scope:${scopeKey}`}))`);
    const [policy] = await this.tx.select().from(returnPolicies)
      .where(sql`${returnPolicies.scopeKey} = ${scopeKey} AND ${returnPolicies.status} = 'active'`)
      .limit(1);
    if (!policy) return null;
    await this.tx.execute(sql`SELECT id FROM returns.return_policies WHERE id = ${policy.id} FOR UPDATE`);
    return policy;
  }

  async getNextVersion(scopeKey: string): Promise<number> {
    const [row] = await this.tx.select({ version: sql<number>`COALESCE(MAX(${returnPolicies.version}), 0)` })
      .from(returnPolicies)
      .where(eq(returnPolicies.scopeKey, scopeKey));
    return Number(row?.version ?? 0) + 1;
  }

  async retirePolicy(policy: ReturnPolicy, actor: string, now: Date): Promise<void> {
    await this.tx.update(returnPolicies).set({ status: "retired", retiredBy: actor, retiredAt: now }).where(eq(returnPolicies.id, policy.id));
  }

  async insertPolicy(input: Omit<ReturnPolicy, "id" | "createdAt">): Promise<ReturnPolicy> {
    const [created] = await this.tx.insert(returnPolicies).values(input).returning();
    if (!created) throw new Error("Return policy insert did not return a row.");
    return created;
  }

  async recordCommand(input: { idempotencyKey: string; requestHash: string; response: ReturnPolicy; actor: string; createdAt: Date }): Promise<void> {
    await this.tx.insert(returnPolicyCommands).values(input);
  }

  async writeAudit(input: { actor: string; before: ReturnPolicy | null; after: ReturnPolicy; now: Date }): Promise<void> {
    await persistAuditEvent(this.tx, {
      actor: input.actor,
      action: "RETURN_POLICY_VERSION_CREATED",
      target: `returns.return_policies:${input.after.id}`,
      changes: {
        before: input.before ? auditRecord(input.before) : null,
        after: auditRecord(input.after),
      },
      context: {
        scopeKey: input.after.scopeKey,
        version: input.after.version,
        supersedesPolicyId: input.after.supersedesPolicyId,
      },
    }, { timestamp: input.now });
  }
}

const channelSelection = {
  id: channels.id,
  name: channels.name,
  type: channels.type,
  provider: channels.provider,
  status: channels.status,
};

const vendorSelection = {
  id: dropshipVendors.id,
  memberId: dropshipVendors.memberId,
  businessName: dropshipVendors.businessName,
  email: dropshipVendors.email,
  status: dropshipVendors.status,
};

const storeSelection = {
  id: dropshipStoreConnections.id,
  vendorId: dropshipStoreConnections.vendorId,
  platform: dropshipStoreConnections.platform,
  displayName: dropshipStoreConnections.externalDisplayName,
  shopDomain: dropshipStoreConnections.shopDomain,
  status: dropshipStoreConnections.status,
};

async function loadDropshipOmsChannel(executor: QueryExecutor): Promise<ReturnPolicyChannelReference> {
  const rows = await executor.select(channelSelection)
    .from(channels)
    .where(and(
      eq(channels.name, "Dropship OMS"),
      eq(channels.type, "internal"),
      eq(channels.provider, "manual"),
      eq(channels.status, "active"),
    ))
    .limit(2);
  if (rows.length === 0) {
    throw new ReturnPolicyAdminError(
      "RETURN_POLICY_DROPSHIP_CHANNEL_NOT_CONFIGURED",
      "The canonical Dropship OMS channel is not configured.",
      500,
    );
  }
  if (rows.length > 1) {
    throw new ReturnPolicyAdminError(
      "RETURN_POLICY_DROPSHIP_CHANNEL_AMBIGUOUS",
      "More than one canonical Dropship OMS channel is configured.",
      500,
    );
  }
  return rows[0];
}

function uniqueIds(values: Array<number | null>): number[] {
  return [...new Set(values.filter((value): value is number => value !== null))];
}

function auditRecord(policy: ReturnPolicy): Record<string, unknown> {
  return {
    id: policy.id,
    name: policy.name,
    scopeKey: policy.scopeKey,
    version: policy.version,
    status: policy.status,
    returnWindowDays: policy.returnWindowDays,
    returnDestination: policy.returnDestination,
    approvalAuthority: policy.approvalAuthority,
    labelProvider: policy.labelProvider,
    returnShippingPayer: policy.returnShippingPayer,
    inspectionRequirement: policy.inspectionRequirement,
    inspectionOwner: policy.inspectionOwner,
    customerRefundAuthority: policy.customerRefundAuthority,
    vendorSettlementTrigger: policy.vendorSettlementTrigger,
    returnlessRefundAllowed: policy.returnlessRefundAllowed,
  };
}

function hydratePolicy(value: unknown): ReturnPolicy {
  if (!value || typeof value !== "object") throw new Error("Stored return policy command response is invalid.");
  const policy = value as ReturnPolicy;
  return {
    ...policy,
    createdAt: policy.createdAt instanceof Date ? policy.createdAt : new Date(String(policy.createdAt)),
    retiredAt: policy.retiredAt === null
      ? null
      : policy.retiredAt instanceof Date
        ? policy.retiredAt
        : new Date(String(policy.retiredAt)),
  };
}
