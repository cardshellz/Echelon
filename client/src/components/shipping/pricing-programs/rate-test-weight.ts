import { GRAMS_PER_POUND } from "../rate-table-model";

export function poundsToRateTestGrams(pounds: number): number | null {
  if (!Number.isFinite(pounds) || pounds <= 0) return null;

  const grams = Math.round(pounds * GRAMS_PER_POUND);
  return Number.isSafeInteger(grams) && grams > 0 ? grams : null;
}
