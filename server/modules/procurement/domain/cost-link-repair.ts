import type { CostLinkOperation } from "@shared/procurement/cost-link-repair";
import {
  CostEvidenceError,
  costInteger,
} from "../../inventory/infrastructure/cost-evidence-values";

export interface CostLinkLot {
  id: number;
  number: string;
  variantId: number;
  productId: number;
  locationId: number;
  received: number;
  onHand: number;
  createdAt: string;
  sku: string;
  catalogPieces: number;
}
export interface CostLinkMovement {
  id: number;
  kind: string;
  variantId: number;
  productId: number;
  lotId: number | null;
  quantity: number;
  from: number | null;
  to: number | null;
  occurredAt: string;
  countId: number | null;
  countApproved: boolean;
  receiptLineId: number | null;
  voided: boolean;
  notes: string;
}
export interface CostLinkEdge {
  source: number;
  output: number;
  sourceUnits: number;
  outputUnits: number;
  outputStart: number;
  key: string;
}
export interface CostLinkHistory {
  lots: CostLinkLot[];
  movements: CostLinkMovement[];
  edges: CostLinkEdge[];
  orderQuantities: Array<{ lotId: number; quantity: number }>;
  originLotIds: number[];
}
export interface CostLinkRoot {
  lotId: number;
  receiptLineId: number;
  piecesPerUnit: number;
}

/** Candidates are NOT proof of a historical relationship. Only an administrator's
 * reviewed approval makes these explicit cost links. Matching is deliberately
 * bounded to recorded operations with exact quantities, product and locations;
 * ambiguous sources are left for review, never assigned by FIFO or SKU alone. */
