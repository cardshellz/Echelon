import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresCustomerReturnLabelStore } from "../../infrastructure/customer-return-labels.repository";
import { PostgresCustomerReturnSettingsStore } from "../../infrastructure/customer-return-label-settings.repository";
import {
  PostgresCustomerReturnSubmissionStore,
  RETURN_SUBMISSION_LEASE_MS,
} from "../../infrastructure/customer-return-submission.repository";
import { PostgresCustomerReturnIntakeStore } from "../../infrastructure/customer-return-intake.repository";
import { customerReturnSubmissionHash } from "../../application/customer-return-intake-preparation";
import { customerReturnLabelSubmitInputSchema } from "@shared/returns/customer-return-label.contract";
import { resolveReturnsTestDatabase } from "../support/disposable-database";
import {
  createIntakeTestSchema,
  seedIntakeTestSchema,
  preparedIntake,
  INTAKE_KEY,
  INTAKE_LEASE,
  INTAKE_NOW,
} from "../support/customer-return-intake-database";
import type { ReturnLabelRecord } from "../../../shipping-engine/application/return-label-provider.port";
import { CUSTOMER_RETURN_LABEL_SEARCH_SQL } from "../../infrastructure/customer-return-label-search";

const connectionString = resolveReturnsTestDatabase(process.env, "intake");
const integration = connectionString ? describe.sequential : describe.skip;
const secondKey = "00000000-0000-4000-8000-000000000003";
const secondLease = "00000000-0000-4000-8000-000000000004";
integration(
  "private label settings, intent and purchase ledger on PostgreSQL",
  () => {
    let pool: Pool;
    let labels: PostgresCustomerReturnLabelStore;
    let commands: PostgresCustomerReturnSubmissionStore;
    let settings: PostgresCustomerReturnSettingsStore;
    let intake: PostgresCustomerReturnIntakeStore;
    beforeAll(async () => {
      pool = new Pool({
        connectionString: connectionString!,
        max: 8,
        connectionTimeoutMillis: 5000,
        statement_timeout: 15000,
      });
      await createIntakeTestSchema(pool);
      const database = drizzle(pool, { schema });
      labels = new PostgresCustomerReturnLabelStore(pool);
      commands = new PostgresCustomerReturnSubmissionStore(pool);
      settings = new PostgresCustomerReturnSettingsStore(database);
      intake = new PostgresCustomerReturnIntakeStore(database);
    });
    beforeEach(async () => seedIntakeTestSchema(pool));
    afterAll(async () => {
      await pool?.end();
    });
    async function authorize() {
      return intake.persist(preparedIntake());
    }
    async function request() {
      return customerReturnLabelSubmitInputSchema.parse(
        (
          await pool.query(
            `SELECT request_snapshot FROM returns.customer_return_submission_commands WHERE idempotency_key=$1`,
            [INTAKE_KEY],
          )
        ).rows[0].request_snapshot,
      );
    }
    async function config() {
      const {
        version,
        destinationAddress: _address,
        ...input
      } = (await settings.read(36))!;
      return { ...input, expectedVersion: version };
    }
    function record(externalShipmentId: string): ReturnLabelRecord {
      return {
        labelId: "se-456",
        shipmentId: "se-789",
        externalShipmentId,
        trackingNumber: "TESTTRACK",
        carrierId: "se-123",
        serviceCode: "usps_ground_advantage",
        amountCents: 503,
        currency: "USD",
        downloadUrl: "https://api.shipstation.com/v2/downloads/test/label.pdf",
        labelFormat: "pdf",
        createdAt: INTAKE_NOW.toISOString(),
      };
    }
    it("concurrent purchase claims create exactly one durable executing intent", async () => {
      const saved = await authorize();
      const parcel = saved.parcels[0];
      const results = await Promise.all([
        labels.begin(
          36,
          saved.authorizationId,
          parcel.parcelId,
          "admin:a",
          INTAKE_NOW,
        ),
        labels.begin(
          36,
          saved.authorizationId,
          parcel.parcelId,
          "admin:b",
          INTAKE_NOW,
        ),
      ]);
      expect(results.filter((value) => value !== null)).toHaveLength(1);
      const rows = (
        await pool.query(
          `SELECT status,request_snapshot,actor FROM returns.customer_return_label_attempts`,
        )
      ).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("executing");
      expect(rows[0].request_snapshot.parcel.dimensionsInches).toEqual({
        length: 3.938,
        width: 4.725,
        height: 5.906,
      });
      await expect(
        pool.query(
          `UPDATE returns.customer_return_label_attempts SET request_snapshot='{}'::jsonb`,
        ),
      ).rejects.toThrow(/immutable/);
      expect(
        (
          await pool.query(
            `SELECT COUNT(*)::int AS n FROM returns.customer_return_label_events`,
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it("uncertain recovery updates one attempt and cannot overwrite a completed label", async () => {
      const saved = await authorize();
      const parcel = saved.parcels[0];
      const attempt = (await labels.begin(
        36,
        saved.authorizationId,
        parcel.parcelId,
        "admin",
        INTAKE_NOW,
      ))!;
      await labels.finish(
        attempt,
        { status: "uncertain", code: "RETURN_LABEL_TIMEOUT" },
        "admin",
        INTAKE_NOW,
      );
      expect(
        await labels.begin(
          36,
          saved.authorizationId,
          parcel.parcelId,
          "admin",
          INTAKE_NOW,
        ),
      ).toBeNull();
      const result = record(parcel.providerExternalShipmentId);
      await labels.finish(
        attempt,
        { status: "succeeded", result },
        "recovery-admin",
        INTAKE_NOW,
      );
      await labels.finish(
        attempt,
        { status: "uncertain", code: "RETURN_LABEL_TIMEOUT" },
        "stale-reader",
        INTAKE_NOW,
      );
      expect(
        (await labels.read(36, saved.authorizationId)).parcels[0].attempt,
      ).toMatchObject({ status: "succeeded", result });
      expect(
        (
          await pool.query(
            `SELECT before_status,after_status,actor FROM returns.customer_return_label_events ORDER BY id`,
          )
        ).rows,
      ).toEqual([
        { before_status: null, after_status: "executing", actor: "admin" },
        {
          before_status: "executing",
          after_status: "uncertain",
          actor: "admin",
        },
        {
          before_status: "uncertain",
          after_status: "succeeded",
          actor: "recovery-admin",
        },
      ]);
      await expect(
        pool.query(`DELETE FROM returns.customer_return_label_events`),
      ).rejects.toThrow(/append-only/);
    });
    it("paused or changed destination settings prevent a new purchase, with read access retained", async () => {
      const saved = await authorize();
      await settings.save(
        36,
        { ...(await config()), enabled: false },
        "admin",
        INTAKE_NOW,
      );
      await expect(
        labels.begin(
          36,
          saved.authorizationId,
          saved.parcels[0].parcelId,
          "admin",
          INTAKE_NOW,
        ),
      ).rejects.toMatchObject({ code: "RETURN_LABEL_SETTINGS_CHANGED" });
      expect(
        (await labels.read(36, saved.authorizationId)).parcels,
      ).toHaveLength(2);
      await settings.save(
        36,
        { ...(await config()), enabled: true },
        "admin",
        INTAKE_NOW,
      );
      expect(
        await labels.begin(
          36,
          saved.authorizationId,
          saved.parcels[0].parcelId,
          "admin",
          INTAKE_NOW,
        ),
      ).toBeTypeOf("number");
      await settings.save(
        36,
        { ...(await config()), contactName: "Another destination contact" },
        "admin",
        INTAKE_NOW,
      );
      await expect(
        labels.begin(
          36,
          saved.authorizationId,
          saved.parcels[1].parcelId,
          "admin",
          INTAKE_NOW,
        ),
      ).rejects.toMatchObject({ code: "RETURN_LABEL_SETTINGS_CHANGED" });
    });
    it("enforces shop/return/parcel ownership at read and write boundaries", async () => {
      const saved = await authorize();
      await expect(
        labels.read(37, saved.authorizationId),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        labels.begin(
          37,
          saved.authorizationId,
          saved.parcels[0].parcelId,
          "admin",
          INTAKE_NOW,
        ),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        labels.begin(36, saved.authorizationId, 99999, "admin", INTAKE_NOW),
      ).rejects.toMatchObject({ status: 404 });
    });
    it("settings saves use optimistic versions and append before/after audit", async () => {
      const input = await config();
      const results = await Promise.allSettled([
        settings.save(36, { ...input, enabled: false }, "admin:a", INTAKE_NOW),
        settings.save(36, { ...input, enabled: false }, "admin:b", INTAKE_NOW),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect((await settings.read(36))!.version).toBe(2);
      const event = (
        await pool.query(
          `SELECT before_snapshot,after_snapshot FROM returns.customer_return_settings_events`,
        )
      ).rows[0];
      expect(event.before_snapshot.enabled).toBe(true);
      expect(event.after_snapshot.enabled).toBe(false);
      await expect(
        pool.query(
          `UPDATE returns.customer_return_settings_events SET actor='changed'`,
        ),
      ).rejects.toThrow(/append-only/);
    });
    it("new command acquisition persists exact input, and live lease prevents concurrent preparation", async () => {
      const input = { ...(await request()), idempotencyKey: secondKey };
      const hash = customerReturnSubmissionHash(input);
      const acquire = {
        channelId: 36,
        key: secondKey,
        request: input,
        hash,
        actor: "admin:test",
        token: secondLease,
        now: INTAKE_NOW,
      };
      const results = await Promise.allSettled([
        commands.acquire(acquire),
        commands.acquire(acquire),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect((await commands.read(36, secondKey))!.request).toEqual(input);
      await expect(
        pool.query(
          `UPDATE returns.customer_return_submission_commands SET request_hash=$1 WHERE idempotency_key=$2`,
          ["f".repeat(64), secondKey],
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        commands.acquire({ ...acquire, hash: "f".repeat(64) }),
      ).rejects.toMatchObject({ code: "RETURN_LABEL_COMMAND_CONFLICT" });
    });
    it("expired command can be resumed without replacing intent and old lease cannot reject it", async () => {
      const later = new Date(INTAKE_NOW.getTime() + RETURN_SUBMISSION_LEASE_MS);
      const original = await commands.read(36, INTAKE_KEY);
      const resumed = await commands.acquire({
        channelId: 36,
        key: INTAKE_KEY,
        actor: "other-admin",
        token: secondLease,
        now: later,
      });
      expect(resumed).toMatchObject({
        leaseToken: secondLease,
        request: original!.request,
        actor: "other-admin",
      });
      await commands.reject(36, INTAKE_KEY, INTAKE_LEASE, "OLD_ERROR", later);
      expect((await commands.read(36, INTAKE_KEY))!.status).toBe("preparing");
      await commands.reject(
        36,
        INTAKE_KEY,
        secondLease,
        "VERIFIED_ERROR",
        later,
      );
      expect((await commands.read(36, INTAKE_KEY))!.status).toBe("rejected");
      expect(
        (
          await pool.query(
            `SELECT actor,after_status FROM returns.customer_return_submission_events WHERE idempotency_key=$1 ORDER BY id`,
            [INTAKE_KEY],
          )
        ).rows,
      ).toEqual([
        { actor: "admin:test", after_status: "preparing" },
        { actor: "other-admin", after_status: "preparing" },
        { actor: "other-admin", after_status: "rejected" },
      ]);
    });
    it("accepted return replays without leasing again and can never be rejected", async () => {
      const saved = await authorize();
      await commands.reject(
        36,
        INTAKE_KEY,
        INTAKE_LEASE,
        "STALE_ERROR",
        INTAKE_NOW,
      );
      expect(
        await commands.acquire({
          channelId: 36,
          key: INTAKE_KEY,
          actor: "other",
          token: secondLease,
          now: INTAKE_NOW,
        }),
      ).toMatchObject({
        status: "accepted",
        authorizationId: saved.authorizationId,
      });
    });
    it("label RMA and tracking locate all exact linked receiving cases", async () => {
      const saved = await authorize();
      const parcel = saved.parcels[0];
      const attempt = (await labels.begin(
        36,
        saved.authorizationId,
        parcel.parcelId,
        "admin",
        INTAKE_NOW,
      ))!;
      await labels.finish(
        attempt,
        {
          status: "succeeded",
          result: record(parcel.providerExternalShipmentId),
        },
        "admin",
        INTAKE_NOW,
      );
      for (const search of [saved.authorizationNumber, "TESTTRACK"]) {
        const results = await pool.query(
          `SELECT rc.id::int FROM returns.return_cases rc
        LEFT JOIN LATERAL (${CUSTOMER_RETURN_LABEL_SEARCH_SQL}) portal ON true
        WHERE CONCAT_WS(' ',portal.authorization_number,portal.tracking_numbers) ILIKE '%' || $1 || '%' ORDER BY rc.id`,
          [search],
        );
        expect(results.rows.map((row) => row.id)).toEqual(
          saved.cases.map((row) => row.caseId).sort((a, b) => a - b),
        );
      }
    });
  },
);
