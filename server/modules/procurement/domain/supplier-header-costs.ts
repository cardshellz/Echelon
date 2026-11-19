import {
  supplierHeaderEntriesSchema, supplierHeaderSourceSchema, supplierHeaderEvidenceSchema,
  type SupplierHeaderSource, type SupplierHeaderEntry, type SupplierHeaderShare,
  supplierHeaderEconomicShareSchema,
  supplierHeaderEligibleLines,
} from "@shared/procurement/supplier-header-costs";
import { canonicalJson } from "@shared/utils/canonical-json";
import { allocateCentsFromNumericBasis } from "./shipment-allocation-basis";
import { costFingerprint, costInteger, CostEvidenceError } from "../../inventory/infrastructure/cost-evidence-values";
import { readIntegerCents, readIntegerMills } from "@shared/money-read";
import { z } from "zod";

function reject(message: string): never {
  throw new CostEvidenceError("SUPPLIER_HEADER_ALLOCATION_REQUIRED", message);
}

/** The approved allocation rule survives ordinary quantity/price edits. Its
 * source identity binds the original header amounts and explicit parent relationships,
 * while current bases and dependencies are bound by each command's preview. */
export function supplierHeaderSourceFingerprint(input: SupplierHeaderSource): string {
  const source = supplierHeaderSourceSchema.parse(input);
  return costFingerprint({ target: source.target, expectedMills: source.expectedMills,
    facts: source.facts.map(({ label: _label, ...row }) => ({ ...row, lineIds: [...row.lineIds].sort((a, b) => a - b) })).sort((a, b) => compareKeys(a.key, b.key)),
  });
}

export function proposedSupplierHeaderEntries(input: SupplierHeaderSource): SupplierHeaderEntry[] {
  const source = supplierHeaderSourceSchema.parse(input);
  if (source.target.kind === "purchase_order") return source.facts.map(row => ({
    key: row.key, label: row.label, category: row.category, amountMills: row.amountMills,
    destination: "product", taxTypeId: null, method: "by_value", shares: [],
  }));
  if (source.expectedMills === 0) return [];
  const destination = source.lines.some(row => row.kind === "product") ? "product"
    : source.lines.some(row => row.kind === "shipment_charge") ? "landed" : "excluded";
  return [{ key: "invoice_header", label: "Amount outside invoice lines", category: source.expectedMills < 0 ? "discount" : "other",
    amountMills: source.expectedMills, destination, taxTypeId: null, method: "by_value", shares: [] }];
}

