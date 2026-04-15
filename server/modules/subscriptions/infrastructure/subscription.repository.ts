// subscription.storage.ts — Database operations for subscriptions
import { pool } from "../../../db";
import type {
  SubscriptionRecord,
  PlanRecord,
  BillingLogRecord,
  SubscriptionEvent,
  SubscriptionDashboardStats,
} from "../subscription.types";

// ─── Plans ───────────────────────────────────────────────────────────

export async function getAllPlans(): Promise<PlanRecord[]> {
  const result = await pool.query(
    `SELECT id, name, tier, billing_interval, billing_interval_count,
            price_cents, shopify_selling_plan_gid, includes_dropship, is_active, priority_modifier
     FROM membership.plans ORDER BY id`
  );
  return result.rows;
}

export async function getActivePlans(): Promise<PlanRecord[]> {
  const result = await pool.query(
    `SELECT id, name, tier, billing_interval, billing_interval_count,
            price_cents, shopify_selling_plan_gid, includes_dropship, is_active, priority_modifier
     FROM membership.plans WHERE is_active = true ORDER BY id`
  );
  return result.rows;
}

export async function updatePlanSellingPlan(
  planId: number,
  shopifySellingPlanGid: string,
  shopifySellingPlanId: number,
  client: any = pool
): Promise<void> {
  await client.query(
    `UPDATE membership.plans SET shopify_selling_plan_gid = $1, shopify_selling_plan_id = $2 WHERE id = $3`,
    [shopifySellingPlanGid, shopifySellingPlanId, planId]
  );
}

export async function updatePlanDetails(
  planId: number,
  updates: Partial<{
    name: string;
    tier: string;
    billing_interval: string;
    billing_interval_count: number;
    price_cents: number;
    includes_dropship: boolean;
    is_active: boolean;
    priority_modifier: number;
  }>
): Promise<void> {
  const setClauses: string[] = [];
  const values: any[] = [];
  let idx = 1;

  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) {
      setClauses.push(`${key} = $${idx++}`);
      values.push(val);
    }
  }
  if (setClauses.length === 0) return;

  values.push(planId);
  await pool.query(
    `UPDATE membership.plans SET ${setClauses.join(", ")} WHERE id = $${idx}`,
    values
  );
}

export async function getPlanBySellingPlanGid(gid: string): Promise<PlanRecord | null> {
  const result = await pool.query(
    `SELECT p.* FROM membership.plans p
     JOIN membership.selling_plan_map spm ON spm.plan_id = p.id
     WHERE spm.shopify_selling_plan_gid = $1 LIMIT 1`,
    [gid]
  );
  return result.rows[0] || null;
}

export async function getPlanById(planId: number): Promise<PlanRecord | null> {
  const result = await pool.query(`SELECT * FROM membership.plans WHERE id = $1`, [planId]);
  return result.rows[0] || null;
}

// ─── Selling Plan Map ────────────────────────────────────────────────

export async function upsertSellingPlanMap(entry: {
  shopify_selling_plan_gid: string;
  shopify_selling_plan_group_gid: string;
  plan_id: number;
  plan_name: string;
  billing_interval: string;
  price_cents: number;
}, client: any = pool): Promise<void> {
  await client.query(
    `INSERT INTO membership.selling_plan_map (shopify_selling_plan_gid, shopify_selling_plan_group_gid, plan_id, plan_name, billing_interval, price_cents, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (shopify_selling_plan_gid) DO UPDATE SET
       plan_id = $3, plan_name = $4, billing_interval = $5, price_cents = $6, updated_at = NOW()`,
    [entry.shopify_selling_plan_gid, entry.shopify_selling_plan_group_gid, entry.plan_id, entry.plan_name, entry.billing_interval, entry.price_cents]
  );
}

export async function getSellingPlanMap(): Promise<Array<{
  shopify_selling_plan_gid: string;
  shopify_selling_plan_group_gid: string;
  plan_id: number;
  plan_name: string;
  billing_interval: string;
  price_cents: number;
  is_active: boolean;
}>> {
  const result = await pool.query(`SELECT * FROM membership.selling_plan_map ORDER BY plan_id`);
  return result.rows;
}

