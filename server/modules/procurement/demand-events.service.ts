/**
 * Forward Demand Events Service — Phase 7A
 *
 * CRUD for demand events (drops, preorders, promotions, wholesale commitments)
 * plus the aggregation query the purchasing recommendation engine uses to fold
 * forward demand into reorder math.
 *
 * Integration point: `getForwardDemandByProduct()` returns total expected
 * pieces per product within a planning horizon. The reorder engine adds this
 * to the reorder point so purchasing decisions account for known future demand,
 * not just historical velocity.
 */

import { sql, eq, and, inArray, isNull } from "drizzle-orm";
import { db } from "../../db";
import {
  demandEvents,
  demandEventLines,
  type InsertDemandEvent,
  type InsertDemandEventLine,
  type DemandEvent,
  type DemandEventLine,
  type DemandEventStatus,
} from "@shared/schema/procurement.schema";

// ─── Types ─────────────────────────────────────────────────────────

export interface DemandEventWithLines extends DemandEvent {
  lines: DemandEventLine[];
}

export interface CreateDemandEventInput {
  event: InsertDemandEvent;
  lines: Omit<InsertDemandEventLine, "demandEventId">[];
}

export interface UpdateDemandEventInput {
  name?: string;
  eventType?: string;
  startDate?: string;
  endDate?: string | null;
  status?: DemandEventStatus;
  notes?: string | null;
}

export interface ForwardDemandByProduct {
  productId: number;
  totalExpectedPieces: number;
  highConfidencePieces: number;
  mediumConfidencePieces: number;
  lowConfidencePieces: number;
  eventCount: number;
}

// ─── Queries ───────────────────────────────────────────────────────

