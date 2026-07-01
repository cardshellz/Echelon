export const GRAMS_PER_POUND = 453.59237;
export const MILLIMETERS_PER_INCH = 25.4;

export type VariantPackageAttributeKey = "weightGrams" | "lengthMm" | "widthMm" | "heightMm";
export type VariantPackagePayload = Partial<Record<VariantPackageAttributeKey, number | null>>;
export type VariantPackageBulkRow = { variantId: number; updates: VariantPackagePayload };

export type VariantPackageInput = {
  weightLb: string;
  lengthIn: string;
  widthIn: string;
  heightIn: string;
};

export type VariantPackageSource = {
  weightGrams?: number | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
};

export function emptyVariantPackageInput(): VariantPackageInput {
  return {
    weightLb: "",
    lengthIn: "",
    widthIn: "",
    heightIn: "",
  };
}

export function formatMeasurementInput(value: number | null | undefined, divisor: number): string {
  if (value === null || value === undefined) return "";
  return (value / divisor).toFixed(3).replace(/\.?0+$/, "");
}

export function variantPackageInputFromVariant(variant: VariantPackageSource): VariantPackageInput {
  return {
    weightLb: formatMeasurementInput(variant.weightGrams, GRAMS_PER_POUND),
    lengthIn: formatMeasurementInput(variant.lengthMm, MILLIMETERS_PER_INCH),
    widthIn: formatMeasurementInput(variant.widthMm, MILLIMETERS_PER_INCH),
    heightIn: formatMeasurementInput(variant.heightMm, MILLIMETERS_PER_INCH),
  };
}

function parsePositiveMeasurement(rawValue: string, label: string): number | null {
  const trimmed = rawValue.trim();
  if (!trimmed) return null;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be greater than zero.`);
  }
  return parsed;
}

function toStoredMeasurement(rawValue: string, label: string, multiplier: number): number | null {
  const parsed = parsePositiveMeasurement(rawValue, label);
  if (parsed === null) return null;

  const storedValue = Math.round(parsed * multiplier);
  if (!Number.isInteger(storedValue) || storedValue <= 0) {
    throw new Error(`${label} is too small to store.`);
  }
  return storedValue;
}

export function buildVariantPackagePayload(
  input: VariantPackageInput,
  blankMode: "null" | "omit",
): VariantPackagePayload {
  const payload: VariantPackagePayload = {};
  const fields: Array<{ key: VariantPackageAttributeKey; value: string; label: string; multiplier: number }> = [
    { key: "weightGrams", value: input.weightLb, label: "Package weight", multiplier: GRAMS_PER_POUND },
    { key: "lengthMm", value: input.lengthIn, label: "Package length", multiplier: MILLIMETERS_PER_INCH },
    { key: "widthMm", value: input.widthIn, label: "Package width", multiplier: MILLIMETERS_PER_INCH },
    { key: "heightMm", value: input.heightIn, label: "Package height", multiplier: MILLIMETERS_PER_INCH },
  ];

  for (const field of fields) {
    const trimmed = field.value.trim();
    if (!trimmed && blankMode === "omit") continue;
    payload[field.key] = toStoredMeasurement(trimmed, field.label, field.multiplier);
  }

  return payload;
}

export function buildVariantPackageDisplay(variant: VariantPackageSource) {
  const weight = formatMeasurementInput(variant.weightGrams, GRAMS_PER_POUND);
  const length = formatMeasurementInput(variant.lengthMm, MILLIMETERS_PER_INCH);
  const width = formatMeasurementInput(variant.widthMm, MILLIMETERS_PER_INCH);
  const height = formatMeasurementInput(variant.heightMm, MILLIMETERS_PER_INCH);

  if (!variant.weightGrams) {
    return {
      label: "Missing weight",
      detail: "Required for marketplace listing package data",
      className: "bg-red-50 text-red-700 border-red-300",
    };
  }

  if (!variant.lengthMm || !variant.widthMm || !variant.heightMm) {
    return {
      label: "Dims missing",
      detail: `${weight} lb - add L x W x H`,
      className: "bg-yellow-50 text-yellow-700 border-yellow-300",
    };
  }

  return {
    label: "Ready",
    detail: `${weight} lb - ${length} x ${width} x ${height} in`,
    className: "bg-green-50 text-green-700 border-green-300",
  };
}

export function escapeCsvCell(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      i += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  row.push(cell);
  rows.push(row);
  return rows.filter((parsedRow) => parsedRow.some((value) => value.trim() !== ""));
}

export function normalizeCsvHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}
