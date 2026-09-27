import type { Pool, PoolClient } from "pg";
import Decimal from "decimal.js";
import { z } from "zod";
import { customerReturnDimensionsSchema } from "@shared/returns/customer-return-parcel";
import { customerReturnLabelSettingsSchema } from "@shared/returns/customer-return-label.contract";
import { isReturnCarrierServiceAllowed } from "@shared/returns/customer-return-carrier-policy";
import { returnRateShipmentSchema } from "../../shipping-engine/application/return-rate-provider.port";
import { selectCustomerReturnRate } from "../domain/customer-return-rate-selection";
import {
  customerReturnQuoteDecisionSchema,
  customerReturnShipmentHash,
  type CustomerReturnQuoteDecision,
} from "../application/customer-return-label-quote";
import {
  DIMENSION_INCH_DECIMAL_PLACES,
  MILLIMETERS_PER_INCH,
} from "@shared/shipping/dimensions";
import {
  returnLabelInputSchema,
  returnLabelRecordSchema,
  type ReturnLabelInput,
} from "../../shipping-engine/application/return-label-provider.port";
import type {
  CustomerReturnLabelStore,
  StoredReturnLabels,
} from "../application/customer-return-labels.service";
import { CustomerReturnIntakeError } from "../application/customer-return-intake.ports";