/** Classifications and shares change selected costs, never the original bill. */
export function allocateSupplierHeader(input: SupplierHeaderSource, value: unknown): SupplierHeaderShare[] {
  const source = supplierHeaderSourceSchema.parse(input), entries = supplierHeaderEntriesSchema.parse(value);
  if (source.issues?.length) reject(source.issues[0]);
  if (new Set(source.lines.map(row => row.id)).size !== source.lines.length) reject("The header source contains duplicate lines.");
  if (entries.reduce((sum, row) => sum + BigInt(row.amountMills), BigInt(0)) !== BigInt(source.expectedMills))
    reject("The header entries must equal the original amount outside the document's goods lines exactly.");
  const facts = new Map(source.facts.map(row => [row.key, row]));
  if (source.target.kind === "purchase_order" && (entries.length !== facts.size || entries.some(row => {
    const fact = facts.get(row.key);
    return !fact || fact.amountMills !== row.amountMills || fact.category !== row.category;
  }))) reject("Every PO header/adjustment amount must retain its original source and exact signed amount.");
  const result: SupplierHeaderShare[] = [];
  for (const entry of entries) {
    // An empty parent scope means all current document lines. The approved
    // by-value rule then follows subsequent approved additions/removals/edits.
    const lines = supplierHeaderEligibleLines(source, entry);
    const lineIds = new Set(lines.map(row => row.id));
    const type = entry.taxTypeId === null ? null : source.types.find(row => row.id === entry.taxTypeId);
    if (entry.category === "tax" && !type) reject("Choose an existing configured tax type for this header tax.");
    const shares = entry.method === "manual" ? entry.shares : (() => {
      if (entry.amountMills === 0) return lines.map(row => ({ lineId: row.id, amountMills: 0 }));
      if (!lines.length || lines.every(row => row.basisMills === 0)) reject("Choose manual shares when no positive document value can support a by-value allocation.");
      const sign = entry.amountMills < 0 ? BigInt(-1) : BigInt(1);
      const cents = readIntegerCents(BigInt(entry.amountMills) * sign / BigInt(100), "header amount");
      return allocateCentsFromNumericBasis(cents, lines.map(row => ({ lineId: row.id, basis: row.basisMills })))
        .map(row => ({ lineId: row.lineId, amountMills: readIntegerMills(BigInt(row.allocatedCents) * BigInt(100) * sign, "header share", true) }));
    })();
    if (shares.some(row => !lineIds.has(row.lineId)
      || row.amountMills !== 0 && Math.sign(row.amountMills) !== Math.sign(entry.amountMills))
      || shares.reduce((sum, row) => sum + BigInt(row.amountMills), BigInt(0)) !== BigInt(entry.amountMills))
      reject("Each header share must belong to its eligible line, retain its sign and conserve the complete amount.");
    for (const share of shares) {
      if (!share.amountMills) continue;
      const line = lines.find(row => row.id === share.lineId)!;
      if (entry.destination !== "excluded" && entry.destination !== "tax"
        && (line.kind === "unlinked" || (entry.destination === "landed") !== (line.kind === "shipment_charge")))
        reject("Choose goods cost for a product, shipment cost for a linked shipment charge, or keep this amount outside inventory.");
      if (entry.destination === "tax" && line.kind === "unlinked")
        reject("Header tax needs a product or shipment cost source; an unlinked bill line cannot define inventory tax.");
      if (entry.destination === "packaging" && line.packagingTreatment !== "separate")
        reject("Separate packaging shares need a supplier-evidenced split; use the whole goods amount for combined prices.");
      result.push({ key: entry.key, label: entry.label, lineId: share.lineId, amountMills: share.amountMills,
        destination: entry.destination, taxTypeId: entry.taxTypeId, taxTreatment: type?.treatment ?? null });
    }
  }
  return result.sort((a, b) => a.lineId - b.lineId || compareKeys(a.key, b.key));
}

export function selectSupplierHeaderShares(source: SupplierHeaderSource, evidence: unknown): SupplierHeaderShare[] {
  const saved = supplierHeaderEvidenceSchema.parse(evidence);
  if (saved.sourceFingerprint !== supplierHeaderSourceFingerprint(source))
    reject("The header amounts or eligible lines changed. Review their current allocation before applying costs.");
  return allocateSupplierHeader(source, saved.entries);
}

/** Only a line's economic shares enter its supplier revision. Label edits and
 * approval metadata are retained in history without reposting identical costs. */
export function supplierHeaderLineEvidence(shares: readonly SupplierHeaderShare[], lineId: number) {
  costInteger(lineId, "header line", 1);
  return [...shares].filter(row => row.lineId === lineId).map(({ label: _label, ...row }) => row)
    .sort((a, b) => compareKeys(canonicalJson(a), canonicalJson(b)));
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function supplierHeaderAmounts(value: unknown) {
  const shares = z.array(supplierHeaderEconomicShareSchema).max(30).parse(value ?? []);
  const total = (destination: string) => readIntegerMills(shares.filter(row => row.destination === destination)
    .reduce((sum, row) => sum + BigInt(row.amountMills), BigInt(0)), "selected supplier header amount", true);
  return { productMills: total("product"), packagingMills: total("packaging"), landedMills: total("landed"),
    excludedMills: total("excluded"), totalMills: readIntegerMills(shares.reduce((sum, row) => sum + BigInt(row.amountMills), BigInt(0)), "allocated header total", true),
    taxes: shares.filter(row => row.destination === "tax").map(row => ({ taxTypeId: row.taxTypeId!, treatment: row.taxTreatment!, amountMills: row.amountMills,
      source: `supplier_header:${row.key}` })),
  };
}
