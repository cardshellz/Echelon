export type DropshipErrorContext = Record<string, unknown>;

export class DropshipError extends Error {
  public readonly code: string;
  public readonly context?: DropshipErrorContext;

  constructor(code: string, message: string, context?: DropshipErrorContext) {
    super(message);
    this.name = "DropshipError";
    this.code = code;
    this.context = context;
    Object.setPrototypeOf(this, DropshipError.prototype);
  }

  toJSON() {
    return {
      error: true,
      code: this.code,
      message: this.message,
      context: this.context,
    };
  }
}
