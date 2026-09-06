import type { PoolClient } from "pg";
import {
  saveWorkConfigurationSchema, warehouseIdSchema, workContextRequestSchema, workSetupSchema,
  type WorkRevision, type WorkSetup,
} from "@shared/warehouse-work";
import { readWarehouseWorkActor, readWarehouseWorkEmployees } from "../../../identity";
import { WorkConfigurationRepository } from "../infrastructure/work-configuration.repository";
import {
  canonicalCommand, canonicalConfiguration, previewWorkContext, requireWorkPermission,
  validateConfigurationReferences, WarehouseWorkError, type WorkActor, type WorkEmployee,
} from "../domain/work-configuration";

interface WorkIdentityReader {
  actor(client: PoolClient, actorId: string): Promise<WorkActor>;
  employees(client: PoolClient, userIds?: readonly string[]): Promise<WorkEmployee[]>;
}
const identityReader: WorkIdentityReader = { actor: readWarehouseWorkActor, employees: readWarehouseWorkEmployees };

export class WorkConfigurationService {
  constructor(
    private readonly repository: WorkConfigurationRepository,
    private readonly clock: () => Date,
    private readonly identity: WorkIdentityReader = identityReader,
  ) {}

  private async warehouse(client: PoolClient, warehouseId: number, write: boolean) {
    const warehouse = await this.repository.warehouse(client, warehouseId, write);
    if (!warehouse) throw new WarehouseWorkError("WORK_WAREHOUSE_NOT_FOUND", "Warehouse not found", 404);
    if (!warehouse.active || !["operations", "bulk_storage"].includes(warehouse.type)) {
      throw new WarehouseWorkError("WORK_WAREHOUSE_NOT_INTERNAL", "Station workflows require an active internal warehouse; 3PLs use external fulfillment", 409);
    }
    return warehouse;
  }

  async setup(actorId: string, rawWarehouseId: unknown): Promise<WorkSetup> {
    const warehouseId = warehouseIdSchema.parse(rawWarehouseId);
    return this.repository.transaction(async (client) => {
      const warehouse = await this.warehouse(client, warehouseId, false);
      const actor = await this.identity.actor(client, actorId);
      requireWorkPermission(actor, "view");
      const employees = await this.identity.employees(client);
      const locations = await this.repository.locations(client, warehouseId);
      const revision = await this.repository.current(client, warehouseId);
      const setup = workSetupSchema.safeParse({
        warehouse: { id: warehouse.id, name: warehouse.name, code: warehouse.code },
        revision, employees, locations,
        canConfigure: actor.permissions.includes("warehouse_work:configure"),
        canManageAccess: actor.permissions.includes("warehouse_work:manage_access"),
      });
      if (!setup.success) throw new Error("Warehouse work setup violates its response contract");
      return setup.data;
    });
  }

  async save(actorId: string, rawWarehouseId: unknown, rawRequest: unknown): Promise<WorkRevision> {
    const warehouseId = warehouseIdSchema.parse(rawWarehouseId);
    const request = canonicalCommand(saveWorkConfigurationSchema.parse(rawRequest));
    return this.repository.transaction(async (client) => {
      await this.warehouse(client, warehouseId, true);
      const actor = await this.identity.actor(client, actorId);
      requireWorkPermission(actor, "view");
      requireWorkPermission(actor, "configure");
      const replay = await this.repository.command(client, warehouseId, request.commandId);
      if (replay) {
        if (replay.revision.savedBy !== actorId || JSON.stringify(canonicalCommand(replay.request)) !== JSON.stringify(request)) {
          throw new WarehouseWorkError("WORK_COMMAND_REUSED", "This command ID was already used for a different request or employee", 409);
        }
        if (replay.accessChanged) requireWorkPermission(actor, "manage_access");
        return replay.revision;
      }
      const current = await this.repository.current(client, warehouseId);
      if (current.revision !== request.expectedRevision) {
        throw new WarehouseWorkError("WORK_REVISION_CONFLICT", "The setup changed. Reload and review before saving again", 409, { currentRevision: current.revision });
      }
      const accessChanged = JSON.stringify(canonicalConfiguration(current.configuration).access) !== JSON.stringify(request.configuration.access);
      if (accessChanged) requireWorkPermission(actor, "manage_access");
      const employees = await this.identity.employees(client, request.configuration.access.map((access) => access.userId));
      const locations = await this.repository.locations(client, warehouseId);
      validateConfigurationReferences(request.configuration, current.configuration, locations, employees);
      return this.repository.persist(client, current, request, actorId, this.clock().toISOString(), accessChanged);
    });
  }

  async history(actorId: string, rawWarehouseId: unknown, beforeRevision: number): Promise<WorkRevision[]> {
    const warehouseId = warehouseIdSchema.parse(rawWarehouseId);
    const cursor = warehouseIdSchema.parse(beforeRevision);
    return this.repository.transaction(async (client) => {
      await this.warehouse(client, warehouseId, false);
      requireWorkPermission(await this.identity.actor(client, actorId), "view");
      return this.repository.history(client, warehouseId, cursor);
    });
  }

  async preview(actorId: string, rawWarehouseId: unknown, rawRequest: unknown) {
    const warehouseId = warehouseIdSchema.parse(rawWarehouseId);
    const request = workContextRequestSchema.parse(rawRequest);
    return this.repository.transaction(async (client) => {
      await this.warehouse(client, warehouseId, false);
      const actor = await this.identity.actor(client, actorId);
      const revision = await this.repository.current(client, warehouseId);
      const locations = await this.repository.locations(client, warehouseId);
      return previewWorkContext(revision.configuration, revision.revision, actor, request, locations);
    });
  }
}
