import Papa from "papaparse";

export const SUPPLIER_EVIDENCE_IMPORT_HEADERS = [
  "sku",
  "vendor_sku",
  "pricing_basis",
  "quoted_unit_cost",
  "purchase_uom",
  "pieces_per_purchase_uom",
  "quote_reference",
  "quoted_at",
  "quote_valid_until",
  "moq_pieces",
  "lead_time_days",
  "is_preferred",
] as const;
export const MAX_SUPPLIER_EVIDENCE_IMPORT_ROWS = 200;
export const MAX_SUPPLIER_EVIDENCE_CSV_BYTES = 1_000_000;

type SupplierEvidenceImportHeader = typeof SUPPLIER_EVIDENCE_IMPORT_HEADERS[number];

export type SupplierEvidenceImportApiRow = {
  sku: string;
  vendorSku: string | null;
  pricingBasis: "per_piece" | "per_purchase_uom";
  quotedUnitCost: string;
  purchaseUom: string | null;
  piecesPerPurchaseUom: number | null;
  quoteReference: string | null;
  quotedAt: string;
  quoteValidUntil: string | null;
  moqPieces: number | null;
  leadTimeDays: number;
  isPreferred: boolean;
};

export type SupplierEvidenceCsvError = {
  rowNumber: number;
  field?: string;
  message: string;
};

export type SupplierEvidenceCsvParseResult = {
  rows: SupplierEvidenceImportApiRow[];
  errors: SupplierEvidenceCsvError[];
};

const requiredHeaders: SupplierEvidenceImportHeader[] = [
  "sku",
  "pricing_basis",
  "quoted_unit_cost",
  "quoted_at",
  "lead_time_days",
  "is_preferred",
];

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function optionalText(value: unknown): string | null {
  const normalized = textValue(value);
  return normalized || null;
}

function positiveInteger(value: unknown): number | null | "invalid" {
  const normalized = textValue(value);
  if (!normalized) return null;
  if (!/^\d+$/.test(normalized)) return "invalid";
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : "invalid";
}

function nonnegativeInteger(value: unknown): number | "invalid" {
  const normalized = textValue(value);
  if (!/^\d+$/.test(normalized)) return "invalid";
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : "invalid";
}

