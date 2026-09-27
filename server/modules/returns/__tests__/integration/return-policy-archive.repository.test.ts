import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import {
  ReturnPolicyAdminService,
  type CreateReturnPolicyInput,
} from "../../application/return-policy-admin.service";
import { PostgresReturnPolicyAdminStore } from "../../infrastructure/return-policy.repository";
import { acquireReturnPolicyCatalogLock } from "../../infrastructure/return-policy-lock";
import { resolveReturnsTestDatabase } from "../support/disposable-database";
import {
  createIntakeTestSchema,
  seedIntakeTestSchema,
  seedPreCarrierSelectionIntake,
  INTAKE_NOW,
} from "../support/customer-return-intake-database";

const connectionString = resolveReturnsTestDatabase(process.env, "policy");
const integration = connectionString ? describe.sequential : describe.skip;
integration("return policy archive on disposable PostgreSQL", () => {
  let pool: Pool;
  let service: ReturnPolicyAdminService;
  beforeAll(async () => {
    pool = new Pool({
      connectionString: connectionString!,
      max: 6,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
      application_name: "return-policy-archive-test",
    });
    await createIntakeTestSchema(pool);
    await pool.query(readFileSync("migrations/0107_audit_events.sql", "utf8"));
    service = new ReturnPolicyAdminService(
      new PostgresReturnPolicyAdminStore(drizzle(pool, { schema })),
      () => new Date(INTAKE_NOW),
    );
  });
  beforeEach(async () => {
    await seedIntakeTestSchema(pool);
    await pool.query(`TRUNCATE public.audit_events, returns.return_policy_commands RESTART IDENTITY;
      INSERT INTO channels.channels(id,name,type,provider,status) OVERRIDING SYSTEM VALUE VALUES(103,'Dropship OMS','internal','manual','active');
      SELECT setval(pg_get_serial_sequence('returns.return_policies','id'),1);`);
    await seedPreCarrierSelectionIntake(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });
  async function command() {
    const preview = await service.previewArchive(1);
    return {
      expectedVersion: preview.policy.version,
      previewRevision: preview.revision,
    };
  }
  async function history() {
    return (
      await pool.query(`SELECT c.policy_id,c.policy_version,c.policy_snapshot,i.operational_policy_snapshot,
      a.policy_snapshot AS authorization_policy FROM returns.return_cases c
      JOIN returns.customer_return_intakes i ON i.authorization_id=1
      JOIN returns.customer_return_authorizations a ON a.id=i.authorization_id WHERE c.id=1`)
    ).rows;
  }
  it("retires the exact version with durable command/audit evidence and preserves existing return snapshots", async () => {
    const before = await history();
    const preview = await service.previewArchive(1);
    expect(preview.historicalReferences).toEqual({
      returnCases: 1,
      portalIntakes: 1,
    });
    expect(preview.effects.every((effect) => effect.after === null)).toBe(true);
    const input = { expectedVersion: 1, previewRevision: preview.revision };
    expect(
      await service.archive(1, input, "archive-history", "archive-admin"),
    ).toMatchObject({
      policy: { id: 1, status: "retired", version: 1 },
      replayed: false,
    });
    expect(await history()).toEqual(before);
    expect(
      (
        await pool.query(
          `SELECT status,retired_by,retired_at FROM returns.return_policies WHERE id=1`,
        )
      ).rows,
    ).toEqual([
      {
        status: "retired",
        retired_by: "archive-admin",
        retired_at: INTAKE_NOW,
      },
    ]);
    const events = (
      await pool.query(
        `SELECT actor,action,changes,context FROM public.audit_events WHERE action='RETURN_POLICY_ARCHIVED'`,
      )
    ).rows;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: "archive-admin",
      changes: { before: { status: "active" }, after: { status: "retired" } },
      context: { archivePreview: { revision: preview.revision } },
    });
    expect(
      await service.archive(1, input, "archive-history", "archive-admin"),
    ).toMatchObject({ replayed: true });
    expect(
      (
        await pool.query(
          `SELECT COUNT(*)::int AS n FROM returns.return_policy_commands`,
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("serializes concurrent identical archive requests and rejects conflicting reuse", async () => {
    const input = await command();
    const results = await Promise.all([
      service.archive(1, input, "archive-concurrent", "admin"),
      service.archive(1, input, "archive-concurrent", "admin"),
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([
      false,
      true,
    ]);
    await expect(
      service.archive(
        1,
        { ...input, expectedVersion: 2 },
        "archive-concurrent",
        "admin",
      ),
    ).rejects.toMatchObject({ code: "RETURN_POLICY_IDEMPOTENCY_CONFLICT" });
    expect(
      (
        await pool.query(
          `SELECT COUNT(*)::int AS n FROM public.audit_events WHERE action='RETURN_POLICY_ARCHIVED'`,
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("rejects a stale preview after a fallback is created and recomputes the actual winning policy", async () => {
    const input = await command();
    const fallback = await service.createVersion(createInput("fallback"));
    await expect(
      service.archive(1, input, "stale", "admin"),
    ).rejects.toMatchObject({ code: "RETURN_POLICY_ARCHIVE_CHANGED" });
    expect(
      (await service.previewArchive(1)).effects.every(
        (effect) => effect.after?.id === fallback.policy.id,
      ),
    ).toBe(true);
    expect(
      (
        await pool.query(
          `SELECT status FROM returns.return_policies WHERE id=1`,
        )
      ).rows[0].status,
    ).toBe("active");
  });
  it("rolls back retirement and idempotency evidence if the audit cannot be persisted", async () => {
    const input = await command();
    await pool.query(`CREATE FUNCTION public.reject_policy_archive_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='RETURN_POLICY_ARCHIVED' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_policy_archive_test BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_policy_archive_test();`);
    try {
      await expect(
        service.archive(1, input, "audit-failure", "admin"),
      ).rejects.toThrow();
      expect(
        (
          await pool.query(
            `SELECT status FROM returns.return_policies WHERE id=1`,
          )
        ).rows[0].status,
      ).toBe("active");
      expect(
        (
          await pool.query(
            `SELECT COUNT(*)::int AS n FROM returns.return_policy_commands WHERE idempotency_key='audit-failure'`,
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await pool.query(
        `DROP TRIGGER reject_policy_archive_test ON public.audit_events; DROP FUNCTION public.reject_policy_archive_test();`,
      );
    }
  });
  it.each(["archive", "create"] as const)(
    "holds %s behind an in-flight shared policy snapshot until commit",
    async (operation) => {
      const input = await command();
      const client = await pool.connect();
      await client.query("BEGIN");
      await acquireReturnPolicyCatalogLock(
        drizzle(client, { schema }),
        "shared",
      );
      const mutation =
        operation === "archive"
          ? service.archive(1, input, "locked-archive", "admin")
          : service.createVersion(createInput("locked-create"));
      // Attach immediately so a failed command cannot produce an unhandled rejection.
      const settled = mutation.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await expect
          .poll(async () =>
            Number(
              (
                await pool.query(`SELECT COUNT(*) AS n FROM pg_stat_activity
        WHERE application_name='return-policy-archive-test' AND wait_event='advisory'`)
              ).rows[0].n,
            ),
          )
          .toBeGreaterThan(0);
        expect(
          (
            await pool.query(
              `SELECT status FROM returns.return_policies WHERE id=1`,
            )
          ).rows[0].status,
        ).toBe("active");
      } finally {
        await client.query("COMMIT");
        client.release();
      }
      expect(await settled).toHaveProperty("value");
    },
  );
});
function createInput(idempotencyKey: string): CreateReturnPolicyInput {
  return {
    idempotencyKey,
    actor: "admin",
    name: "Global fallback",
    appliesTo: "all_orders",
    channelId: null,
    vendorId: null,
    storeConnectionId: null,
    returnWindowDays: 60,
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
  };
}
