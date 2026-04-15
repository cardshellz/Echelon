/**
 * shared/errors.ts
 * Absolute compliance with Financial-Grade Rule 5: Error Handling
 * Structured AppErrors to enforce strict codes, context, and logging payload structure.
 */

export class AppError extends Error {
  public code: string;
  public context?: Record<string, any>;
  public statusCode: number;
  public isOperational: boolean;

  constructor(
    message: string,
    code: string,
    statusCode: number = 500,
    context?: Record<string, any>,
    isOperational: boolean = true
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.context = context;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        context: this.context || {},
      },
    };
  }
}

export class ValidationError extends AppError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, "VALIDATION_ERROR", 400, context);
  }
}

export class IntegrityError extends AppError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, "DATA_INTEGRITY_VIOLATION", 409, context);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = "Unauthorized action", context?: Record<string, any>) {
    super(message, "UNAUTHORIZED", 401, context);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, "NOT_FOUND", 404, context);
  }
}

export class FinancialOperationError extends AppError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, "FINANCIAL_OPERATION_FAILED", 422, context);
  }
}
