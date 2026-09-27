import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
  seedPreCarrierSelectionIntake,
} from "../support/customer-return-intake-database";
import type { ReturnLabelRecord } from "../../../shipping-engine/application/return-label-provider.port";
import { CUSTOMER_RETURN_LABEL_SEARCH_SQL } from "../../infrastructure/customer-return-label-search";
import {
  customerReturnShipmentHash,
  RETURN_RATE_QUOTE_MAX_AGE_MS,
  type CustomerReturnQuoteDecision,
} from "../../application/customer-return-label-quote";
import type { ReturnRateCandidate } from "../../../shipping-engine/application/return-rate-provider.port";
import type {
  ReturnRateProvider,
  ReturnRateResult,
} from "../../../shipping-engine/application/return-rate-provider.port";
import {
  ReturnLabelProviderError,
  type ReturnLabelProvider,
} from "../../../shipping-engine/application/return-label-provider.port";
import { CustomerReturnLabelsService } from "../../application/customer-return-labels.service";
import { CustomerReturnLabelSettingsService } from "../../application/customer-return-label-settings.service";
import { selectCustomerReturnRate } from "../../domain/customer-return-rate-selection";

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
    let clockInstant = new Date(INTAKE_NOW);
    beforeAll(async () => {
      pool = new Pool({
        connectionString: connectionString!,
        max: 8,
        connectionTimeoutMillis: 5000,
        statement_timeout: 15000,
      });
      await createIntakeTestSchema(pool);
      const database = drizzle(pool, { schema });
      labels = new PostgresCustomerReturnLabelStore(
        pool,
        () => new Date(clockInstant),
      );
      commands = new PostgresCustomerReturnSubmissionStore(pool);
      settings = new PostgresCustomerReturnSettingsStore(database);
      intake = new PostgresCustomerReturnIntakeStore(database);
    });
    beforeEach(async () => {
      clockInstant = new Date(INTAKE_NOW);
      await seedIntakeTestSchema(pool);
    });
    afterAll(async () => {
      await pool?.end();
    });
    async function authorize() {
      return intake.persist(preparedIntake());
    }
    async function enableAutomatic() {
      return settings.save(
        36,
        {
          ...(await config()),
          selectionMode: "cheapest_eligible",
          carrierId: null,
          serviceCode: null,
          carrierRules: [
            {
              carrierId: "se-123",
              serviceCodes: ["usps_ground_advantage"],
              maxWeightLb: "20",
            },
            {
              carrierId: "se-999",
              serviceCodes: ["ups_ground"],
              maxWeightLb: null,
            },
          ],
        },
        "admin",
        INTAKE_NOW,
      );
    }
    async function authorizeAutomatic(secondWeightGrams = 33) {
      const current = await enableAutomatic();
      const prepared = preparedIntake();
      prepared.settingsVersion = current.version;
      prepared.warehouseSnapshot = {
        ...prepared.warehouseSnapshot,
        version: current.version,
      };
      prepared.parcels = prepared.parcels.map((parcel) => ({
        ...parcel,
        selectionMode: "cheapest_eligible",
        carrierId: null,
        serviceCode: null,
      }));
      prepared.parcels[1].weightGrams = secondWeightGrams;
      return intake.persist(prepared);
    }
    async function quoteDecision(
      authorizationId: number,
      parcelId: number,
    ): Promise<CustomerReturnQuoteDecision> {
      const parcel = (await labels.read(36, authorizationId)).parcels.find(
        (item) => item.id === parcelId,
      )!;
      const selected: ReturnRateCandidate = {
        carrierId: "se-123",
        carrierCode: "usps",
        serviceCode: "usps_ground_advantage",
        amountCents: 400,
        currency: "USD",
        rateId: null,
        rateType: "quick",
        packageType: null,
        trackable: true,
        validationStatus: "valid",
        warningCount: 0,
        amounts: {
          shippingCents: 400,
          insuranceCents: 0,
          confirmationCents: 0,
          otherCents: 0,
        },
      };
      const current = (await settings.read(36))!;
      const result = {
        status: "completed" as const,
        rates: [
          selected,
          {
            ...selected,
            carrierId: "se-999",
            carrierCode: "ups",
            serviceCode: "ups_ground",
            amountCents: 600,
            amounts: { ...selected.amounts, shippingCents: 600 },
          },
        ],
        exclusions: [],
      };
      return {
        settings: current,
        shipment: parcel.shipment,
        shipmentHash: customerReturnShipmentHash(parcel.shipment),
        result,
        selected: selectCustomerReturnRate({
          policy: current,
          weightGrams: parcel.shipment.parcel.weightGrams,
          result,
        }).selected,
        errorCode: null,
        quotedAt: INTAKE_NOW.toISOString(),
        expiresAt: new Date(
          INTAKE_NOW.getTime() + RETURN_RATE_QUOTE_MAX_AGE_MS,
        ).toISOString(),
      };
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
    function worker(store = labels) {
      const quote = vi.fn<ReturnRateProvider["quote"]>(async (input) => ({
        status: "completed",
        exclusions: [],
        rates: [
          {
            carrierId: "se-123",
            carrierCode: "usps",
            serviceCode: "usps_ground_advantage",
            amountCents: 400,
          },
          {
            carrierId: "se-999",
            carrierCode: "ups",
            serviceCode: "ups_ground",
            amountCents: 600,
          },
        ]
          .filter((rate) => input.carrierIds.includes(rate.carrierId))
          .map((rate) => ({
            ...rate,
            currency: "USD" as const,
            rateId: null,
            rateType: "quick" as const,
            packageType: null,
            trackable: true as const,
            validationStatus: "valid" as const,
            warningCount: 0,
            amounts: {
              shippingCents: rate.amountCents,
              insuranceCents: 0,
              confirmationCents: 0,
              otherCents: 0,
            },
          })),
      }));
      const purchase = vi.fn<ReturnLabelProvider["purchase"]>(
        async (input) => ({
          ...record(input.externalShipmentId),
          carrierId: input.carrierId,
          serviceCode: input.serviceCode,
        }),
      );
      const recover = vi.fn<ReturnLabelProvider["recover"]>(async (input) => ({
        ...record(input.externalShipmentId),
        carrierId: input.carrierId,
        serviceCode: input.serviceCode,
      }));
      const configuration = new CustomerReturnLabelSettingsService({
        store: settings,
        authorizeChannel: async () => {},
        now: () => new Date(clockInstant),
        capabilities: async () => ({
          configured: true,
          carriers: [
            {
              id: "se-123",
              code: "usps",
              name: "USPS",
              services: [
                { code: "usps_ground_advantage", name: "Ground Advantage" },
              ],
            },
            {
              id: "se-999",
              code: "ups",
              name: "UPS",
              services: [{ code: "ups_ground", name: "Ground" }],
            },
          ],
        }),
      });
      const service = new CustomerReturnLabelsService({
        store,
        rates: { quote },
        provider: { purchase, recover },
        authorizeChannel: async () => {},
        now: () => new Date(clockInstant),
        requirePurchaseConfiguration: async (channelId) =>
          (
            await configuration.requireEnabled(
              channelId,
              (await settings.read(channelId))!.version,
            )
          ).settings,
      });
      return { service, quote, purchase, recover };
    }
    it("migrates already committed fixed settings, manifests and uncertain attempts without changing their original request", async () => {
      await createIntakeTestSchema(pool, { carrierSelection: false });
      await seedIntakeTestSchema(pool);
      try {
        await seedPreCarrierSelectionIntake(pool);
        const parcel = preparedIntake().parcels[0];
        // Historical precision is deliberately different from today's converter.
        const original = {
          externalShipmentId: "ecr-1-1",
          rmaNumber: "RMA-LEGACY",
          carrierId: parcel.carrierId,
          serviceCode: parcel.serviceCode,
          shipFrom: parcel.originAddress,
          shipTo: parcel.destinationAddress,
          parcel: {
            weightGrams: parcel.weightGrams,
            dimensionsInches: { length: 3.94, width: 4.73, height: 5.91 },
          },
        };
        await pool.query(
          `INSERT INTO returns.customer_return_label_attempts
          (id,parcel_id,attempt_number,idempotency_key,status,request_snapshot,error_code,actor,started_at,completed_at)
          OVERRIDING SYSTEM VALUE VALUES(1,1,1,'return-label:1:1','uncertain',$1,'RETURN_LABEL_TIMEOUT','old-admin',$2,$2)`,
          [JSON.stringify(original), INTAKE_NOW],
        );
        await pool.query(
          `INSERT INTO returns.customer_return_label_events(attempt_id,before_status,after_status,error_code,actor,occurred_at)
          VALUES(1,'executing','uncertain','RETURN_LABEL_TIMEOUT','old-admin',$1)`,
          [INTAKE_NOW],
        );
        expect(
          (
            await pool.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='returns'
          AND table_name='customer_return_parcels' AND column_name='selection_mode') AS present`)
          ).rows[0].present,
        ).toBe(false);
        await pool.query(
          readFileSync(
            "migrations/252_customer_return_carrier_selection.sql",
            "utf8",
          ),
        );
        expect(await settings.read(36)).toMatchObject({
          selectionMode: "fixed_service",
          carrierRules: [],
          carrierId: "se-123",
        });
        expect((await labels.read(36, 1)).parcels[0]).toMatchObject({
          selectionMode: "fixed_service",
          input: original,
          attempt: { id: 1, status: "uncertain" },
        });
        expect(
          await labels.begin(36, 1, 1, "new-admin", INTAKE_NOW),
        ).toBeNull();
        await labels.finish(
          1,
          { status: "succeeded", result: record(original.externalShipmentId) },
          "recovery-admin",
          INTAKE_NOW,
        );
        expect(
          (
            await pool.query(
              `SELECT request_snapshot,quote_decision_id,status FROM returns.customer_return_label_attempts`,
            )
          ).rows,
        ).toEqual([
          {
            request_snapshot: original,
            quote_decision_id: null,
            status: "succeeded",
          },
        ]);
        expect(
          (
            await pool.query(
              `SELECT COUNT(*)::int AS n FROM returns.customer_return_quote_decisions`,
            )
          ).rows[0].n,
        ).toBe(0);
      } finally {
        // Rebuild even on failure so subsequent cases never accidentally use old DDL.
        await createIntakeTestSchema(pool);
      }
    });
    it("selects each box independently across the 20-pound rule and recovers the exact saved automatic request while paused", async () => {
      const saved = await authorizeAutomatic(10_000);
      const firstWorker = worker();
      expect(
        (
          await firstWorker.service.progress(36, saved.authorizationId, "admin")
        ).parcels.map((parcel) => parcel.status),
      ).toEqual(["ready", "pending"]);
      firstWorker.purchase.mockRejectedValueOnce(
        new ReturnLabelProviderError("RETURN_LABEL_TIMEOUT", "unknown"),
      );
      expect(
        (
          await firstWorker.service.progress(36, saved.authorizationId, "admin")
        ).parcels.map((parcel) => parcel.status),
      ).toEqual(["ready", "needs_review"]);
      expect(
        firstWorker.purchase.mock.calls.map(([input]) => [
          input.carrierId,
          input.parcel.weightGrams,
        ]),
      ).toEqual([
        ["se-123", 25],
        ["se-999", 10_000],
      ]);
      expect(
        firstWorker.quote.mock.calls.map(([input]) => input.carrierIds),
      ).toEqual([["se-123", "se-999"], ["se-999"]]);
      const heavier = firstWorker.purchase.mock.calls[1][0];
      expect(
        (
          await pool.query(
            `SELECT request_snapshot FROM returns.customer_return_label_attempts ORDER BY id`,
          )
        ).rows.map((row) => row.request_snapshot),
      ).toEqual(firstWorker.purchase.mock.calls.map(([input]) => input));
      await settings.save(
        36,
        { ...(await config()), enabled: false },
        "pause-admin",
        INTAKE_NOW,
      );
      const restarted = worker(
        new PostgresCustomerReturnLabelStore(
          pool,
          () => new Date(clockInstant),
        ),
      );
      expect(
        (
          await restarted.service.progress(
            36,
            saved.authorizationId,
            "recovery-admin",
          )
        ).parcels.map((parcel) => parcel.status),
      ).toEqual(["ready", "ready"]);
      expect(restarted.recover).toHaveBeenCalledExactlyOnceWith(heavier);
      expect(restarted.quote).not.toHaveBeenCalled();
      expect(restarted.purchase).not.toHaveBeenCalled();
      await restarted.service.progress(
        36,
        saved.authorizationId,
        "recovery-admin",
      );
      expect(restarted.recover).toHaveBeenCalledTimes(1);
      expect(
        (
          await pool.query(
            `SELECT COUNT(*)::int AS n FROM returns.customer_return_quote_decisions`,
          )
        ).rows[0].n,
      ).toBe(2);
      expect(
        (
          await pool.query(
            `SELECT COUNT(*)::int AS n FROM returns.customer_return_label_attempts`,
          )
        ).rows[0].n,
      ).toBe(2);
    });
    it.each(["pause", "rules"])(
      "rejects a purchase if %s changes while the service is awaiting provider rates",
      async (change) => {
        const saved = await authorizeAutomatic();
        const currentWorker = worker();
        let release!: (result: ReturnRateResult) => void;
        let started!: () => void;
        const observing = new Promise<void>((resolve) => {
          started = resolve;
        });
        const held = new Promise<ReturnRateResult>((resolve) => {
          release = resolve;
        });
        const rateResult = (
          await quoteDecision(saved.authorizationId, saved.parcels[0].parcelId)
        ).result!;
        currentWorker.quote.mockImplementationOnce(async () => {
          started();
          return held;
        });
        const progress = currentWorker.service
          .progress(36, saved.authorizationId, "admin")
          .then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
        await observing;
        try {
          const input = await config();
          await settings.save(
            36,
            change === "pause"
              ? { ...input, enabled: false }
              : { ...input, carrierRules: input.carrierRules.slice(1) },
            "another-admin",
            INTAKE_NOW,
          );
        } finally {
          release(rateResult);
        }
        expect(await progress).toMatchObject({
          error: {
            code:
              change === "pause"
                ? "RETURN_LABEL_SETTINGS_CHANGED"
                : "RETURN_LABEL_QUOTE_CHANGED",
          },
        });
        expect(currentWorker.purchase).not.toHaveBeenCalled();
        expect(
          (
            await pool.query(
              `SELECT COUNT(*)::int AS n FROM returns.customer_return_label_attempts`,
            )
          ).rows[0].n,
        ).toBe(0);
        expect(
          (
            await pool.query(
              `SELECT settings_version,status FROM returns.customer_return_quote_decisions`,
            )
          ).rows,
        ).toEqual([{ settings_version: 2, status: "selected" }]);
      },
    );
    it("stores normalized automatic rules identically in the settings row, returned state and audit, including an unchanged pause", async () => {
      const unordered = [
        {
          carrierId: "se-999",
          serviceCodes: ["ups_saver", "ups_ground"],
          maxWeightLb: null,
        },
        {
          carrierId: "se-123",
          serviceCodes: ["usps_ground_advantage"],
          maxWeightLb: "20",
        },
      ];
      const input = {
        ...(await config()),
        selectionMode: "cheapest_eligible" as const,
        carrierId: null,
        serviceCode: null,
        carrierRules: unordered,
      };
      const saved = await settings.save(36, input, "admin", INTAKE_NOW);
      const normalized = [
        { ...unordered[1] },
        { ...unordered[0], serviceCodes: ["ups_ground", "ups_saver"] },
      ];
      expect(saved.carrierRules).toEqual(normalized);
      expect((await settings.read(36))!.carrierRules).toEqual(normalized);
      expect(
        (
          await pool.query(
            `SELECT after_snapshot FROM returns.customer_return_settings_events WHERE version=2`,
          )
        ).rows[0].after_snapshot,
      ).toEqual(saved);
      await pool.query(
        `UPDATE returns.return_policies SET status='retired' WHERE id=1`,
      );
      const paused = await settings.save(
        36,
        { ...input, expectedVersion: 2, enabled: false },
        "pause-admin",
        INTAKE_NOW,
      );
      expect(paused).toMatchObject({
        enabled: false,
        carrierRules: normalized,
        destinationAddress: saved.destinationAddress,
      });
      expect(
        (
          await pool.query(
            `SELECT after_snapshot FROM returns.customer_return_settings_events WHERE version=3`,
          )
        ).rows[0].after_snapshot,
      ).toEqual(paused);
    });
    it("uses the fresh post-lock clock for fixed purchase start and audit instead of the request time", async () => {
      const saved = await authorize();
      clockInstant = new Date(INTAKE_NOW.getTime() + 5000);
      const attempt = (await labels.begin(
        36,
        saved.authorizationId,
        saved.parcels[0].parcelId,
        "admin",
        INTAKE_NOW,
      ))!;
      const row = (
        await pool.query(
          `SELECT t.started_at,e.occurred_at FROM returns.customer_return_label_attempts t
        JOIN returns.customer_return_label_events e ON e.attempt_id=t.id WHERE t.id=$1`,
          [attempt.id],
        )
      ).rows[0];
      expect(row.started_at).toEqual(clockInstant);
      expect(row.occurred_at).toEqual(clockInstant);
    });
    it("persists automatic manifests without a carrier and atomically binds one winning quote to the durable purchase input", async () => {
      const saved = await authorizeAutomatic();
      const parcelId = saved.parcels[0].parcelId;
      expect(
        (await labels.read(36, saved.authorizationId)).parcels[0],
      ).toMatchObject({
        selectionMode: "cheapest_eligible",
        input: null,
        attempt: null,
      });
      const decision = await quoteDecision(saved.authorizationId, parcelId);
      const quoteId = await labels.recordQuote(
        36,
        saved.authorizationId,
        parcelId,
        decision,
        "admin",
        INTAKE_NOW,
      );
      const attempts = await Promise.all([
        labels.begin(
          36,
          saved.authorizationId,
          parcelId,
          "one",
          INTAKE_NOW,
          quoteId,
        ),
        labels.begin(
          36,
          saved.authorizationId,
          parcelId,
          "two",
          INTAKE_NOW,
          quoteId,
        ),
      ]);
      expect(attempts.filter(Boolean)).toHaveLength(1);
      expect(attempts.find(Boolean)?.input).toMatchObject({
        carrierId: "se-123",
        serviceCode: "usps_ground_advantage",
        parcel: { weightGrams: 25 },
      });
      expect(
        (
          await pool.query(
            `SELECT quote_decision_id::int AS quote FROM returns.customer_return_label_attempts`,
          )
        ).rows,
      ).toEqual([{ quote: quoteId }]);
      await expect(
        pool.query(
          `UPDATE returns.customer_return_quote_decisions SET selected_rate='{}'`,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        pool.query(
          `UPDATE returns.customer_return_label_attempts SET quote_decision_id=NULL`,
        ),
      ).rejects.toThrow(/immutable/);
    });
    it("records unsuccessful quotes without purchase attempts and retains immutable evidence", async () => {
      const saved = await authorizeAutomatic();
      const parcelId = saved.parcels[0].parcelId;
      const decision = {
        ...(await quoteDecision(saved.authorizationId, parcelId)),
        result: null,
        selected: null,
        errorCode: "RETURN_RATE_TIMEOUT",
      };
      const quoteId = await labels.recordQuote(
        36,
        saved.authorizationId,
        parcelId,
        decision,
        "admin",
        INTAKE_NOW,
      );
      await expect(
        labels.begin(
          36,
          saved.authorizationId,
          parcelId,
          "admin",
          INTAKE_NOW,
          quoteId,
        ),
      ).rejects.toMatchObject({ code: "RETURN_LABEL_QUOTE_CHANGED" });
      expect(
        (
          await pool.query(
            `SELECT COUNT(*)::int AS n FROM returns.customer_return_label_attempts`,
          )
        ).rows[0].n,
      ).toBe(0);
      await expect(
        pool.query(`DELETE FROM returns.customer_return_quote_decisions`),
      ).rejects.toThrow(/append-only/);
    });
    it.each(["pause", "version", "other_parcel", "expired"])(
      "rejects a %s quote at the atomic purchase boundary",
      async (kind) => {
        const saved = await authorizeAutomatic();
        const parcelId = saved.parcels[0].parcelId;
        const quoteId = await labels.recordQuote(
          36,
          saved.authorizationId,
          parcelId,
          await quoteDecision(saved.authorizationId, parcelId),
          "admin",
          INTAKE_NOW,
        );
        if (kind === "pause")
          await settings.save(
            36,
            { ...(await config()), enabled: false },
            "admin",
            INTAKE_NOW,
          );
        if (kind === "version")
          await settings.save(36, { ...(await config()) }, "admin", INTAKE_NOW);
        if (kind === "expired")
          clockInstant = new Date(
            INTAKE_NOW.getTime() + RETURN_RATE_QUOTE_MAX_AGE_MS,
          );
        await expect(
          labels.begin(
            36,
            saved.authorizationId,
            kind === "other_parcel" ? saved.parcels[1].parcelId : parcelId,
            "admin",
            INTAKE_NOW,
            quoteId,
          ),
        ).rejects.toThrow();
        expect(
          (
            await pool.query(
              `SELECT COUNT(*)::int AS n FROM returns.customer_return_label_attempts`,
            )
          ).rows[0].n,
        ).toBe(0);
      },
    );
    it("checks quote expiry after a real settings lock wait using the fresh injected clock", async () => {
      const saved = await authorizeAutomatic();
      const parcelId = saved.parcels[0].parcelId;
      const quoteId = await labels.recordQuote(
        36,
        saved.authorizationId,
        parcelId,
        await quoteDecision(saved.authorizationId, parcelId),
        "admin",
        INTAKE_NOW,
      );
      const blocker = await pool.connect();
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT 1 FROM returns.customer_return_settings WHERE channel_id=36 FOR UPDATE",
      );
      let pending:
        | Promise<{ error: unknown } | { result: unknown }>
        | undefined;
      try {
        pending = labels
          .begin(
            36,
            saved.authorizationId,
            parcelId,
            "admin",
            INTAKE_NOW,
            quoteId,
          )
          .then(
            (result) => ({ result }),
            (error) => ({ error }),
          );
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const row = (
            await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
            AND query LIKE '%customer_return_settings%') AS waiting`)
          ).rows[0];
          if (row.waiting) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        clockInstant = new Date(
          INTAKE_NOW.getTime() + RETURN_RATE_QUOTE_MAX_AGE_MS,
        );
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
      expect(await pending).toMatchObject({
        error: { code: "RETURN_LABEL_QUOTE_CHANGED" },
      });
      expect(
        (
          await pool.query(
            `SELECT COUNT(*)::int AS n FROM returns.customer_return_label_attempts`,
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it("keeps a legacy fixed parcel pinned when automatic rules still admit its service", async () => {
      const saved = await authorize();
      await enableAutomatic();
      const attempt = await labels.begin(
        36,
        saved.authorizationId,
        saved.parcels[0].parcelId,
        "admin",
        INTAKE_NOW,
      );
      expect(attempt?.input).toMatchObject({
        carrierId: "se-123",
        serviceCode: "usps_ground_advantage",
      });
      expect(
        (
          await pool.query(
            `SELECT COUNT(*)::int AS n FROM returns.customer_return_quote_decisions`,
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it("cannot insert an automatic purchase without exact quote evidence even outside the application", async () => {
      const saved = await authorizeAutomatic();
      const parcelId = saved.parcels[0].parcelId;
      const decision = await quoteDecision(saved.authorizationId, parcelId);
      await expect(
        pool.query(
          `INSERT INTO returns.customer_return_label_attempts(parcel_id,attempt_number,idempotency_key,status,request_snapshot,actor,started_at)
        VALUES($1,1,'forged','executing',$2,'admin',$3)`,
          [
            parcelId,
            JSON.stringify({
              ...decision.shipment,
              carrierId: "se-123",
              serviceCode: "usps_ground_advantage",
            }),
            INTAKE_NOW,
          ],
        ),
      ).rejects.toThrow(/requires a saved quote/);
    });
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
        attempt.id,
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
        attempt.id,
        { status: "succeeded", result },
        "recovery-admin",
        INTAKE_NOW,
      );
      await labels.finish(
        attempt.id,
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
      ).toMatchObject({
        id: expect.any(Number),
        input: { carrierId: "se-123", serviceCode: "usps_ground_advantage" },
      });
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
        attempt.id,
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
