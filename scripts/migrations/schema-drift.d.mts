export const SCHEMAS_OWNED_BY_OTHER_APPLICATIONS: readonly string[];
export const DRIFT_ALERT_MAX_CHARACTERS: number;
export const DRIFT_ALERT_MAX_LISTED_OBJECTS: number;
export const DATABASE_LEVEL_GROUP: string;
export const DRIFT_KINDS: {
  readonly onlyInRepository: "only_in_repository";
  readonly onlyInProduction: "only_in_production";
  readonly different: "different";
};

export type DriftKind = (typeof DRIFT_KINDS)[keyof typeof DRIFT_KINDS];

export interface StructureObject {
  type: string;
  schema: string;
  name: string;
  definition: string;
}

export interface StructureDifference {
  schema: string;
  type: string;
  name: string;
  kind: DriftKind;
  repository: string | null;
  production: string | null;
}

export interface StructureComparison {
  identical: boolean;
  objects: { repository: number; production: number };
  differences: StructureDifference[];
}

export function parseStructureDump(dumpText: string): Map<string, StructureObject>;
export function compareStructureDumps(input: {
  repositoryDump: string;
  productionDump: string;
}): StructureComparison;
export function countDifferencesBySchema(differences: readonly StructureDifference[]): Array<{
  schema: string;
  count: number;
  ownedByAnotherApplication: boolean;
}>;
export function formatDriftAlert(input: {
  differences: readonly StructureDifference[];
  runUrl?: string | null;
}): string;
export function formatCheckFailureAlert(input: {
  code: string;
  message: string;
  runUrl?: string | null;
}): string;
