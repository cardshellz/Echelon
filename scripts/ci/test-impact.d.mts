export interface FileChange { status: string; paths: string[]; }
export interface ImpactSnapshot { files: Set<string>; readSource(file: string): string; }
export interface ChangeEvidence extends ImpactSnapshot { changes: FileChange[]; previous?: ImpactSnapshot; }
export interface ImpactDecision { run: boolean; reason: string; }
export type DependencyCache = Map<(file: string) => string, Map<string, string[]>>;
export interface ImpactCoverage {
  roots(snapshot: ImpactSnapshot): readonly string[];
  testPattern: RegExp;
  ownedFiles: readonly string[]; ownedPrefixes: readonly string[];
  globalFiles: readonly string[]; globalPrefixes: readonly string[]; globalPattern?: RegExp;
  knownPrefixes: readonly string[]; knownPattern?: RegExp;
}
export function parseChangedFiles(output: string): FileChange[];
export function importsIn(source: string, filename: string): string[];
export function resolveLocalImport(from: string, specifier: string, files: ReadonlySet<string>, packages: ReadonlySet<string>): string | null;
export function dependencyClosure(roots: readonly string[], files: ReadonlySet<string>, readSource: (file: string) => string, edges?: Map<string, string[]>): Set<string>;
export function hasUncertainImpact(decision: ImpactDecision): boolean;
export function selectTestImpact(options: {
  changes: readonly FileChange[]; files: ReadonlySet<string>; readSource(file: string): string;
  previous?: ImpactSnapshot; force?: boolean; coverage: ImpactCoverage; dependencyCache?: DependencyCache;
}): ImpactDecision;
export function readGitSnapshots(root: string, refs: readonly string[]): Array<ImpactSnapshot & { ref: string }>;
export function readTestChangeEvidence(environment: Record<string, string | undefined>, root: string): ChangeEvidence & { previous: ImpactSnapshot };
