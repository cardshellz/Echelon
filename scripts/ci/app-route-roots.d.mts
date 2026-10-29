import type { ImpactSnapshot } from "./test-impact.mjs";
export function appRouteRoots(snapshot: Pick<ImpactSnapshot, "files" | "readSource">, prefixes: readonly string[]): string[];
