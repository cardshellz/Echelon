/** Exact, storage-independent rules for the existing daily document identifiers. */
export class DocumentNumberError extends Error {
  readonly statusCode = 409;
  constructor(public readonly code: "DOCUMENT_NUMBER_EXHAUSTED", message: string) {
    super(message);
    this.name = "DocumentNumberError";
  }
}

/** Snapshot an injected clock before yielding to a transaction or lock wait. */
export function captureDocumentNumberTime(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Document numbering requires a valid clock");
  }
  return new Date(value.getTime());
}

export function documentNumberPrefix(label: string, now: Date, calendar: "utc" | "local"): string {
  if (!/^[A-Z]+$/.test(label) || !(now instanceof Date) || !Number.isFinite(now.getTime())
    || (calendar !== "utc" && calendar !== "local")) {
    throw new TypeError("Document numbering requires a valid label, clock and calendar");
  }
  // Keep each owner's existing UTC/local calendar policy explicit. Extended years
  // cannot fit the established YYYYMMDD format and must never produce a partial date.
  const year = calendar === "utc" ? now.getUTCFullYear() : now.getFullYear();
  const month = (calendar === "utc" ? now.getUTCMonth() : now.getMonth()) + 1;
  const day = calendar === "utc" ? now.getUTCDate() : now.getDate();
  if (year < 0 || year > 9999) throw new TypeError("Document numbering requires a four-digit calendar year");
  return `${label}-${String(year).padStart(4, "0")}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}-`;
}

export function nextDocumentNumber(prefix: string, largestSuffix: string | null, maxLength: number): string {
  if (!/^[A-Z]+-\d{8}-$/.test(prefix) || !Number.isSafeInteger(maxLength) || maxLength < prefix.length + 3
    || (largestSuffix !== null && !/^\d+$/.test(largestSuffix))) {
    throw new TypeError("Document numbering evidence is invalid");
  }
  const next = (largestSuffix === null ? BigInt(0) : BigInt(largestSuffix)) + BigInt(1);
  const result = `${prefix}${next.toString().padStart(3, "0")}`;
  if (result.length > maxLength) {
    throw new DocumentNumberError("DOCUMENT_NUMBER_EXHAUSTED", `Automatic document numbering is exhausted for ${prefix}.`);
  }
  return result;
}
