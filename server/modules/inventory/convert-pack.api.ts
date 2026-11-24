/**
 * Single-Owner Package Conversion (`break` / `assemble`) Command Contract (`WH-1` / `CI-03`)
 *
 * Canonical domain entry point for warehouse UOM conversions (Case-Break,
 * Inline Replenishment Break, and Pack Assembly) preserving FIFO lot age,
 * PO/receipt lineage, exact component cost mills, and child variant cost rollups.
 */
import type {
  AssembleResult,
  BreakAssemblyUseCases,
  BreakResult,
} from "./application/break-assembly.use-cases";

export type BreakPackParams = Parameters<BreakAssemblyUseCases["breakVariant"]>[0];
export type AssemblePackParams = Parameters<BreakAssemblyUseCases["assembleVariant"]>[0];

export {
  BreakAssemblyUseCases,
  InventoryConversionStrategyError,
  type AssembleResult,
  type BreakResult,
  type ConversionPreview,
} from "./application/break-assembly.use-cases";

export type ConvertPackCommand =
  | ({ mode: "break" } & BreakPackParams)
  | ({ mode: "assemble" } & AssemblePackParams);

export async function convertPack(
  owner: Pick<BreakAssemblyUseCases, "breakVariant" | "assembleVariant">,
  command: ConvertPackCommand,
): Promise<BreakResult | AssembleResult> {
  if (command.mode === "break") {
    const { mode: _mode, ...params } = command;
    return owner.breakVariant(params);
  }
  const { mode: _mode, ...params } = command;
  return owner.assembleVariant(params);
}