export async function listDemandEvents(filters?: {
  status?: DemandEventStatus | DemandEventStatus[];
  limit?: number;
  offset?: number;
}): Promise<{ events: DemandEvent[]; total: number }> {
  const statusFilter = filters?.status;
  const statusArr = statusFilter
    ? Array.isArray(statusFilter) ? statusFilter : [statusFilter]
    : null;
  const limit = Math.min(filters?.limit ?? 50, 200);
  const offset = filters?.offset ?? 0;

  const countResult = await db.execute(sql`
    SELECT COUNT(*)::int AS total
    FROM procurement.demand_events
    ${statusArr ? sql`WHERE status = ANY(${statusArr})` : sql``}
  `);
  const total = (countResult.rows[0] as any)?.total ?? 0;

  const rows = await db.execute(sql`
    SELECT *
    FROM procurement.demand_events
    ${statusArr ? sql`WHERE status = ANY(${statusArr})` : sql``}
    ORDER BY start_date ASC, id ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return { events: rows.rows as DemandEvent[], total };
}

export async function getDemandEventById(id: number): Promise<DemandEventWithLines | null> {
  const eventRows = await db.select().from(demandEvents).where(eq(demandEvents.id, id));
  if (eventRows.length === 0) return null;

  const lines = await db
    .select()
    .from(demandEventLines)
    .where(eq(demandEventLines.demandEventId, id));

  return { ...eventRows[0], lines };
}

export async function createDemandEvent(input: CreateDemandEventInput): Promise<DemandEventWithLines> {
  return db.transaction(async (tx) => {
    const [event] = await tx.insert(demandEvents).values(input.event).returning();

    const linesToInsert = input.lines.map((line) => ({
      ...line,
      demandEventId: event.id,
    }));

    let lines: DemandEventLine[] = [];
    if (linesToInsert.length > 0) {
      lines = await tx.insert(demandEventLines).values(linesToInsert).returning();
    }

    return { ...event, lines };
  });
}

export async function updateDemandEvent(
  id: number,
  updates: UpdateDemandEventInput,
): Promise<DemandEvent | null> {
  const setClauses: string[] = [];
  const params: any[] = [];

  if (updates.name !== undefined) {
    setClauses.push(`name = $${params.length + 1}`);
    params.push(updates.name);
  }
  if (updates.eventType !== undefined) {
    setClauses.push(`event_type = $${params.length + 1}`);
    params.push(updates.eventType);
  }
  if (updates.startDate !== undefined) {
    setClauses.push(`start_date = $${params.length + 1}`);
    params.push(updates.startDate);
  }
  if (updates.endDate !== undefined) {
    setClauses.push(`end_date = $${params.length + 1}`);
    params.push(updates.endDate);
  }
  if (updates.status !== undefined) {
    setClauses.push(`status = $${params.length + 1}`);
    params.push(updates.status);
  }
  if (updates.notes !== undefined) {
    setClauses.push(`notes = $${params.length + 1}`);
    params.push(updates.notes);
  }

  if (setClauses.length === 0) return getDemandEventById(id);

  setClauses.push("updated_at = NOW()");

  const result = await db.execute(
    sql.raw(
      `UPDATE procurement.demand_events SET ${setClauses.join(", ")} WHERE id = ${id} RETURNING *`
    ),
  );

  return (result.rows[0] as DemandEvent) ?? null;
}

export async function deleteDemandEvent(id: number): Promise<boolean> {
  const result = await db.delete(demandEvents).where(eq(demandEvents.id, id)).returning();
  return result.length > 0;
}

// ─── Line management ───────────────────────────────────────────────

export async function addDemandEventLine(
  eventId: number,
  line: Omit<InsertDemandEventLine, "demandEventId">,
): Promise<DemandEventLine> {
  const [inserted] = await db
    .insert(demandEventLines)
    .values({ ...line, demandEventId: eventId })
    .returning();
  return inserted;
}

export async function updateDemandEventLine(
  lineId: number,
  updates: { expectedPieces?: number; confidence?: string; notes?: string | null },
): Promise<DemandEventLine | null> {
  const result = await db.execute(sql`
    UPDATE procurement.demand_event_lines
    SET expected_pieces = COALESCE(${updates.expectedPieces ?? null}, expected_pieces),
        confidence = COALESCE(${updates.confidence ?? null}, confidence),
        notes = COALESCE(${updates.notes ?? null}, notes),
        updated_at = NOW()
    WHERE id = ${lineId}
    RETURNING *
  `);
  return (result.rows[0] as DemandEventLine) ?? null;
}

export async function deleteDemandEventLine(lineId: number): Promise<boolean> {
  const result = await db.delete(demandEventLines).where(eq(demandEventLines.id, lineId)).returning();
  return result.length > 0;
}

// ─── Engine integration ────────────────────────────────────────────

/**
 * Aggregate forward demand per product for the planning horizon.
 *
 * Returns total expected pieces from active/planned demand events whose
 * start_date falls within the horizon window (now → now + horizonDays).
 * The engine adds this to the reorder point.
 *
 * Confidence weighting: high=100%, medium=70%, low=40%.
 * This prevents over-ordering on speculative events while still accounting
 * for them.
 */
export async function getForwardDemandByProduct(
  horizonDays: number,
): Promise<Map<number, ForwardDemandByProduct>> {
  const result = await db.execute(sql`
    SELECT
      del.product_id,
      SUM(del.expected_pieces)::int AS total_expected_pieces,
      SUM(CASE WHEN del.confidence = 'high'   THEN del.expected_pieces ELSE 0 END)::int AS high_confidence_pieces,
      SUM(CASE WHEN del.confidence = 'medium'  THEN del.expected_pieces ELSE 0 END)::int AS medium_confidence_pieces,
      SUM(CASE WHEN del.confidence = 'low'     THEN del.expected_pieces ELSE 0 END)::int AS low_confidence_pieces,
      COUNT(DISTINCT de.id)::int AS event_count,
      SUM(
        CASE del.confidence
          WHEN 'high'   THEN del.expected_pieces
          WHEN 'medium' THEN CEIL(del.expected_pieces * 0.7)
          WHEN 'low'    THEN CEIL(del.expected_pieces * 0.4)
          ELSE 0
        END
      )::int AS weighted_pieces
    FROM procurement.demand_event_lines del
    JOIN procurement.demand_events de ON de.id = del.demand_event_id
    WHERE de.status IN ('planned', 'active')
      AND de.start_date >= CURRENT_DATE
      AND de.start_date <= CURRENT_DATE + MAKE_INTERVAL(days => ${horizonDays})
    GROUP BY del.product_id
  `);

  const map = new Map<number, ForwardDemandByProduct>();
  for (const row of result.rows as any[]) {
    map.set(Number(row.product_id), {
      productId: Number(row.product_id),
      totalExpectedPieces: Number(row.total_expected_pieces),
      highConfidencePieces: Number(row.high_confidence_pieces),
      mediumConfidencePieces: Number(row.medium_confidence_pieces),
      lowConfidencePieces: Number(row.low_confidence_pieces),
      eventCount: Number(row.event_count),
    });
  }
  return map;
}

/**
 * Inline SQL fragment for the reorder analysis query.
 * Returns weighted forward demand pieces per product_id, scoped to the
 * max planning horizon (lead time + safety stock days).
 *
 * Used as a LEFT JOIN subquery in getReorderAnalysisData().
 */
export function forwardDemandSubquery(maxHorizonDays: number) {
  return sql`
    LEFT JOIN (
      SELECT
        del.product_id,
        SUM(
          CASE del.confidence
            WHEN 'high'   THEN del.expected_pieces
            WHEN 'medium' THEN CEIL(del.expected_pieces * 0.7)
            WHEN 'low'    THEN CEIL(del.expected_pieces * 0.4)
            ELSE 0
          END
        )::bigint AS forward_demand_pieces,
        SUM(del.expected_pieces)::bigint AS forward_demand_raw_pieces,
        COUNT(DISTINCT de.id)::int AS forward_demand_event_count
      FROM procurement.demand_event_lines del
      JOIN procurement.demand_events de ON de.id = del.demand_event_id
      WHERE de.status IN ('planned', 'active')
        AND de.start_date >= CURRENT_DATE
        AND de.start_date <= CURRENT_DATE + MAKE_INTERVAL(days => ${maxHorizonDays})
      GROUP BY del.product_id
    ) fwd ON fwd.product_id = p.id
  `;
}
