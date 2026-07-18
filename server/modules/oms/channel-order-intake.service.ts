import { sql } from "drizzle-orm";

export type ChannelOrderObservationStatus = "observed" | "processing" | "ingested" | "failed" | "ignored";

export interface ChannelOrderObservation {
  provider: string;
  channelId?: number | null;
  externalOrderId: string;
  externalOrderNumber?: string | null;
  observationMethod: string;
  sourceDomain?: string | null;
  sourceInboxId?: number | null;
  sourceEventId?: string | null;
  rawPayload?: unknown;
  isShippable?: boolean | null;
  status?: ChannelOrderObservationStatus;
  omsOrderId?: number | null;
  lastError?: string | null;
  sourceOrderedAt?: Date | string | null;
  incrementObservation?: boolean;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
}

export function ebayOrderIsShippable(order: any): boolean {
  return Array.isArray(order?.lineItems)
    && order.lineItems.some((line: any) => Number(line?.quantity ?? 0) > 0);
}

export async function recordChannelOrderObservation(
  database: any,
  observation: ChannelOrderObservation,
): Promise<number> {
  const result = await database.execute(sql`
    SELECT oms.record_channel_order_intake(
      p_provider => ${observation.provider},
      p_external_order_id => ${observation.externalOrderId},
      p_external_order_number => ${observation.externalOrderNumber ?? observation.externalOrderId},
      p_channel_id => ${observation.channelId ?? null},
      p_observation_method => ${observation.observationMethod},
      p_source_domain => ${observation.sourceDomain ?? null},
      p_source_inbox_id => ${observation.sourceInboxId ?? null},
      p_source_event_id => ${observation.sourceEventId ?? null},
      p_raw_payload => ${observation.rawPayload === undefined ? null : JSON.stringify(observation.rawPayload)}::jsonb,
      p_is_shippable => ${observation.isShippable ?? null},
      p_status => ${observation.status ?? "observed"},
      p_oms_order_id => ${observation.omsOrderId ?? null},
      p_last_error => ${observation.lastError ?? null},
      p_source_ordered_at => ${observation.sourceOrderedAt ?? null},
      p_increment_observation => ${observation.incrementObservation ?? true}
    ) AS id
  `);
  const id = Number(result.rows?.[0]?.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Order intake ledger did not confirm ${observation.provider} order ${observation.externalOrderId}`);
  }
  return id;
}

export async function recordChannelOrderFailure(
  database: any,
  observation: Omit<ChannelOrderObservation, "status" | "lastError">,
  error: unknown,
): Promise<number> {
  return recordChannelOrderObservation(database, {
    ...observation,
    status: "failed",
    lastError: errorMessage(error),
    incrementObservation: false,
  });
}
