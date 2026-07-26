import type { Pool } from "pg";
import { pool as defaultPool } from "../../../db";
import {
  normalizeShippingQuoteEvidenceInput,
  type ShippingQuoteEvidenceInput,
  type ShippingQuoteEvidenceWriteResult,
  type ShippingQuoteEvidenceWriter,
} from "../application/shipping-quote-evidence-writer";

interface SnapshotIdRow {
  id: string | number;
}

export class PostgresShippingQuoteEvidenceWriter
implements ShippingQuoteEvidenceWriter {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async persistOnce(
    rawInput: ShippingQuoteEvidenceInput,
  ): Promise<ShippingQuoteEvidenceWriteResult> {
    const input = normalizeShippingQuoteEvidenceInput(rawInput);
    const requestPayload = {
      ...input.requestPayload,
      evidenceKind: input.evidenceKind,
      evidenceKey: input.evidenceKey,
    };
    const client = await this.dbPool.connect();
    try {
      const inserted = await client.query<SnapshotIdRow>(
        `INSERT INTO shipping.quote_snapshots
          (source, destination_country, destination_postal_code, resolved_zone,
           request_hash, request_payload, packing, rates, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          input.source,
          input.destinationCountry,
          input.destinationPostalCode,
          input.resolvedZone,
          input.requestHash,
          JSON.stringify(requestPayload),
          input.packing === null ? null : JSON.stringify(input.packing),
          input.rates === null ? null : JSON.stringify(input.rates),
          input.metadata === null ? null : JSON.stringify(input.metadata),
          input.createdAt,
        ],
      );
      const insertedId = inserted.rows[0]?.id;
      if (insertedId !== undefined) {
        return {
          snapshotId: requirePositiveSafeInteger(insertedId),
          created: true,
        };
      }

      const existing = await client.query<SnapshotIdRow>(
        `SELECT id
         FROM shipping.quote_snapshots
         WHERE source = $1
           AND request_payload->>'evidenceKind' = $2
           AND request_payload->>'evidenceKey' = $3
         LIMIT 1`,
        [input.source, input.evidenceKind, input.evidenceKey],
      );
      const existingId = existing.rows[0]?.id;
      if (existingId === undefined) {
        throw new Error(
          "Shipping quote evidence insert conflicted but the existing snapshot could not be loaded.",
        );
      }
      return {
        snapshotId: requirePositiveSafeInteger(existingId),
        created: false,
      };
    } finally {
      client.release();
    }
  }
}

function requirePositiveSafeInteger(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("Shipping quote evidence snapshot ID is invalid.");
  }
  return parsed;
}
