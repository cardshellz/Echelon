import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as schema from "@shared/schema";
import {
  ReturnPolicyAdminService,
  type CreateReturnPolicyInput,
} from "../../application/return-policy-admin.service";
import { PostgresReturnPolicyAdminStore } from "../../infrastructure/return-policy.repository";
import { PostgresCustomerReturnSettingsStore } from "../../infrastructure/customer-return-label-settings.repository";
import { resolveReturnsTestDatabase } from "../support/disposable-database";
import {
  createIntakeTestSchema,
  seedIntakeTestSchema,
  INTAKE_NOW,
} from "../support/customer-return-intake-database";
import { defaultCustomerReturnShippingGuardrails } from "@shared/returns/customer-return-shipping-guardrails";
import { PostgresCustomerReturnPortalPolicyReader } from "../../infrastructure/customer-return-policy.reader";

const connectionString = resolveReturnsTestDatabase(process.env, "policy");
const integration = connectionString ? describe.sequential : describe.skip;
integration("atomic return policy and shipping versions on PostgreSQL", () => {
  let pool: Pool;
  let service: ReturnPolicyAdminService;
  let settings: PostgresCustomerReturnSettingsStore;
  const capabilities = vi.fn(async () => ({
    configured: true,
    carriers: [
      {
        id: "se-123",
        code: "usps",
        name: "Fixture USPS",
        services: [{ code: "usps_ground_advantage", name: "Ground Advantage" }],
      },
    ],
  }));
  beforeAll(async () => {
    pool = new Pool({
      connectionString: connectionString!,
      max: 8,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
    });
    await createIntakeTestSchema(pool);
    await pool.query(readFileSync("migrations/0107_audit_events.sql", "utf8"));
    const database = drizzle(pool, { schema });
    service = new ReturnPolicyAdminService(
      new PostgresReturnPolicyAdminStore(database),
      () => new Date(INTAKE_NOW),
      capabilities,
    );
    settings = new PostgresCustomerReturnSettingsStore(database);
  });
  beforeEach(async () => {
    await seedIntakeTestSchema(pool);
    await pool.query(`TRUNCATE public.audit_events,returns.return_policy_commands RESTART IDENTITY;
      INSERT INTO channels.channels(id,name,type,provider,status) OVERRIDING SYSTEM VALUE VALUES(103,'Dropship OMS','internal','manual','active');
      SELECT setval(pg_get_serial_sequence('returns.return_policies','id'),1);`);
    capabilities.mockClear();
  });
  afterAll(async () => {
    await pool?.end();
  });

  function command(
    overrides: Partial<CreateReturnPolicyInput> = {},
  ): CreateReturnPolicyInput {
    return {
      idempotencyKey: "policy-shipping-command",
      actor: "admin:test",
      expectedPolicyId: null,
      name: "Shopify policy",
      appliesTo: "channel",
      channelId: 36,
      vendorId: null,
      storeConnectionId: null,
      returnWindowDays: 90,
      returnDestination: "card_shellz",
      approvalAuthority: "card_shellz",
      labelProvider: "shipstation",
      returnShippingPayer: "card_shellz",
      inspectionRequirement: "required",
      inspectionOwner: "card_shellz",
      customerRefundAuthority: "card_shellz",
      vendorSettlementTrigger: "none",
      returnlessRefundAllowed: false,
      notes: null,
      shipping: {
        enabled: true,
        warehouseId: 1,
        selectionMode: "cheapest_eligible",
        carrierId: null,
        serviceCode: null,
        carrierRules: [
          {
            carrierId: "se-123",
            serviceCodes: ["usps_ground_advantage"],
            maxWeightLb: "20",
          },
        ],
        contactName: "Receiving team",
        contactPhone: null,
      },
      ...overrides,
    };
  }
  async function counts() {
    return (
      await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM returns.return_policies) AS policies,
      (SELECT COUNT(*)::int FROM returns.return_policy_shipping) AS shipping,
      (SELECT COUNT(*)::int FROM returns.return_policy_commands) AS commands,
      (SELECT COUNT(*)::int FROM public.audit_events) AS audit`)
    ).rows[0];
  }

  it("commits matching rules, frozen warehouse, shipping, command and audit together", async () => {
    const result = await service.createVersion(command());
    expect(result).toMatchObject({
      replayed: false,
      policy: {
        id: 2,
        returnWindowDays: 90,
        shipping: {
          policyId: 2,
          version: 2,
          warehouseId: 1,
          enabled: true,
          selectionMode: "cheapest_eligible",
          destinationAddress: { name: "Receiving team", countryCode: "US" },
        },
      },
    });
    expect(await settings.read(36)).toMatchObject({
      policyId: 2,
      version: 2,
      contactName: "Receiving team",
    });
    expect(await counts()).toEqual({
      policies: 2,
      shipping: 2,
      commands: 1,
      audit: 1,
    });
    const event = (await pool.query("SELECT changes FROM public.audit_events"))
      .rows[0];
    expect(event.changes.after).toMatchObject({
      id: 2,
      shipping: { policyId: 2, carrierRules: [{ maxWeightLb: "20" }] },
    });
    await expect(
      pool.query(
        "UPDATE returns.return_policy_shipping SET configuration=NULL WHERE policy_id=2",
      ),
    ).rejects.toThrow();
    expect(await settings.readControl(36)).toEqual({
      paused: false,
      version: 1,
    });
  });

  it("saves guardrails immutably with the policy, resolves them by channel and audits their exact values", async () => {
    const input = command();
    input.shipping = { ...input.shipping!, parcelGuardrails: defaultCustomerReturnShippingGuardrails() };
    const result = await service.createVersion(input);
    expect(result.policy).toMatchObject({ shipping: { parcelGuardrails: input.shipping.parcelGuardrails } });
    expect((await settings.read(36))?.parcelGuardrails).toEqual(input.shipping.parcelGuardrails);
    const reader = new PostgresCustomerReturnPortalPolicyReader(drizzle(pool, { schema }));
    expect((await reader.read(36)).find(policy => policy.id === result.policy.id)?.shipping?.parcelGuardrails)
      .toEqual(input.shipping.parcelGuardrails);
    expect((await pool.query("SELECT changes FROM public.audit_events")).rows[0].changes.after.shipping.parcelGuardrails)
      .toEqual(input.shipping.parcelGuardrails);
    const changed = structuredClone(input);
    changed.shipping!.parcelGuardrails!.costProtection = false;
    await expect(service.createVersion(changed)).rejects.toMatchObject({ code: "RETURN_POLICY_IDEMPOTENCY_CONFLICT" });
    await expect(pool.query("UPDATE returns.return_policy_shipping SET configuration=configuration - 'parcelGuardrails' WHERE policy_id=$1", [result.policy.id]))
      .rejects.toThrow();
    expect((await counts()).commands).toBe(1);
  });
  it("persists the administrator's warehouse classification in the policy, resolver and audit with idempotent replay", async () => {
    const input = command();
    input.shipping = { ...input.shipping!, warehouseAddressType: "residential" };
    const result = await service.createVersion(input);
    expect(result.policy).toMatchObject({ shipping: { warehouseAddressType: "residential" } });
    expect((await settings.read(36))?.warehouseAddressType).toBe("residential");
    const reader = new PostgresCustomerReturnPortalPolicyReader(drizzle(pool, { schema }));
    expect((await reader.read(36)).find(policy => policy.id === result.policy.id)?.shipping?.warehouseAddressType).toBe("residential");
    expect((await pool.query("SELECT changes FROM public.audit_events")).rows[0].changes.after.shipping.warehouseAddressType).toBe("residential");
    expect((await service.createVersion(input)).replayed).toBe(true);
    expect((await counts()).commands).toBe(1);
    const changed = structuredClone(input);
    changed.shipping!.warehouseAddressType = "commercial";
    await expect(service.createVersion(changed)).rejects.toMatchObject({ code: "RETURN_POLICY_IDEMPOTENCY_CONFLICT" });
    await expect(pool.query("UPDATE returns.return_policy_shipping SET configuration=configuration - 'warehouseAddressType' WHERE policy_id=$1", [result.policy.id]))
      .rejects.toThrow();
  });

  it("replays an identical combined command without rereading a carrier and rejects changed intent", async () => {
    const input = command();
    const results = await Promise.all([
      service.createVersion(input),
      service.createVersion(input),
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(capabilities).toHaveBeenCalledTimes(1);
    await expect(
      service.createVersion({ ...input, returnWindowDays: 91 }),
    ).rejects.toMatchObject({ code: "RETURN_POLICY_IDEMPOTENCY_CONFLICT" });
    expect(await counts()).toEqual({
      policies: 2,
      shipping: 2,
      commands: 1,
      audit: 1,
    });
  });

  it("serializes competing edits against the exact active policy so only one wins", async () => {
    const original = await service.createVersion(command());
    const outcomes = await Promise.allSettled([
      service.createVersion(
        command({
          idempotencyKey: "first-edit",
          expectedPolicyId: original.policy.id,
          returnWindowDays: 120,
        }),
      ),
      service.createVersion(
        command({
          idempotencyKey: "second-edit",
          expectedPolicyId: original.policy.id,
          returnWindowDays: 180,
        }),
      ),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toMatchObject([{ reason: { code: "RETURN_POLICY_CHANGED" } }]);
    expect(await counts()).toEqual({
      policies: 3,
      shipping: 3,
      commands: 2,
      audit: 2,
    });
  });

  it("rolls back retiring the old policy when a late shipping write fails", async () => {
    const original = await service.createVersion(command());
    const before = await counts();
    await pool.query(`CREATE FUNCTION returns.reject_shipping_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic shipping failure'; END $$;
      CREATE TRIGGER reject_shipping_test BEFORE INSERT ON returns.return_policy_shipping FOR EACH ROW EXECUTE FUNCTION returns.reject_shipping_test();`);
    try {
      await expect(
        service.createVersion(
          command({
            expectedPolicyId: original.policy.id,
            idempotencyKey: "late-failure",
          }),
        ),
      ).rejects.toThrow("synthetic shipping failure");
      expect(await counts()).toEqual(before);
      expect(
        (
          await pool.query(
            "SELECT status FROM returns.return_policies WHERE id=$1",
            [original.policy.id],
          )
        ).rows[0].status,
      ).toBe("active");
      expect(await settings.read(36)).toMatchObject({
        policyId: original.policy.id,
      });
    } finally {
      await pool.query(
        "DROP TRIGGER reject_shipping_test ON returns.return_policy_shipping; DROP FUNCTION returns.reject_shipping_test()",
      );
    }
  });

  it("explicitly unconfigured shipping never falls back to the legacy channel settings", async () => {
    // Build actual historical settings before the migration freezes them. The
    // new unconfigured version must not inherit this preserved legacy row.
    await createIntakeTestSchema(pool, { policyShipping: false });
    await seedIntakeTestSchema(pool);
    await pool.query(
      readFileSync("migrations/255_return_policy_shipping.sql", "utf8"),
    );
    await pool.query(
      "INSERT INTO channels.channels(id,name,type,provider,status) OVERRIDING SYSTEM VALUE VALUES(103,'Dropship OMS','internal','manual','active')",
    );
    const prior = await settings.read(36);
    expect(prior?.policyId).toBeGreaterThan(1);
    const result = await service.createVersion(
      command({ shipping: null, expectedPolicyId: prior!.policyId! }),
    );
    expect(
      (
        await pool.query(
          "SELECT configuration FROM returns.return_policy_shipping WHERE policy_id=$1",
          [result.policy.id],
        )
      ).rows,
    ).toEqual([{ configuration: null }]);
    expect(
      (
        await pool.query(
          "SELECT channel_id FROM returns.customer_return_settings WHERE channel_id=36",
        )
      ).rowCount,
    ).toBe(1);
    expect(await settings.read(36)).toBeNull();
    expect(capabilities).not.toHaveBeenCalled();
  });

  it("rejects invalid destination or warehouse before any writes and keeps existing rules active", async () => {
    const before = await counts();
    await expect(
      service.createVersion(command({ returnDestination: "vendor" })),
    ).rejects.toMatchObject({ code: "RETURN_POLICY_SHIPPING_INCOMPATIBLE" });
    const invalid = command();
    invalid.shipping = { ...invalid.shipping!, warehouseId: 999 };
    await expect(service.createVersion(invalid)).rejects.toMatchObject({
      code: "RETURN_POLICY_WAREHOUSE_INVALID",
    });
    expect(await counts()).toEqual(before);
  });
});