export function proposeCostLinks(
  history: CostLinkHistory,
  roots: readonly CostLinkRoot[],
) {
  const lots = new Map(history.lots.map((lot) => [lot.id, lot]));
  const known = new Map(roots.map((root) => [root.lotId, root.piecesPerUnit]));
  const incoming = new Set([
    ...history.originLotIds,
    ...history.edges.map((edge) => edge.output),
  ]);
  const spent = new Map<number, number>();
  const existingOperations = new Set<string>();
  for (const edge of history.edges) {
    const key = `${edge.source}:${edge.key}`;
    if (!existingOperations.has(key))
      spent.set(edge.source, (spent.get(edge.source) ?? 0) + edge.sourceUnits);
    existingOperations.add(key);
  }
  for (const row of history.orderQuantities)
    spent.set(row.lotId, (spent.get(row.lotId) ?? 0) + row.quantity);
  const inputsByOutput = new Map<number, CostLinkEdge[]>();
  for (const edge of history.edges) {
    const inputs = inputsByOutput.get(edge.output) ?? [];
    inputs.push(edge);
    inputsByOutput.set(edge.output, inputs);
  }
  function expandKnown() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [outputId, inputs] of inputsByOutput) {
        if (known.has(outputId)) continue;
        const edge = inputs[0];
        // A financial contribution does not prove an assembly's piece count.
        // Only same-product, single-source conversions can propagate a unit
        // basis used to propose further missing physical links.
        if (
          !known.has(edge.source) ||
          inputs.some((input) => input.source !== edge.source) ||
          lots.get(edge.source)?.productId !== lots.get(outputId)?.productId
        )
          continue;
        const pieces =
          BigInt(known.get(edge.source)!) * BigInt(edge.sourceUnits);
        if (pieces % BigInt(edge.outputUnits) !== BigInt(0)) continue;
        const piecesPerUnit = pieces / BigInt(edge.outputUnits);
        if (
          inputs.some(
            (input) =>
              BigInt(known.get(input.source)!) * BigInt(input.sourceUnits) !==
              piecesPerUnit * BigInt(input.outputUnits),
          )
        )
          continue;
        known.set(
          outputId,
          costInteger(piecesPerUnit.toString(), "output pieces", 1),
        );
        changed = true;
      }
    }
  }
  expandKnown();
  const operations: CostLinkOperation[] = [];
  const issues: string[] = [];
  const usedMovements = new Set<number>();
  const time = (value: string) => new Date(value).getTime();
  const ordered = [...history.movements].sort(
    (a, b) => time(a.occurredAt) - time(b.occurredAt) || a.id - b.id,
  );
  const outputFor = (move: CostLinkMovement) =>
    history.lots.filter(
      (lot) =>
        !incoming.has(lot.id) &&
        lot.productId === move.productId &&
        lot.variantId === move.variantId &&
        lot.locationId === move.to &&
        lot.received === move.quantity &&
        lot.createdAt === move.occurredAt &&
        (move.lotId === null || move.lotId === lot.id),
    );
  for (const move of ordered) {
    if (move.voided || usedMovements.has(move.id) || move.from === null)
      continue;
    const transfer =
      move.kind === "transfer" && move.quantity > 0 && move.to !== null;
    const conversion =
      move.quantity < 0 &&
      (move.kind === "break" ||
        move.notes.startsWith("Case break:") ||
        (move.countId !== null && move.countApproved));
    if (!transfer && !conversion) continue;
    const quantity = Math.abs(move.quantity);
    const sources = history.lots.filter(
      (lot) =>
        lot.productId === move.productId &&
        lot.variantId === move.variantId &&
        lot.locationId === move.from &&
        time(lot.createdAt) <= time(move.occurredAt) &&
        (move.lotId === null || move.lotId === lot.id) &&
        lot.received - (spent.get(lot.id) ?? 0) - lot.onHand >= quantity,
    );
    if (sources.length !== 1) {
      if (sources.length > 1)
        issues.push(
          `Movement #${move.id}: more than one source lot fits. No cost link was inferred.`,
        );
      continue;
    }
    const source = sources[0];
    // An unrelated unlinked receipt is still a competing source. Having a cost
    // link must never make one physical candidate win over another.
    if (!known.has(source.id)) continue;
    const sourcePieces = known.get(source.id)!;
    let outputMoves = transfer
      ? [move]
      : ordered.filter(
          (out) =>
            !out.voided &&
            !usedMovements.has(out.id) &&
            out.productId === move.productId &&
            out.quantity > 0 &&
            out.to !== null &&
            (move.countId !== null
              ? out.countId === move.countId && out.countApproved
              : out.occurredAt === move.occurredAt),
        );
    const candidates = outputMoves.flatMap((out) =>
      outputFor(out).length === 1
        ? [{ move: out, lot: outputFor(out)[0] }]
        : [],
    );
    if (candidates.length !== outputMoves.length || !candidates.length)
      continue;
    const outputPieces = transfer
      ? sourcePieces
      : candidates[0].lot.catalogPieces;
    if (
      candidates.some(
        (out) => out.lot.variantId !== candidates[0].lot.variantId,
      )
    )
      continue;
    const required = BigInt(quantity) * BigInt(sourcePieces);
    let actual = candidates.reduce(
      (sum, out) => sum + BigInt(out.lot.received) * BigInt(outputPieces),
      BigInt(0),
    );
    // A case break can have a separately approved count correction of its pack
    // output. Suggest it only when a SINGLE same-day adjustment exactly fills
    // the piece difference. The UI explicitly asks the admin to confirm it.
    if (!transfer && move.countId === null && actual < required) {
      const supplements = ordered.filter(
        (out) =>
          !out.voided &&
          !usedMovements.has(out.id) &&
          out.countApproved &&
          out.productId === move.productId &&
          out.countId !== null &&
          out.variantId === candidates[0].lot.variantId &&
          out.to === candidates[0].lot.locationId &&
          time(out.occurredAt) > time(move.occurredAt) &&
          out.occurredAt.slice(0, 10) === move.occurredAt.slice(0, 10) &&
          BigInt(out.quantity) * BigInt(outputPieces) === required - actual &&
          outputFor(out).length === 1,
      );
      if (supplements.length === 1) {
        candidates.push({
          move: supplements[0],
          lot: outputFor(supplements[0])[0],
        });
        outputMoves = [...outputMoves, supplements[0]];
        actual = required;
      }
    }
    if (actual !== required) {
      issues.push(
        `Movement #${move.id}: the recorded output does not account for ${required} pieces. Confirm the missing movement before linking its costs.`,
      );
      continue;
    }
    for (const out of candidates) {
      incoming.add(out.lot.id);
      known.set(out.lot.id, outputPieces);
      usedMovements.add(out.move.id);
    }
    usedMovements.add(move.id);
    spent.set(source.id, (spent.get(source.id) ?? 0) + quantity);
    operations.push({
      key: `historical_cost_link:${move.id}`,
      kind: transfer ? "transfer" : "conversion",
      occurredAt: move.occurredAt,
      sourceLotId: source.id,
      sourceLotNumber: source.number,
      sourceSku: source.sku,
      sourceUnits: quantity,
      sourcePiecesPerUnit: sourcePieces,
      movementIds: [...new Set([move.id, ...outputMoves.map((out) => out.id)])],
      description: transfer
        ? "Recorded warehouse transfer"
        : move.countId !== null
          ? "Approved count changed the case SKU"
          : candidates.length > 1
            ? "Case opened into packs; approved count completed the pack quantity"
            : "Recorded case opened into packs",
      outputs: candidates.map(({ lot }) => ({
        lotId: lot.id,
        lotNumber: lot.number,
        sku: lot.sku,
        units: lot.received,
        piecesPerUnit: outputPieces,
      })),
    });
    expandKnown();
  }
  // All existing financial descendants still belong in the cost preview,
  // including assemblies whose physical piece basis cannot be inferred above.
  const affectedLots = new Set(known.keys());
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const edge of history.edges) {
      if (affectedLots.has(edge.source) && !affectedLots.has(edge.output)) {
        affectedLots.add(edge.output);
        expanded = true;
      }
    }
  }
  // Never claim an unexplained disappearance as a sale, loss, or write-off.
  for (const id of affectedLots) {
    const lot = lots.get(id)!;
    const remaining =
      BigInt(lot.received) - BigInt(lot.onHand) - BigInt(spent.get(id) ?? 0);
    if (remaining < BigInt(0))
      throw new CostEvidenceError(
        "COST_LINK_QUANTITY_CONFLICT",
        `Recorded movements exceed the original quantity of ${lot.number}.`,
      );
    if (remaining > BigInt(0))
      issues.push(
        `${lot.number}: ${remaining} ${lot.sku} units have no linked stock or order destination. Their cost stays unassigned; no expense will be created.`,
      );
  }
  return {
    operations,
    lotIds: [...affectedLots].sort((a, b) => a - b),
    remainingIssues: issues,
  };
}
