// shared/lib/money.ts
//
// Thin re-export of the money helpers. The canonical location is
// @shared/utils/money (long-standing convention across server + client).
// This file exists so consumers can import from @shared/lib/money as well,
// per the 2026-04-22 mills spec.

export {
  dollarsToCents,
  dollarsToMills,
  millsToDollarString,
  formatMills,
  millsToCents,
  centsToMills,
  computeLineTotalCentsFromMills,
} from "@shared/utils/money";
