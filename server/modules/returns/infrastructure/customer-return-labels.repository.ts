import type { Pool, PoolClient } from "pg";
import Decimal from "decimal.js";
import { z } from "zod";
import { customerReturnDimensionsSchema } from "@shared/returns/customer-return-parcel";
import {
  DIMENSION_INCH_DECIMAL_PLACES,
  MILLIMETERS_PER_INCH,
} from "@shared/shipping/dimensions";
import {
  returnLabelInputSchema,
  returnLabelRecordSchema,
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
  constructor(private readonly pool: Pool) {}

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
        const preparedInput = returnLabelInputSchema.parse({
          externalShipmentId: row.provider_external_shipment_id,
          rmaNumber: row.authorization_number,
          carrierId: row.carrier_id,
          serviceCode: row.service_code,
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
        // Recovery must verify the request actually sent, including its original
        // measurement precision, even after a subsequent application deployment.
        const input =
          row.attempt_id === null
            ? preparedInput
            : returnLabelInputSchema.parse(row.request_snapshot);
        if (
          input.externalShipmentId !== preparedInput.externalShipmentId ||
          input.rmaNumber !== preparedInput.rmaNumber ||
          input.carrierId !== preparedInput.carrierId ||
          input.serviceCode !== preparedInput.serviceCode ||
          input.parcel.weightGrams !== preparedInput.parcel.weightGrams ||
          !equalJson(input.shipFrom, preparedInput.shipFrom) ||
          !equalJson(input.shipTo, preparedInput.shipTo)
        )
          throw new CustomerReturnIntakeError(
            "RETURN_LABEL_ATTEMPT_UNVERIFIED",
            "The saved label request needs administrator verification.",
            503,
          );
        return {
          id: id.parse(row.id),
          number: id.parse(row.parcel_key),
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

  async begin(
    channelId: number,
    authorizationId: number,
    parcelId: number,
    actor: string,
    now: Date,
  ): Promise<number | null> {
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
        settings.carrier_id !== parcel.carrier_id ||
        settings.service_code !== parcel.service_code ||
        settings.warehouse_id !== parcel.warehouse_snapshot.warehouseId ||
        !equalJson(settings.destination_address, parcel.destination_address)
      )
        throw new CustomerReturnIntakeError(
          "RETURN_LABEL_SETTINGS_CHANGED",
          "Label creation is paused or the return settings changed.",
        );
      const stored = await this.readWith(client, channelId, authorizationId);
      const input = stored.parcels.find((row) => row.id === parcelId)!.input;
      const inserted = await client.query(
        `INSERT INTO returns.customer_return_label_attempts
        (parcel_id,attempt_number,idempotency_key,status,request_snapshot,actor,started_at)
        VALUES($1,1,$2,'executing',$3::jsonb,$4,$5) RETURNING id`,
        [
          parcelId,
          `return-label:${parcelId}:1`,
          JSON.stringify(input),
          actor,
          now,
        ],
      );
      const attemptId = id.parse(inserted.rows[0].id);
      await audit(client, attemptId, null, "executing", null, actor, now);
      return attemptId;
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