function booleanValue(value: unknown): boolean | "invalid" {
  const normalized = textValue(value).toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return "invalid";
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function supplierEvidenceImportTemplateCsv(): string {
  return Papa.unparse({
    fields: [...SUPPLIER_EVIDENCE_IMPORT_HEADERS],
    data: [],
  });
}

export function parseSupplierEvidenceCsv(csv: string): SupplierEvidenceCsvParseResult {
  const parsed = Papa.parse<Record<string, unknown>>(csv, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim().toLowerCase(),
  });
  const errors: SupplierEvidenceCsvError[] = parsed.errors.map((error) => ({
    rowNumber: (error.row ?? 0) + 2,
    message: error.message,
  }));
  const fields = parsed.meta.fields ?? [];
  const allowed = new Set<string>(SUPPLIER_EVIDENCE_IMPORT_HEADERS);
  for (const required of requiredHeaders) {
    if (!fields.includes(required)) {
      errors.push({ rowNumber: 1, field: required, message: `Missing required column: ${required}` });
    }
  }
  for (const field of fields) {
    if (!allowed.has(field)) {
      errors.push({ rowNumber: 1, field, message: `Unexpected column: ${field}` });
    }
  }
  if (parsed.data.length > MAX_SUPPLIER_EVIDENCE_IMPORT_ROWS) {
    errors.push({
      rowNumber: MAX_SUPPLIER_EVIDENCE_IMPORT_ROWS + 2,
      message: `The CSV cannot contain more than ${MAX_SUPPLIER_EVIDENCE_IMPORT_ROWS} evidence rows.`,
    });
  }

  const rows: SupplierEvidenceImportApiRow[] = [];
  parsed.data.forEach((raw, index) => {
    const rowNumber = index + 2;
    const rowErrors: SupplierEvidenceCsvError[] = [];
    const sku = textValue(raw.sku).toUpperCase();
    const pricingBasis = textValue(raw.pricing_basis);
    const quotedUnitCost = textValue(raw.quoted_unit_cost);
    const purchaseUom = optionalText(raw.purchase_uom);
    const piecesPerPurchaseUom = positiveInteger(raw.pieces_per_purchase_uom);
    const moqPieces = positiveInteger(raw.moq_pieces);
    const leadTimeDays = nonnegativeInteger(raw.lead_time_days);
    const isPreferred = booleanValue(raw.is_preferred);
    const quotedAt = textValue(raw.quoted_at);
    const quoteValidUntil = optionalText(raw.quote_valid_until);

    if (!sku) rowErrors.push({ rowNumber, field: "sku", message: "SKU is required." });
    if (pricingBasis !== "per_piece" && pricingBasis !== "per_purchase_uom") {
      rowErrors.push({
        rowNumber,
        field: "pricing_basis",
        message: "pricing_basis must be per_piece or per_purchase_uom.",
      });
    }
    if (!/^\d+(?:\.\d{1,4})?$/.test(quotedUnitCost)) {
      rowErrors.push({
        rowNumber,
        field: "quoted_unit_cost",
        message: "quoted_unit_cost must be a non-negative dollar amount with at most four decimals.",
      });
    }
    if (!isIsoDate(quotedAt)) {
      rowErrors.push({ rowNumber, field: "quoted_at", message: "quoted_at must be YYYY-MM-DD." });
    }
    if (quoteValidUntil && !isIsoDate(quoteValidUntil)) {
      rowErrors.push({
        rowNumber,
        field: "quote_valid_until",
        message: "quote_valid_until must be blank or YYYY-MM-DD.",
      });
    }
    if (leadTimeDays === "invalid") {
      rowErrors.push({
        rowNumber,
        field: "lead_time_days",
        message: "lead_time_days must be a non-negative integer.",
      });
    }
    if (moqPieces === "invalid") {
      rowErrors.push({ rowNumber, field: "moq_pieces", message: "moq_pieces must be a positive integer." });
    }
    if (piecesPerPurchaseUom === "invalid") {
      rowErrors.push({
        rowNumber,
        field: "pieces_per_purchase_uom",
        message: "pieces_per_purchase_uom must be a positive integer.",
      });
    }
    if (pricingBasis === "per_piece" && (purchaseUom || typeof piecesPerPurchaseUom === "number")) {
      rowErrors.push({
        rowNumber,
        field: "pricing_basis",
        message: "Per-piece rows must leave purchase_uom and pieces_per_purchase_uom blank.",
      });
    }
    if (
      pricingBasis === "per_purchase_uom" &&
      (!purchaseUom || typeof piecesPerPurchaseUom !== "number")
    ) {
      rowErrors.push({
        rowNumber,
        field: "pricing_basis",
        message: "Purchase-UOM rows require purchase_uom and pieces_per_purchase_uom.",
      });
    }
    if (isPreferred === "invalid") {
      rowErrors.push({
        rowNumber,
        field: "is_preferred",
        message: "is_preferred must be true/false, yes/no, or 1/0.",
      });
    }

    errors.push(...rowErrors);
    if (rowErrors.length > 0) return;
    rows.push({
      sku,
      vendorSku: optionalText(raw.vendor_sku),
      pricingBasis: pricingBasis as SupplierEvidenceImportApiRow["pricingBasis"],
      quotedUnitCost,
      purchaseUom,
      piecesPerPurchaseUom: piecesPerPurchaseUom as number | null,
      quoteReference: optionalText(raw.quote_reference),
      quotedAt,
      quoteValidUntil,
      moqPieces: moqPieces as number | null,
      leadTimeDays: leadTimeDays as number,
      isPreferred: isPreferred as boolean,
    });
  });

  if (parsed.data.length === 0 && errors.length === 0) {
    errors.push({ rowNumber: 2, message: "The CSV contains no supplier evidence rows." });
  }
  return { rows: errors.length === 0 ? rows : [], errors };
}
