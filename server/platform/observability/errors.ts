export type ErrorClass = "transient" | "permanent" | "fatal";

export interface AppErrorOptions {
  code: string;
  message: string;
  context?: Record<string, unknown>;
  errorClass?: ErrorClass;
  httpStatus?: number;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly context: Record<string, unknown>;
  readonly errorClass: ErrorClass;
  readonly httpStatus: number;

  constructor(opts: AppErrorOptions) {
    super(opts.message, { cause: opts.cause });
    this.name = "AppError";
    this.code = opts.code;
    this.context = opts.context ?? {};
    this.errorClass = opts.errorClass ?? "transient";
    this.httpStatus = opts.httpStatus ?? 500;
  }
}

const PERMANENT_PATTERNS = [
  /not found/i,
  /already shipped/i,
  /already cancelled/i,
  /cannot cancel/i,
  /invalid.*enum/i,
  /unique.*constraint/i,
  /duplicate.*key/i,
  /violates.*foreign/i,
];

const FATAL_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
]);

export function classify(err: unknown): ErrorClass {
  if (err instanceof AppError) return err.errorClass;

  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as any)?.code;

  if (FATAL_CODES.has(code)) return "fatal";

  for (const pattern of PERMANENT_PATTERNS) {
    if (pattern.test(msg)) return "permanent";
  }

  return "transient";
}