// ─── Members ─────────────────────────────────────────────────────────

export async function findMemberByShopifyCustomerId(customerId: number): Promise<any | null> {
  const result = await pool.query(
    `SELECT * FROM membership.members WHERE shopify_customer_id = $1 LIMIT 1`,
    [customerId]
  );
  return result.rows[0] || null;
}

export async function findMemberByEmail(email: string): Promise<any | null> {
  const result = await pool.query(
    `SELECT * FROM membership.members WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email]
  );
  return result.rows[0] || null;
}

export async function upsertMember(data: {
  email: string;
  shopify_customer_id: number;
  first_name?: string;
  last_name?: string;
  tier?: string;
}): Promise<number> {
  // Try to find existing by shopify_customer_id first, then email
  let existing = await findMemberByShopifyCustomerId(data.shopify_customer_id);
  if (!existing) {
    existing = await findMemberByEmail(data.email);
  }

  if (existing) {
    await pool.query(
      `UPDATE membership.members SET shopify_customer_id = $1, tier = COALESCE($2, tier), updated_at = NOW() WHERE id = $3`,
      [data.shopify_customer_id, data.tier || null, existing.id]
    );
    return existing.id;
  }

  const result = await pool.query(
    `INSERT INTO membership.members (email, shopify_customer_id, first_name, last_name, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) RETURNING id`,
    [data.email, data.shopify_customer_id, data.first_name || null, data.last_name || null, data.tier || "standard"]
  );
  return result.rows[0].id;
}

export async function updateMemberTier(memberId: number, tier: string): Promise<void> {
  await pool.query(`UPDATE membership.members SET tier = $1, updated_at = NOW() WHERE id = $2`, [tier, memberId]);
}

// ─── Subscriptions ───────────────────────────────────────────────────

export async function findSubscriptionByContractId(contractId: number): Promise<SubscriptionRecord | null> {
  const result = await pool.query(
    `SELECT * FROM membership.member_subscriptions WHERE shopify_subscription_contract_id = $1 LIMIT 1`,
    [contractId]
  );
  return result.rows[0] || null;
}

export async function createSubscription(data: {
  member_id: number;
  plan_id: number;
  shopify_subscription_contract_id: number;
  shopify_subscription_contract_gid: string;
  shopify_customer_id: number;
  next_billing_date: Date;
  current_period_start: Date;
  current_period_end: Date;
  billing_status?: string;
}): Promise<number> {
  const result = await pool.query(
    `INSERT INTO membership.member_subscriptions
       (member_id, plan_id, shopify_subscription_contract_id, shopify_subscription_contract_gid,
        shopify_customer_id, next_billing_date, current_period_start, current_period_end,
        billing_status, status, started_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', NOW(), NOW())
     RETURNING id`,
    [
      data.member_id, data.plan_id, data.shopify_subscription_contract_id,
      data.shopify_subscription_contract_gid, data.shopify_customer_id,
      data.next_billing_date, data.current_period_start, data.current_period_end,
      data.billing_status || "current",
    ]
  );
  return result.rows[0].id;
}

export async function updateSubscriptionStatus(
  subscriptionId: number,
  status: string,
  billingStatus?: string,
  extra?: Partial<{ cancelled_at: Date; cancellation_reason: string }>
): Promise<void> {
  const sets = [`status = $1`];
  const vals: any[] = [status];
  let idx = 2;

  if (billingStatus) {
    sets.push(`billing_status = $${idx++}`);
    vals.push(billingStatus);
  }
  if (extra?.cancelled_at) {
    sets.push(`cancelled_at = $${idx++}`);
    vals.push(extra.cancelled_at);
  }
  if (extra?.cancellation_reason) {
    sets.push(`cancellation_reason = $${idx++}`);
    vals.push(extra.cancellation_reason);
  }

  vals.push(subscriptionId);
  await pool.query(
    `UPDATE membership.member_subscriptions SET ${sets.join(", ")} WHERE id = $${idx}`,
    vals
  );
}

export async function updateSubscriptionBillingDate(
  subscriptionId: number,
  nextBillingDate: Date,
  periodStart: Date,
  periodEnd: Date
): Promise<void> {
  await pool.query(
    `UPDATE membership.member_subscriptions
     SET next_billing_date = $1, current_period_start = $2, current_period_end = $3,
         failed_billing_attempts = 0, billing_status = 'current', billing_in_progress = false
     WHERE id = $4`,
    [nextBillingDate, periodStart, periodEnd, subscriptionId]
  );
}

export async function updateSubscriptionPlan(subscriptionId: number, planId: number): Promise<void> {
  await pool.query(
    `UPDATE membership.member_subscriptions SET plan_id = $1 WHERE id = $2`,
    [planId, subscriptionId]
  );
}

export async function incrementFailedBilling(subscriptionId: number): Promise<number> {
  const result = await pool.query(
    `UPDATE membership.member_subscriptions
     SET failed_billing_attempts = failed_billing_attempts + 1,
         billing_status = 'past_due', billing_in_progress = false
     WHERE id = $1
     RETURNING failed_billing_attempts`,
    [subscriptionId]
  );
  return result.rows[0]?.failed_billing_attempts || 0;
}

export async function setBillingInProgress(subscriptionId: number, inProgress: boolean): Promise<void> {
  await pool.query(
    `UPDATE membership.member_subscriptions SET billing_in_progress = $1 WHERE id = $2`,
    [inProgress, subscriptionId]
  );
}

export async function getDueBillings(): Promise<SubscriptionRecord[]> {
  const result = await pool.query(
    `SELECT ms.*, p.price_cents, p.billing_interval, p.billing_interval_count, p.tier, p.name as plan_name
     FROM membership.member_subscriptions ms
     JOIN membership.plans p ON p.id = ms.plan_id
     WHERE ms.billing_status IN ('current', 'past_due')
       AND ms.status = 'active'
       AND ms.next_billing_date <= NOW()
       AND ms.billing_in_progress = false
       AND ms.shopify_subscription_contract_gid IS NOT NULL
     ORDER BY ms.next_billing_date ASC
     LIMIT 100`
  );
  return result.rows;
}

// ─── Current Membership ──────────────────────────────────────────────

export async function upsertCurrentMembership(memberId: number, planId: number, planName: string): Promise<void> {
  await pool.query(
    `INSERT INTO member_current_membership (member_id, plan_id, plan_name, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (member_id) DO UPDATE SET plan_id = $2, plan_name = $3, updated_at = NOW()`,
    [memberId, planId, planName]
  );
}

export async function clearCurrentMembership(memberId: number): Promise<void> {
  await pool.query(
    `DELETE FROM member_current_membership WHERE member_id = $1`,
    [memberId]
  );
}

// ─── Billing Log ─────────────────────────────────────────────────────

export async function insertBillingLog(entry: {
  member_subscription_id: number;
  shopify_billing_attempt_id?: string;
  shopify_order_id?: number;
  amount_cents: number;
  status: string;
  error_code?: string;
  error_message?: string;
  idempotency_key?: string;
  billing_period_start?: Date;
  billing_period_end?: Date;
}): Promise<number> {
  const result = await pool.query(
    `INSERT INTO subscription_billing_log
       (member_subscription_id, shopify_billing_attempt_id, shopify_order_id,
        amount_cents, status, error_code, error_message, idempotency_key,
        billing_period_start, billing_period_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      entry.member_subscription_id, entry.shopify_billing_attempt_id || null,
      entry.shopify_order_id || null, entry.amount_cents, entry.status,
      entry.error_code || null, entry.error_message || null,
      entry.idempotency_key || null, entry.billing_period_start || null,
      entry.billing_period_end || null,
    ]
  );
  return result.rows[0]?.id || 0;
}

export async function getBillingLogs(filters?: {
  member_subscription_id?: number;
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ rows: BillingLogRecord[]; total: number }> {
  const where: string[] = [];
  const vals: any[] = [];
  let idx = 1;

  if (filters?.member_subscription_id) {
    where.push(`sbl.member_subscription_id = $${idx++}`);
    vals.push(filters.member_subscription_id);
  }
  if (filters?.status) {
    where.push(`sbl.status = $${idx++}`);
    vals.push(filters.status);
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = filters?.limit || 50;
  const offset = filters?.offset || 0;

  const countResult = await pool.query(
    `SELECT COUNT(*) as total FROM subscription_billing_log sbl ${whereClause}`,
    vals
  );

  const result = await pool.query(
    `SELECT sbl.*, ms.member_id, m.email as member_email, p.name as plan_name
     FROM subscription_billing_log sbl
     JOIN membership.member_subscriptions ms ON ms.id = sbl.member_subscription_id
     LEFT JOIN membership.members m ON m.id = ms.member_id
     LEFT JOIN membership.plans p ON p.id = ms.plan_id
     ${whereClause}
     ORDER BY sbl.created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    [...vals, limit, offset]
  );

  return { rows: result.rows, total: parseInt(countResult.rows[0].total) };
}

// ─── Events ──────────────────────────────────────────────────────────

export async function insertEvent(entry: {
  member_subscription_id?: number;
  shopify_subscription_contract_id?: number;
  event_type: string;
  event_source: string;
  payload?: any;
  notes?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO subscription_events
       (member_subscription_id, shopify_subscription_contract_id, event_type, event_source, payload, notes)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.member_subscription_id || null,
      entry.shopify_subscription_contract_id || null,
      entry.event_type, entry.event_source,
      entry.payload ? JSON.stringify(entry.payload) : null,
      entry.notes || null,
    ]
  );
}

export async function getEvents(filters?: {
  member_subscription_id?: number;
  event_type?: string;
  limit?: number;
}): Promise<SubscriptionEvent[]> {
  const where: string[] = [];
  const vals: any[] = [];
  let idx = 1;

  if (filters?.member_subscription_id) {
    where.push(`member_subscription_id = $${idx++}`);
    vals.push(filters.member_subscription_id);
  }
  if (filters?.event_type) {
    where.push(`event_type = $${idx++}`);
    vals.push(filters.event_type);
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = filters?.limit || 100;

  const result = await pool.query(
    `SELECT * FROM membership.subscription_events ${whereClause} ORDER BY created_at DESC LIMIT $${idx}`,
    [...vals, limit]
  );
  return result.rows;
}

// ─── Dashboard Stats ─────────────────────────────────────────────────

export async function getDashboardStats(): Promise<SubscriptionDashboardStats> {
  const client = await pool.connect();
  try {
    const activeResult = await client.query(
      `SELECT p.tier, COUNT(*) as cnt, SUM(COALESCE(p.price_cents, 0)) as total_price,
              p.billing_interval
       FROM membership.member_subscriptions ms
       JOIN membership.plans p ON p.id = ms.plan_id
       WHERE ms.status = 'active'
       GROUP BY p.tier, p.billing_interval`
    );

    let totalActive = 0;
    let totalActiveStandard = 0;
    let totalActiveGold = 0;
    let mrr = 0;

    for (const row of activeResult.rows) {
      const count = parseInt(row.cnt);
      totalActive += count;
      if (row.tier === "gold") totalActiveGold += count;
      else totalActiveStandard += count;

      // Calculate MRR: annual plans divided by 12
      const price = parseInt(row.total_price || "0");
      if (row.billing_interval === "year") {
        mrr += Math.round(price / 12);
      } else {
        mrr += price;
      }
    }

    const pastDueResult = await client.query(
      `SELECT COUNT(*) as cnt FROM membership.member_subscriptions WHERE billing_status = 'past_due' AND status = 'active'`
    );
    const pastDueCount = parseInt(pastDueResult.rows[0].cnt);

    // Churn: cancellations in last 30 days / active at start of period
    const churn30Result = await client.query(
      `SELECT COUNT(*) as cnt FROM membership.member_subscriptions
       WHERE cancelled_at >= NOW() - INTERVAL '30 days'`
    );
    const totalAtStart30 = totalActive + parseInt(churn30Result.rows[0].cnt);
    const churnRate30 = totalAtStart30 > 0 ? parseInt(churn30Result.rows[0].cnt) / totalAtStart30 : 0;

    const churn90Result = await client.query(
      `SELECT COUNT(*) as cnt FROM membership.member_subscriptions
       WHERE cancelled_at >= NOW() - INTERVAL '90 days'`
    );
    const totalAtStart90 = totalActive + parseInt(churn90Result.rows[0].cnt);
    const churnRate90 = totalAtStart90 > 0 ? parseInt(churn90Result.rows[0].cnt) / totalAtStart90 : 0;

    const newThisMonthResult = await client.query(
      `SELECT COUNT(*) as cnt FROM membership.member_subscriptions
       WHERE started_at >= DATE_TRUNC('month', NOW())`
    );

    const cancelledThisMonthResult = await client.query(
      `SELECT COUNT(*) as cnt FROM membership.member_subscriptions
       WHERE cancelled_at >= DATE_TRUNC('month', NOW())`
    );

    return {
      totalActive,
      totalActiveStandard,
      totalActiveGold,
      mrr,
      churnRate30: Math.round(churnRate30 * 10000) / 100,
      churnRate90: Math.round(churnRate90 * 10000) / 100,
      pastDueCount,
      newThisMonth: parseInt(newThisMonthResult.rows[0].cnt),
      cancelledThisMonth: parseInt(cancelledThisMonthResult.rows[0].cnt),
    };
  } finally {
    client.release();
  }
}

// ─── Subscriber List ─────────────────────────────────────────────────

export async function getSubscriberList(filters?: {
  status?: string;
  billing_status?: string;
  tier?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ rows: any[]; total: number }> {
  const where: string[] = [];
  const vals: any[] = [];
  let idx = 1;

  if (filters?.status) {
    where.push(`ms.status = $${idx++}`);
    vals.push(filters.status);
  }
  if (filters?.billing_status) {
    where.push(`ms.billing_status = $${idx++}`);
    vals.push(filters.billing_status);
  }
  if (filters?.tier) {
    where.push(`p.tier = $${idx++}`);
    vals.push(filters.tier);
  }
  if (filters?.search) {
    where.push(`(LOWER(m.email) LIKE $${idx} OR LOWER(m.first_name || ' ' || m.last_name) LIKE $${idx})`);
    vals.push(`%${filters.search.toLowerCase()}%`);
    idx++;
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = filters?.limit || 50;
  const offset = filters?.offset || 0;

  const countResult = await pool.query(
    `SELECT COUNT(*) as total
     FROM membership.member_subscriptions ms
     JOIN membership.members m ON m.id = ms.member_id
     JOIN membership.plans p ON p.id = ms.plan_id
     ${whereClause}`,
    vals
  );

  const result = await pool.query(
    `SELECT ms.id, ms.member_id, ms.plan_id, ms.status, ms.billing_status,
            ms.next_billing_date, ms.started_at, ms.cancelled_at,
            ms.failed_billing_attempts, ms.shopify_subscription_contract_id,
            m.email, m.first_name, m.last_name, m.shopify_customer_id,
            p.name as plan_name, p.tier, p.price_cents, p.billing_interval
     FROM membership.member_subscriptions ms
     JOIN membership.members m ON m.id = ms.member_id
     JOIN membership.plans p ON p.id = ms.plan_id
     ${whereClause}
     ORDER BY ms.created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    [...vals, limit, offset]
  );

  return { rows: result.rows, total: parseInt(countResult.rows[0].total) };
}

// ─── Subscription Detail ────────────────────────────────────────────

export async function getSubscriptionDetail(subscriptionId: number): Promise<any | null> {
  const result = await pool.query(
    `SELECT ms.*, m.email, m.first_name, m.last_name, m.shopify_customer_id as member_shopify_id,
            p.name as plan_name, p.tier, p.price_cents, p.billing_interval, p.includes_dropship
     FROM membership.member_subscriptions ms
     JOIN membership.members m ON m.id = ms.member_id
     JOIN membership.plans p ON p.id = ms.plan_id
     WHERE ms.id = $1`,
    [subscriptionId]
  );
  return result.rows[0] || null;
}
