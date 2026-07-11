import type { ControlTowerSourceAdapter, QueryClient } from "./control-tower-v2.domain";
import {
  previewControlTowerSource,
  runControlTowerSourceProjection,
  type ProjectionPersistenceSummary,
} from "./control-tower-v2.repository";
import { CONTROL_TOWER_SOURCE_ADAPTERS } from "./control-tower-v2.sources";

export interface ControlTowerProjectionJobResult {
  mode: "dry-run" | "execute";
  startedAt: string;
  completedAt: string;
  sources: Array<
    | ProjectionPersistenceSummary
    | {
      sourceName: string;
      status: "preview" | "failed";
      completeScan: boolean;
      rowsScanned: number;
      rowsValid: number;
      rowsFailed: number;
      sourceWatermark: string | null;
      errors: Array<{ sourceKey: string | null; message: string }>;
      error?: string;
    }
  >;
  failedSources: number;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
}

export async function runControlTowerProjectionJob(params: {
  client: QueryClient;
  execute: boolean;
  adapters?: readonly ControlTowerSourceAdapter<Record<string, unknown>>[];
  clock?: () => Date;
}): Promise<ControlTowerProjectionJobResult> {
  const clock = params.clock ?? (() => new Date());
  const adapters = params.adapters ?? CONTROL_TOWER_SOURCE_ADAPTERS;
  const startedAt = clock().toISOString();
  const sources: ControlTowerProjectionJobResult["sources"] = [];
  let failedSources = 0;

  for (const adapter of adapters) {
    try {
      if (params.execute) {
        const result = await runControlTowerSourceProjection({
          client: params.client,
          adapter,
          clock,
        });
        sources.push(result);
        if (result.status === "partial" || result.status === "failed") failedSources += 1;
      } else {
        const preview = await previewControlTowerSource({ client: params.client, adapter, now: clock() });
        sources.push({
          sourceName: adapter.name,
          status: "preview",
          completeScan: preview.completeScan,
          rowsScanned: preview.rowsScanned,
          rowsValid: preview.rowsValid,
          rowsFailed: preview.rowsFailed,
          sourceWatermark: preview.sourceWatermark,
          errors: preview.errors,
        });
        if (!preview.completeScan) failedSources += 1;
      }
    } catch (error) {
      failedSources += 1;
      sources.push({
        sourceName: adapter.name,
        status: "failed",
        completeScan: false,
        rowsScanned: 0,
        rowsValid: 0,
        rowsFailed: 1,
        sourceWatermark: null,
        errors: [],
        error: errorMessage(error),
      });
    }
  }

  return {
    mode: params.execute ? "execute" : "dry-run",
    startedAt,
    completedAt: clock().toISOString(),
    sources,
    failedSources,
  };
}
