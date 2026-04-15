export class DropshipError extends Error {
  public code: string;
  public context?: Record<string, any>;

  constructor(code: string, message: string, context?: Record<string, any>) {
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
      context: this.context
    };
  }
}
