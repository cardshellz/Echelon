/**
 * The shared member resolver against real PostgreSQL. The fixture carries the
 * columns Echelon reads from the membership app's schema
 * (cardshellz/shellz-club-app shared/schema.ts, commit f678a69) and the app's
 * current-plan view copied verbatim from its migration
 * 0079_member_current_membership_as_view.sql. Reduced fixture, not proof of
 * the production definitions: the pre-deploy check compares those.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { validatePostgresTestEnvironment } from "../../../../../scripts/ci/postgres-tests";
import { createMemberResolver, MembershipResolverError, type MemberResolver } from "../..";
import { PgMemberDirectory } from "../../infrastructure/member-directory.repository";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
if (databaseUrl && disposable) validatePostgresTestEnvironment(process.env);
const integration = databaseUrl && disposable ? describe.sequential : describe.skip;

const CURRENT_MEMBERSHIP_VIEW_SQL = `
  CREATE VIEW membership.member_current_membership AS
  SELECT DISTINCT ON (member_id)
    member_id,
    id AS subscription_id,
    plan_id,
    status,
    billing_interval,
    cycle_ends_at,
    scheduled_plan_id,
    created_at AS updated_at
  FROM membership.member_subscriptions
  WHERE status = ANY (ARRAY['active', 'pending_downgrade', 'pending_cancellation'])
  ORDER BY member_id, created_at DESC
`;

const fixture = `
  CREATE SCHEMA membership;
  CREATE TABLE membership.plans (
    id varchar PRIMARY KEY,
    name text NOT NULL,
    primary_color text,
    priority_modifier integer NOT NULL DEFAULT 0
  );
  CREATE TABLE membership.members (
    id varchar PRIMARY KEY,
    shopify_customer_id text NOT NULL UNIQUE,
    email text NOT NULL
  );
  CREATE TABLE membership.member_subscriptions (
    id varchar PRIMARY KEY,
    member_id varchar NOT NULL REFERENCES membership.members(id),
    plan_id varchar NOT NULL REFERENCES membership.plans(id),
    status text NOT NULL DEFAULT 'active',
    billing_interval text NOT NULL,
    cycle_ends_at timestamptz,
    scheduled_plan_id varchar REFERENCES membership.plans(id),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE membership.member_shopify_customer_ids (
    shopify_customer_id text PRIMARY KEY,
    member_id varchar NOT NULL REFERENCES membership.members(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
  );
  ${CURRENT_MEMBERSHIP_VIEW_SQL};
`;

const CUSTOMER_ID = "23325275357343";
const CLUB_PLAN_ID = "5f966934-9ff2-4966-9e8f-d4292ca3290e";
const OPS_PLAN_ID = "14d8698f-09d8-4dea-8089-fa9a1ec0fb28";
const CORE_PLAN_ID = "c0de0000-0000-4000-8000-000000000001";

integration("shared member resolver with real PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let resolver: MemberResolver;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, fixture);
    resolver = createMemberResolver(database.pool);
  });
  beforeEach(async () => {
    await database.pool.query(`TRUNCATE membership.member_shopify_customer_ids, membership.member_subscriptions,
      membership.members, membership.plans`);
    await database.pool.query(`INSERT INTO membership.plans (id, name, primary_color, priority_modifier) VALUES
      ($1, '.club', '#2E86DE', 50), ($2, '.ops', '#C060E0', 100), ($3, '.core', NULL, 0)`,
    [CLUB_PLAN_ID, OPS_PLAN_ID, CORE_PLAN_ID]);
  });
  afterAll(async () => { await database?.close(); });

  async function member(id: string, shopifyCustomerId: string): Promise<void> {
    await database.pool.query(
      `INSERT INTO membership.members (id, shopify_customer_id, email) VALUES ($1, $2, $3)`,
      [id, shopifyCustomerId, `${id}@example.invalid`],
    );
  }

  async function subscription(input: {
    id: string; memberId: string; planId: string; status: string; createdAt: string;
  }): Promise<void> {
    await database.pool.query(
      `INSERT INTO membership.member_subscriptions (id, member_id, plan_id, status, billing_interval, created_at)
       VALUES ($1, $2, $3, $4, 'yearly', $5)`,
      [input.id, input.memberId, input.planId, input.status, input.createdAt],
    );
  }

  const shopifyKey = { kind: "shopify_customer", shopifyCustomerId: CUSTOMER_ID } as const;

  it("finds a member stored under the numeric id and returns its current plan", async () => {
    await member("member-1", CUSTOMER_ID);
    await subscription({ id: "sub-1", memberId: "member-1", planId: CLUB_PLAN_ID, status: "active", createdAt: "2026-01-01T00:00:00Z" });

    expect(await resolver.resolve(shopifyKey)).toEqual({
      outcome: "member",
      memberId: "member-1",
      matchedBy: "shopify_customer_id",
      subscriptionId: "sub-1",
      subscriptionStatus: "active",
      plan: { planId: CLUB_PLAN_ID, name: ".club", color: "#2E86DE", priorityModifier: 50 },
    });
  });

  it("finds a member stored under the GID form", async () => {
    await member("member-gid", `gid://shopify/Customer/${CUSTOMER_ID}`);
    await subscription({ id: "sub-1", memberId: "member-gid", planId: OPS_PLAN_ID, status: "active", createdAt: "2026-01-01T00:00:00Z" });

    expect(await resolver.resolve(shopifyKey)).toMatchObject({
      outcome: "member",
      memberId: "member-gid",
      plan: { planId: OPS_PLAN_ID, priorityModifier: 100 },
    });
  });

  it("finds a merged Shopify customer through the alias table", async () => {
    await member("member-merged", "99999999999999");
    await database.pool.query(
      `INSERT INTO membership.member_shopify_customer_ids (shopify_customer_id, member_id) VALUES ($1, 'member-merged')`,
      [CUSTOMER_ID],
    );
    await subscription({ id: "sub-1", memberId: "member-merged", planId: CLUB_PLAN_ID, status: "active", createdAt: "2026-01-01T00:00:00Z" });

    expect(await resolver.resolve(shopifyKey)).toMatchObject({
      outcome: "member",
      memberId: "member-merged",
      matchedBy: "shopify_customer_id_alias",
    });
  });

  it("refuses to choose when the numeric id and the GID belong to different members", async () => {
    await member("member-b", CUSTOMER_ID);
    await member("member-a", `gid://shopify/Customer/${CUSTOMER_ID}`);

    expect(await resolver.resolve(shopifyKey)).toEqual({ outcome: "ambiguous_member", memberIds: ["member-a", "member-b"] });
  });

  it("uses the view's rule: newest active or pending subscription wins, cancelled ones never count", async () => {
    await member("member-1", CUSTOMER_ID);
    await subscription({ id: "sub-old", memberId: "member-1", planId: CORE_PLAN_ID, status: "active", createdAt: "2025-01-01T00:00:00Z" });
    await subscription({ id: "sub-new", memberId: "member-1", planId: CLUB_PLAN_ID, status: "pending_downgrade", createdAt: "2026-01-01T00:00:00Z" });
    await subscription({ id: "sub-cancelled", memberId: "member-1", planId: OPS_PLAN_ID, status: "cancelled", createdAt: "2026-06-01T00:00:00Z" });

    expect(await resolver.resolve(shopifyKey)).toMatchObject({
      outcome: "member",
      subscriptionId: "sub-new",
      subscriptionStatus: "pending_downgrade",
      plan: { planId: CLUB_PLAN_ID },
    });
  });

  it("reports a member whose subscriptions have all ended", async () => {
    await member("member-1", CUSTOMER_ID);
    await subscription({ id: "sub-1", memberId: "member-1", planId: CLUB_PLAN_ID, status: "expired", createdAt: "2026-01-01T00:00:00Z" });

    expect(await resolver.resolve(shopifyKey))
      .toEqual({ outcome: "member_without_plan", memberId: "member-1", matchedBy: "shopify_customer_id" });
  });

  it("finds no member for an unknown customer id", async () => {
    await member("member-1", "11111111111111");

    expect(await resolver.resolve(shopifyKey)).toEqual({ outcome: "no_member" });
  });

  it("finds a member by member id", async () => {
    await member("vendor-member", "11111111111111");
    await subscription({ id: "sub-1", memberId: "vendor-member", planId: OPS_PLAN_ID, status: "active", createdAt: "2026-01-01T00:00:00Z" });

    expect(await resolver.resolve({ kind: "member", memberId: "vendor-member" }))
      .toMatchObject({ outcome: "member", matchedBy: "member_id", plan: { planId: OPS_PLAN_ID, priorityModifier: 100 } });
    expect(await resolver.resolve({ kind: "member", memberId: "nobody" })).toEqual({ outcome: "no_member" });
  });

  it("reads a zero modifier and a missing color as they are stored", async () => {
    await member("member-1", CUSTOMER_ID);
    await subscription({ id: "sub-1", memberId: "member-1", planId: CORE_PLAN_ID, status: "active", createdAt: "2026-01-01T00:00:00Z" });

    expect(await resolver.resolve(shopifyKey)).toMatchObject({
      plan: { planId: CORE_PLAN_ID, name: ".core", color: null, priorityModifier: 0 },
    });
  });

  it("returns every connection it borrows, across more lookups than the pool holds", async () => {
    await member("member-1", CUSTOMER_ID);
    await subscription({ id: "sub-1", memberId: "member-1", planId: CLUB_PLAN_ID, status: "active", createdAt: "2026-01-01T00:00:00Z" });

    // The fixture pool holds 4 connections; a leak would hang this test.
    const resolutions = await Promise.all(Array.from({ length: 20 }, () => resolver.resolve(shopifyKey)));

    expect(resolutions.every((resolution) => resolution.outcome === "member")).toBe(true);
    expect(database.pool.waitingCount).toBe(0);
    expect(database.pool.idleCount).toBe(database.pool.totalCount);
  });

  it("fails as transient, and keeps its connections, when the view is missing", async () => {
    await member("member-1", CUSTOMER_ID);
    await database.pool.query(`ALTER VIEW membership.member_current_membership RENAME TO member_current_membership_hidden`);
    try {
      const error = await resolver.resolve(shopifyKey).then(() => null, (caught: unknown) => caught);

      expect(error).toBeInstanceOf(MembershipResolverError);
      expect(error).toMatchObject({ code: "MEMBERSHIP_LOOKUP_FAILED", classification: "transient" });
      expect(database.pool.idleCount).toBe(database.pool.totalCount);
    } finally {
      await database.pool.query(`ALTER VIEW membership.member_current_membership_hidden RENAME TO member_current_membership`);
    }
  });

  it("caps the ambiguity probe and returns ids as text", async () => {
    const directory = new PgMemberDirectory(database.pool);
    await member("member-1", CUSTOMER_ID);
    await member("member-2", `gid://shopify/Customer/${CUSTOMER_ID}`);

    expect(await directory.findMemberIdsByShopifyCustomerIds([CUSTOMER_ID, `gid://shopify/Customer/${CUSTOMER_ID}`]))
      .toEqual(["member-1", "member-2"]);
    expect(await directory.findMemberIdsByShopifyCustomerIds([])).toEqual([]);
    expect(await directory.findMemberIdsByShopifyCustomerIdAliases([])).toEqual([]);
  });
});
