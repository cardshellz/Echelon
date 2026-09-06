import type { Pool, PoolClient } from "pg";
import {
  emptyWorkConfiguration, workRevisionSchema, saveWorkConfigurationSchema,
  type WorkRevision, type SaveWorkConfiguration,
} from "@shared/warehouse-work";
import { WarehouseWorkError, type WorkLocation } from "../domain/work-configuration";

export interface WorkWarehouse { id: number; code: string; name: string; active: boolean; type: string }
interface RevisionRow {
  warehouse_id: number; revision: number; configuration: unknown;
  actor_id: string; saved_at: Date; reason: string;
  request_body: unknown; access_changed: boolean;
}

function toRevision(row: RevisionRow): WorkRevision {
  const result = workRevisionSchema.safeParse({
    warehouseId: row.warehouse_id, revision: row.revision, configuration: row.configuration,
    executionStatus: "not_connected", savedAt: row.saved_at.toISOString(), savedBy: row.actor_id, reason: row.reason,
  });
  if (!result.success) throw new Error("Stored warehouse work revision violates its contract");
  return result.data;
}

export class WorkConfigurationRepository {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard: Error | undefined;
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch (rollbackError) {
        discard = new AggregateError([error, rollbackError], "Warehouse work rollback failed");
        throw discard;
      }
      throw error;
    } finally { client.release(discard); }
  }

  async warehouse(client: PoolClient, warehouseId: number, write: boolean): Promise<WorkWarehouse | null> {
    // Lock order for all foundation commands: warehouse -> identity -> locations ->
    // revision -> station IDs -> access user IDs. Reads use SHARE, never claim work.
    const result = await client.query<{ id: number; code: string; name: string; is_active: number; warehouse_type: string }>(
      `SELECT id, code, name, is_active, warehouse_type FROM warehouse.warehouses
       WHERE id = $1 ${write ? "FOR UPDATE" : "FOR SHARE"}`, [warehouseId],
    );
    const row = result.rows[0];
    return row ? { id: row.id, code: row.code, name: row.name, active: row.is_active === 1, type: row.warehouse_type } : null;
  }

  async locations(client: PoolClient, warehouseId: number): Promise<WorkLocation[]> {
    const result = await client.query<{ id: number; code: string; zone: string | null; is_active: number }>(`
      SELECT id, code, zone, is_active FROM warehouse.warehouse_locations
      WHERE warehouse_id = $1 ORDER BY id FOR SHARE
    `, [warehouseId]);
    return result.rows.map((row) => ({ id: row.id, code: row.code, zone: row.zone, active: row.is_active === 1 }));
  }

  async current(client: PoolClient, warehouseId: number): Promise<WorkRevision> {
    const result = await client.query<RevisionRow>(`
      SELECT * FROM warehouse.work_configuration_revisions WHERE warehouse_id = $1 ORDER BY revision DESC LIMIT 1
    `, [warehouseId]);
    return result.rows[0] ? toRevision(result.rows[0]) : {
      warehouseId, revision: 0, configuration: emptyWorkConfiguration(),
      executionStatus: "not_connected", savedAt: null, savedBy: null, reason: null,
    };
  }

  async command(client: PoolClient, warehouseId: number, commandId: string) {
    const result = await client.query<RevisionRow>(`
      SELECT * FROM warehouse.work_configuration_revisions WHERE warehouse_id = $1 AND command_id = $2
    `, [warehouseId, commandId]);
    const row = result.rows[0];
    if (!row) return null;
    const request = saveWorkConfigurationSchema.safeParse(row.request_body);
    if (!request.success) throw new Error("Stored warehouse work command violates its contract");
    return { revision: toRevision(row), request: request.data, accessChanged: row.access_changed };
  }

  async history(client: PoolClient, warehouseId: number, beforeRevision: number): Promise<WorkRevision[]> {
    const result = await client.query<RevisionRow>(`
      SELECT * FROM warehouse.work_configuration_revisions
      WHERE warehouse_id = $1 AND revision < $2 ORDER BY revision DESC LIMIT 20
    `, [warehouseId, beforeRevision]);
    return result.rows.map(toRevision);
  }

  async persist(
    client: PoolClient, previous: WorkRevision, request: SaveWorkConfiguration,
    actorId: string, savedAt: string, accessChanged: boolean,
  ): Promise<WorkRevision> {
    const revision = previous.revision + 1;
    const result = await client.query<RevisionRow>(`
      INSERT INTO warehouse.work_configuration_revisions
        (warehouse_id, revision, command_id, request_body, configuration, before_configuration, access_changed, actor_id, reason, saved_at)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10) RETURNING *
    `, [previous.warehouseId, revision, request.commandId, JSON.stringify(request), JSON.stringify(request.configuration),
      JSON.stringify(previous.configuration), accessChanged, actorId, request.reason, savedAt]);

    const stations = await client.query(`
      INSERT INTO warehouse.work_stations (id, warehouse_id, code, name, location_id, capabilities, enabled, configuration_revision)
      SELECT s.id, $1, s.code, s.name, s."locationId", s.capabilities, s.enabled, $2
      FROM jsonb_to_recordset($3::jsonb) AS s(id uuid, code text, name text, "locationId" integer, capabilities jsonb, enabled boolean)
      ORDER BY s.id
      ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name,
        location_id = EXCLUDED.location_id, capabilities = EXCLUDED.capabilities,
        enabled = EXCLUDED.enabled, configuration_revision = EXCLUDED.configuration_revision
      WHERE warehouse.work_stations.warehouse_id = EXCLUDED.warehouse_id
    `, [previous.warehouseId, revision, JSON.stringify(request.configuration.stations)]);
    if (stations.rowCount !== request.configuration.stations.length) {
      throw new WarehouseWorkError("WORK_STATION_ID_CONFLICT", "A station identity already belongs to another warehouse", 409);
    }
    // This is a current-scope projection only. Immutable revisions retain every
    // grant/revocation and its actor. No inventory reservation is released here.
    await client.query("DELETE FROM warehouse.work_access_scopes WHERE warehouse_id = $1", [previous.warehouseId]);
    await client.query(`
      INSERT INTO warehouse.work_access_scopes (warehouse_id, user_id, capabilities, scope, configuration_revision)
      SELECT $1, a."userId", a.capabilities, a.scope, $2
      FROM jsonb_to_recordset($3::jsonb) AS a("userId" varchar, capabilities jsonb, scope jsonb)
      ORDER BY a."userId"
    `, [previous.warehouseId, revision, JSON.stringify(request.configuration.access)]);
    return toRevision(result.rows[0]);
  }
}
