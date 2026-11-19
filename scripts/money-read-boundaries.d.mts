export interface MoneyReadSite { file: string; line: number; expression: string }
export interface MoneyReadException { file: string; expression: string; reason: string }
export function unsafeMoneyReads(source: string, filename: string): MoneyReadSite[];
export function auditMoneyReadBoundaries(root: string, allowed: readonly MoneyReadException[]): Promise<MoneyReadSite[]>;