const id = z.coerce.number().int().positive().safe();
const Exact = Decimal.clone({ precision: 40 });
export class PostgresCustomerReturnLabelStore
  implements CustomerReturnLabelStore
{
  constructor(
    private readonly pool: Pool,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async read(
    channelId: number,
    authorizationId: number,
  ): Promise<StoredReturnLabels> {
    return this.readWith(this.pool, channelId, authorizationId);
  }
  private async readWith(
    connection: Pick<PoolClient, "query">,
    channelId: number,
    authorizationId: number,
  ): Promise<StoredReturnLabels> {
    const { rows } = await connection.query(
      `SELECT a.authorization_number,p.*,t.id AS attempt_id,t.status AS attempt_status,
      t.started_at,t.result_snapshot,t.request_snapshot FROM returns.customer_return_authorizations a
      JOIN returns.customer_return_parcels p ON p.authorization_id=a.id
      LEFT JOIN LATERAL (SELECT * FROM returns.customer_return_label_attempts WHERE parcel_id=p.id ORDER BY attempt_number DESC LIMIT 1) t ON true
      WHERE a.channel_id=$1 AND a.id=$2 ORDER BY p.parcel_key::integer,p.id`,
      [channelId, authorizationId],
    );
    if (!rows.length)
      throw new CustomerReturnIntakeError(
        "RETURN_LABEL_NOT_FOUND",
        "This return could not be found.",
        404,
      );
    return {
      channelId,
      authorizationId,
      authorizationNumber: z
        .string()
        .min(1)
        .max(32)
        .parse(rows[0].authorization_number),
      parcels: rows.map((row) => {
        const dims = customerReturnDimensionsSchema.parse(row.dimensions);
        const selectionMode = z
          .enum(["fixed_service", "cheapest_eligible"])
          .parse(row.selection_mode);
        const shipment = returnRateShipmentSchema.parse({
          externalShipmentId: row.provider_external_shipment_id,
          rmaNumber: row.authorization_number,
          shipFrom: row.origin_address,
          shipTo: row.destination_address,
          parcel: {
            weightGrams: id.parse(row.weight_grams),
            dimensionsInches: {
              length: providerInches(dims.lengthMm),
              width: providerInches(dims.widthMm),
              height: providerInches(dims.heightMm),
            },
          },
        });
        const preparedInput =
          selectionMode === "fixed_service"
            ? returnLabelInputSchema.parse({
                ...shipment,
                carrierId: row.carrier_id,
                serviceCode: row.service_code,
              })
            : null;
        // Recovery must verify the request actually sent, including its original
        // measurement precision, even after a subsequent application deployment.
        const input =
          row.attempt_id === null
            ? preparedInput
            : returnLabelInputSchema.parse(row.request_snapshot);
        if (
          input &&
          (input.externalShipmentId !== shipment.externalShipmentId ||
            input.rmaNumber !== shipment.rmaNumber ||
            (preparedInput !== null &&
              (input.carrierId !== preparedInput.carrierId ||
                input.serviceCode !== preparedInput.serviceCode)) ||
            input.parcel.weightGrams !== shipment.parcel.weightGrams ||
            !equalJson(input.shipFrom, shipment.shipFrom) ||
            !equalJson(input.shipTo, shipment.shipTo))
        )
          throw new CustomerReturnIntakeError(
            "RETURN_LABEL_ATTEMPT_UNVERIFIED",
            "The saved label request needs administrator verification.",
            503,
          );
        return {
          id: id.parse(row.id),
          number: id.parse(row.parcel_key),
          selectionMode,
          shipment,
          input,
          attempt:
            row.attempt_id === null
              ? null
              : {
                  id: id.parse(row.attempt_id),
                  status: z
                    .enum(["executing", "succeeded", "failed", "uncertain"])
                    .parse(row.attempt_status),
                  startedAt: z.coerce.date().parse(row.started_at),
                  result: row.result_snapshot
                    ? returnLabelRecordSchema.parse(row.result_snapshot)
                    : null,
                },
        };
      }),
    };
  }

  async recordQuote(
    channelId: number,
    authorizationId: number,
    parcelId: number,
    raw: CustomerReturnQuoteDecision,
    actor: string,
    now: Date,
  ): Promise<number> {
    const decision = customerReturnQuoteDecisionSchema.parse(raw);
    z.string().trim().min(1).max(255).parse(actor);
    z.date().parse(now);
    const parcel = (await this.read(channelId, authorizationId)).parcels.find(
      (row) => row.id === parcelId,
    );
    if (
      !parcel ||
      parcel.selectionMode !== "cheapest_eligible" ||
      customerReturnShipmentHash(parcel.shipment) !== decision.shipmentHash ||
      Date.parse(decision.quotedAt) > now.getTime()
    )
      throw quoteChanged();
    if (
      decision.selected &&
      JSON.stringify(
        selectCustomerReturnRate({
          policy: decision.settings,
          weightGrams: parcel.shipment.parcel.weightGrams,
          result: decision.result!,
        }).selected,
      ) !== JSON.stringify(decision.selected)
    )
      throw quoteChanged();
    const inserted = await this.pool.query(
      `INSERT INTO returns.customer_return_quote_decisions
      (parcel_id,settings_version,settings_snapshot,shipment_snapshot,shipment_hash,quote_result,selected_rate,status,error_code,
        quoted_at,expires_at,actor,created_at) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        parcelId,
        decision.settings.version,
        JSON.stringify(decision.settings),
        JSON.stringify(decision.shipment),
        decision.shipmentHash,
        decision.result === null ? null : JSON.stringify(decision.result),
        decision.selected === null ? null : JSON.stringify(decision.selected),
        decision.selected === null ? "failed" : "selected",
        decision.errorCode,
        new Date(decision.quotedAt),
        new Date(decision.expiresAt),
        actor,
        now,
      ],
    );
    return id.parse(inserted.rows[0].id);
  }

  async begin(
    channelId: number,
    authorizationId: number,
    parcelId: number,
    actor: string,
    now: Date,
    quoteDecisionId?: number,
  ): Promise<{ id: number; input: ReturnLabelInput } | null> {
    z.string().trim().min(1).max(255).parse(actor);
    z.date().parse(now);
    return this.transaction(async (client) => {
      const { rows: parcels } = await client.query(
        `SELECT p.*,a.warehouse_snapshot FROM returns.customer_return_parcels p
        JOIN returns.customer_return_authorizations a ON a.id=p.authorization_id
        WHERE a.channel_id=$1 AND a.id=$2 AND p.id=$3 FOR UPDATE OF p`,
        [channelId, authorizationId, parcelId],
      );
      const parcel = parcels[0];
      if (!parcel)
        throw new CustomerReturnIntakeError(
          "RETURN_LABEL_NOT_FOUND",
          "This return could not be found.",
          404,
        );
      const existing = await client.query(
        `SELECT id FROM returns.customer_return_label_attempts WHERE parcel_id=$1 LIMIT 1`,
        [parcelId],
      );
      if (existing.rowCount) return null;
      const settings = (
        await client.query(
          `SELECT * FROM returns.customer_return_settings WHERE channel_id=$1 FOR SHARE`,
          [channelId],
        )
      ).rows[0];
      // Serialize the purchase boundary with an administrator pause/configuration change.
      if (
        !settings?.enabled ||
        settings.warehouse_id !== parcel.warehouse_snapshot.warehouseId ||
        !equalJson(settings.destination_address, parcel.destination_address)
      )
        throw new CustomerReturnIntakeError(
          "RETURN_LABEL_SETTINGS_CHANGED",
          "Label creation is paused or the return settings changed.",
        );
      const stored = await this.readWith(client, channelId, authorizationId);
      const storedParcel = stored.parcels.find((row) => row.id === parcelId)!;
      const current = settingsFromRow(settings);
      let input = storedParcel.input;
      // The execution/recovery window starts after acquiring the purchase locks,
      // including fixed-service requests that did not need a fresh rate quote.
      let purchaseNow = z.date().parse(this.clock());
      if (storedParcel.selectionMode === "fixed_service") {
        if (
          quoteDecisionId !== undefined ||
          !input ||
          !isReturnCarrierServiceAllowed(
            current,
            input.carrierId,
            input.serviceCode,
            input.parcel.weightGrams,
          )
        )
          throw quoteChanged();
      } else {
        if (quoteDecisionId === undefined) throw quoteChanged();
        const row = (
          await client.query(
            `SELECT * FROM returns.customer_return_quote_decisions WHERE id=$1 AND parcel_id=$2`,
            [id.parse(quoteDecisionId), parcelId],
          )
        ).rows[0];
        if (
          !row ||
          row.status !== "selected" ||
          Number(row.settings_version) !== current.version
        )
          throw quoteChanged();
        const decision = customerReturnQuoteDecisionSchema.parse({
          settings: row.settings_snapshot,
          shipment: row.shipment_snapshot,
          shipmentHash: row.shipment_hash,
          result: row.quote_result,
          selected: row.selected_rate,
          errorCode: row.error_code,
          quotedAt: z.coerce.date().parse(row.quoted_at).toISOString(),
          expiresAt: z.coerce.date().parse(row.expires_at).toISOString(),
        });
        // A quote can expire while waiting for another administrator's settings
        // or parcel lock. Read the injected clock only after those locks exist.
        purchaseNow = z.date().parse(this.clock());
        if (
          JSON.stringify(decision.settings) !== JSON.stringify(current) ||
          purchaseNow.getTime() < Date.parse(decision.quotedAt) ||
          purchaseNow.getTime() >= Date.parse(decision.expiresAt) ||
          decision.shipmentHash !==
            customerReturnShipmentHash(storedParcel.shipment)
        )
          throw quoteChanged();
        const selected = selectCustomerReturnRate({
          policy: current,
          weightGrams: storedParcel.shipment.parcel.weightGrams,
          result: decision.result!,
        }).selected;
        if (JSON.stringify(selected) !== JSON.stringify(decision.selected))
          throw quoteChanged();
        input = returnLabelInputSchema.parse({
          ...decision.shipment,
          carrierId: selected.carrierId,
          serviceCode: selected.serviceCode,
        });
      }
      if (!input) throw quoteChanged();
      const inserted = await client.query(
        `INSERT INTO returns.customer_return_label_attempts
        (parcel_id,attempt_number,idempotency_key,status,request_snapshot,actor,started_at,quote_decision_id)
        VALUES($1,1,$2,'executing',$3::jsonb,$4,$5,$6) RETURNING id`,
        [
          parcelId,
          `return-label:${parcelId}:1`,
          JSON.stringify(input),
          actor,
          purchaseNow,
          quoteDecisionId ?? null,
        ],
      );
      const attemptId = id.parse(inserted.rows[0].id);
      await audit(
        client,
        attemptId,
        null,
        "executing",
        null,
        actor,
        purchaseNow,
      );
      return { id: attemptId, input };
    });
  }
  async finish(
    attemptId: number,
    outcome: Parameters<CustomerReturnLabelStore["finish"]>[1],
    actor: string,
    now: Date,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const before = (
        await client.query(
          `SELECT status,result_snapshot FROM returns.customer_return_label_attempts WHERE id=$1 FOR UPDATE`,
          [attemptId],
        )
      ).rows[0];
      if (!before)
        throw new CustomerReturnIntakeError(
          "RETURN_LABEL_ATTEMPT_MISSING",
          "The label attempt needs administrator attention.",
          503,
        );
      if (before.status === "succeeded" || before.status === "failed") return;
      const result =
        outcome.status === "succeeded"
          ? returnLabelRecordSchema.parse(outcome.result)
          : null;
      const code =
        outcome.status === "succeeded"
          ? null
          : z
              .string()
              .regex(/^[A-Z0-9_]+$/)
              .max(100)
              .parse(outcome.code);
      await client.query(
        `UPDATE returns.customer_return_label_attempts SET status=$2,result_snapshot=$3::jsonb,error_code=$4,
        completed_at=$5 WHERE id=$1`,
        [
          attemptId,
          outcome.status,
          result ? JSON.stringify(result) : null,
          code,
          now,
        ],
      );
      await audit(
        client,
        attemptId,
        before.status,
        outcome.status,
        code,
        actor,
        now,
      );
    });
  }
  private async transaction<T>(
    run: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await run(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
function settingsFromRow(row: Record<string, unknown>) {
  return customerReturnLabelSettingsSchema.parse({
    version: row.version,
    enabled: row.enabled,
    warehouseId: row.warehouse_id,
    policyId: row.policy_id,
    selectionMode: row.selection_mode,
    carrierRules: row.carrier_rules,
    carrierId: row.carrier_id,
    serviceCode: row.service_code,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    destinationAddress: row.destination_address,
  });
}
function quoteChanged(): CustomerReturnIntakeError {
  return new CustomerReturnIntakeError(
    "RETURN_LABEL_QUOTE_CHANGED",
    "Return carrier rules or rates changed. Check the current settings and try this box again.",
  );
}
async function audit(
  client: PoolClient,
  attemptId: number,
  before: string | null,
  after: string,
  code: string | null,
  actor: string,
  now: Date,
) {
  await client.query(
    `INSERT INTO returns.customer_return_label_events(attempt_id,before_status,after_status,error_code,actor,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6)`,
    [attemptId, before, after, code, actor, now],
  );
}
function equalJson(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const keys = Object.keys(left).sort();
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}
function providerInches(millimeters: number): number {
  // Match the editor's three-decimal precision without understating the carton.
  return new Exact(millimeters)
    .div(MILLIMETERS_PER_INCH)
    .toDecimalPlaces(DIMENSION_INCH_DECIMAL_PLACES, Decimal.ROUND_CEIL)
    .toNumber();
}
