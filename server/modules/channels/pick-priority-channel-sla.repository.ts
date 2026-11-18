import { sql } from "drizzle-orm";
import { db } from "../../db";

export interface PickPriorityChannelSummary {
  id: number;
  name: string;
  provider: string;
  status: string;
  slaDays: number | null;
}

export async function readPickPriorityChannels(
  database: Pick<typeof db, "execute"> = db,
): Promise<PickPriorityChannelSummary[]> {
  const rows = await database.execute<{
    id: number;
    name: string | null;
    provider: string | null;
    status: string | null;
    sla_days: number | null;
  }>(sql`
    SELECT id, name, provider, status, sla_days
    FROM channels.channels
    ORDER BY (status = 'active') DESC, name
  `);

  return rows.rows.map((r) => ({
    id: Number(r.id),
    name: r.name ?? "(unnamed channel)",
    provider: r.provider ?? "manual",
    status: r.status ?? "pending_setup",
    slaDays: r.sla_days == null ? null : Number(r.sla_days),
  }));
}

export async function updateChannelPickPrioritySlaDays(
  channelId: number,
  slaDays: number | null,
  database: Pick<typeof db, "execute"> = db,
): Promise<void> {
  if (slaDays === null) {
    await database.execute(sql`
      UPDATE channels.channels
      SET sla_days = NULL, updated_at = now()
      WHERE id = ${channelId}
    `);
    return;
  }
  await database.execute(sql`
    UPDATE channels.channels
    SET sla_days = ${slaDays}, updated_at = now()
    WHERE id = ${channelId}
  `);
}
