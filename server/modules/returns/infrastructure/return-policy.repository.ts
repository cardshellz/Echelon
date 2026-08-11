import { asc, desc, eq, sql } from "drizzle-orm";
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
import type {
  ReturnPolicyAdminStore,
  ReturnPolicyAdminTransaction,
  ReturnPolicyCommandRecord,
  ReturnPolicyOverview,
  ScopeReferences,
} from "../application/return-policy-admin.service";
import type { ReturnPolicyScopeInput } from "../domain/return-policy";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class PostgresReturnPolicyAdminStore implements ReturnPolicyAdminStore {
  async listOverview(): Promise<ReturnPolicyOverview> {
    const [policies, channelRows, vendorRows, storeRows] = await Promise.all([
      db.select().from(returnPolicies).orderBy(asc(returnPolicies.scopeKey), desc(returnPolicies.version)),
      db.select({ id: channels.id, name: channels.name, provider: channels.provider, status: channels.status }).from(channels).orderBy(asc(channels.name)),
      db.select({ id: dropshipVendors.id, memberId: dropshipVendors.memberId, businessName: dropshipVendors.businessName }).from(dropshipVendors).orderBy(asc(dropshipVendors.memberId)),
      db.select({ id: dropshipStoreConnections.id, vendorId: dropshipStoreConnections.vendorId, platform: dropshipStoreConnections.platform, displayName: dropshipStoreConnections.externalDisplayName }).from(dropshipStoreConnections).orderBy(asc(dropshipStoreConnections.externalDisplayName), asc(dropshipStoreConnections.id)),
    ]);
    return { policies, channels: channelRows, vendors: vendorRows, stores: storeRows };
  }

  listActivePolicies(): Promise<ReturnPolicy[]> {
    return db.select().from(returnPolicies).where(eq(returnPolicies.status, "active"));
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

  async getScopeReferences(scope: ReturnPolicyScopeInput): Promise<ScopeReferences> {
    const [channel, vendor, store] = await Promise.all([
      scope.channelId === null
        ? Promise.resolve(null)
        : this.tx.select({ id: channels.id, name: channels.name, provider: channels.provider }).from(channels).where(eq(channels.id, scope.channelId)).limit(1).then((rows) => rows[0] ?? null),
      scope.vendorId === null
        ? Promise.resolve(null)
        : this.tx.select({ id: dropshipVendors.id, memberId: dropshipVendors.memberId }).from(dropshipVendors).where(eq(dropshipVendors.id, scope.vendorId)).limit(1).then((rows) => rows[0] ?? null),
      scope.storeConnectionId === null
        ? Promise.resolve(null)
        : this.tx.select({ id: dropshipStoreConnections.id, vendorId: dropshipStoreConnections.vendorId, platform: dropshipStoreConnections.platform }).from(dropshipStoreConnections).where(eq(dropshipStoreConnections.id, scope.storeConnectionId)).limit(1).then((rows) => rows[0] ?? null),
    ]);
    return { channel, vendor, store };
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
