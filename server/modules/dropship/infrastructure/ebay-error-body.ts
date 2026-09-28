/**
 * eBay Sell API failures carry their reason in the response body:
 * `{ errors: [{ errorId, domain, category, message, longMessage, parameters: [{ name, value }] }] }`.
 * An HTTP 400 without that content cannot be acted on by anyone, so a push
 * failure keeps a bounded, printable summary of it: at most
 * MAX_EBAY_ERROR_ENTRIES entries, each field cut to MAX_EBAY_ERROR_TEXT
 * characters with control characters removed. Bodies over
 * MAX_EBAY_ERROR_BODY_LENGTH are not parsed at all.
 */
export const MAX_EBAY_ERROR_ENTRIES = 5;
export const MAX_EBAY_ERROR_PARAMETERS = 5;
export const MAX_EBAY_ERROR_TEXT = 300;
export const MAX_EBAY_ERROR_BODY_LENGTH = 20_000;

export interface EbayErrorEntry {
  errorId: number | null;
  domain: string | null;
  category: string | null;
  message: string | null;
  longMessage: string | null;
  parameters: Array<{ name: string; value: string }>;
}

/** Never throws: anything that is not the documented shape yields no entries. */
export function parseEbayErrorBody(text: string): EbayErrorEntry[] {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_EBAY_ERROR_BODY_LENGTH) return [];
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(body) || !Array.isArray(body.errors)) return [];
  return body.errors.slice(0, MAX_EBAY_ERROR_ENTRIES).flatMap((entry): EbayErrorEntry[] => {
    if (!isRecord(entry)) return [];
    const parsed: EbayErrorEntry = {
      errorId: nonNegativeInteger(entry.errorId),
      domain: printable(entry.domain),
      category: printable(entry.category),
      message: printable(entry.message),
      longMessage: printable(entry.longMessage),
      parameters: Array.isArray(entry.parameters)
        ? entry.parameters.slice(0, MAX_EBAY_ERROR_PARAMETERS).flatMap((parameter) => {
          if (!isRecord(parameter)) return [];
          const name = printable(parameter.name);
          const value = printable(parameter.value);
          return name && value ? [{ name, value }] : [];
        })
        : [],
    };
    const empty = parsed.errorId === null && parsed.message === null && parsed.longMessage === null;
    return empty ? [] : [parsed];
  });
}

/**
 * One line naming every entry, for an error message and the operator's
 * "latest issue" column: `25002 Invalid value for aspect (aspect: Brand); 25709 ...`.
 * The long message is used when it says more than the short one.
 */
export function describeEbayErrors(errors: readonly EbayErrorEntry[]): string | null {
  const lines = errors.map((entry) => {
    const text = entry.longMessage && entry.message && entry.longMessage.length > entry.message.length
      ? entry.longMessage
      : entry.message ?? entry.longMessage;
    const parameters = entry.parameters.map((parameter) => `${parameter.name}: ${parameter.value}`).join(", ");
    const parts = [entry.errorId === null ? null : String(entry.errorId), text, parameters ? `(${parameters})` : null]
      .filter((part): part is string => part !== null && part.length > 0);
    return parts.join(" ");
  }).filter((line) => line.length > 0);
  return lines.length > 0 ? lines.join("; ") : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d{1,12}$/.test(value)) return Number(value);
  return null;
}

/** Collapse whitespace, drop control characters, cap the length. */
function printable(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  return text.length > MAX_EBAY_ERROR_TEXT ? `${text.slice(0, MAX_EBAY_ERROR_TEXT - 1)}…` : text;
}
