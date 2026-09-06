import {
  workConfigurationSchema, type WorkConfiguration, type WorkContextRequest,
  type WorkContextPreview, type SaveWorkConfiguration,
} from "@shared/warehouse-work";

export class WarehouseWorkError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly context: Record<string, unknown> = {},
  ) { super(message); this.name = "WarehouseWorkError"; }
}

export interface WorkLocation { id: number; code: string; zone: string | null; active: boolean }
export interface WorkEmployee { id: string; name: string; active: boolean }
export interface WorkActor { id: string; active: boolean; permissions: string[] }

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export function canonicalConfiguration(input: WorkConfiguration): WorkConfiguration {
  const config = workConfigurationSchema.parse(input); // Deep copy; never mutate caller input.
  config.stations.sort((a, b) => compare(a.id, b.id));
  config.access.sort((a, b) => compare(a.userId, b.userId));
  for (const station of config.stations) station.capabilities.sort(compare);
  for (const access of config.access) {
    access.capabilities.sort(compare);
    if (access.scope.kind === "stations") access.scope.stationIds.sort(compare);
  }
  return config;
}

export function canonicalCommand(command: SaveWorkConfiguration): SaveWorkConfiguration {
  return { ...command, configuration: canonicalConfiguration(command.configuration) };
}

export function requireWorkPermission(actor: WorkActor, action: string): void {
  if (!actor.active || !actor.permissions.includes(`warehouse_work:${action}`)) {
    throw new WarehouseWorkError("WORK_PERMISSION_DENIED", "Warehouse work permission denied", 403, { action });
  }
}

export function validateConfigurationReferences(
  next: WorkConfiguration,
  previous: WorkConfiguration,
  locations: readonly WorkLocation[],
  employees: readonly WorkEmployee[],
): void {
  const locationMap = new Map(locations.map((location) => [location.id, location]));
  const employeeMap = new Map(employees.map((employee) => [employee.id, employee]));
  const stationMap = new Map(next.stations.map((station) => [station.id, station]));
  for (const old of previous.stations) {
    if (!stationMap.has(old.id)) {
      throw new WarehouseWorkError("WORK_STATION_RETIRE_REQUIRED", "Disable existing stations; do not delete their identity", 409, { stationId: old.id });
    }
  }
  for (const station of next.stations) {
    const location = locationMap.get(station.locationId);
    if (!location || (station.enabled && !location.active)) {
      throw new WarehouseWorkError("WORK_LOCATION_INVALID", "An enabled station needs an active location in this warehouse", 422, { stationId: station.id });
    }
  }
  for (const access of next.access) {
    if (!employeeMap.get(access.userId)?.active) {
      throw new WarehouseWorkError("WORK_EMPLOYEE_INVALID", "Remove scopes for inactive or unknown employees", 422, { userId: access.userId });
    }
    const scope = access.scope;
    if (scope.kind === "zone" && !locations.some((location) => location.active && location.zone === scope.zone)) {
      throw new WarehouseWorkError("WORK_ZONE_INVALID", "Scope must reference an active location zone in this warehouse", 422);
    }
  }
}

/** Eligibility preview only. Even an eligible draft NEVER authorizes execution. */
export function previewWorkContext(
  configuration: WorkConfiguration,
  revision: number,
  actor: WorkActor,
  request: WorkContextRequest,
  locations: readonly WorkLocation[],
): WorkContextPreview {
  const result = (reason: WorkContextPreview["reason"]): WorkContextPreview => ({
    eligible: reason === "eligible", reason, revision, executionAllowed: false,
  });
  if (!actor.active) return result("inactive_user");
  if (!actor.permissions.includes(`warehouse_work:${request.capability}`)) return result("missing_permission");
  const location = locations.find((row) => row.id === request.locationId && row.active);
  if (!location) return result("invalid_location");
  const station = request.stationId === null ? null : configuration.stations.find((row) => row.id === request.stationId);
  if (request.stationId !== null && (!station?.enabled || station.locationId !== location.id)) return result("invalid_station");
  if (station && !station.capabilities.includes(request.capability)) return result("station_capability_missing");
  const access = configuration.access.find((row) => row.userId === actor.id);
  if (!access || !access.capabilities.includes(request.capability)) return result("missing_scope");
  if (access.scope.kind === "zone" && access.scope.zone !== location.zone) return result("outside_scope");
  if (access.scope.kind === "stations" && (!station || !access.scope.stationIds.includes(station.id))) return result("outside_scope");
  return result("eligible");
}
