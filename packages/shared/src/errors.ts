/** Base class for all application errors — carries an HTTP-mappable status and a machine-readable code. */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number = 500,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, "VALIDATION_ERROR", 400, cause);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, "NOT_FOUND", 404);
  }
}

/** Thrown by packages/decathlon when a Mirakl API call fails. Never carries the raw API key. */
export class DecathlonApiError extends AppError {
  constructor(
    message: string,
    public readonly endpoint: string,
    public readonly decathlonHttpStatus?: number,
    cause?: unknown,
  ) {
    super(message, "DECATHLON_API_ERROR", 502, cause);
  }
}

export class DecathlonRateLimitError extends DecathlonApiError {
  constructor(endpoint: string, public readonly retryAfterSeconds?: number) {
    super(`Rate limited by Decathlon API at ${endpoint}`, endpoint, 429);
  }
}

/**
 * A non-idempotent Decathlon write (refund, shipment) whose request may or may not have been applied
 * — a timeout, dropped connection or 5xx after the body was sent. It must NOT be retried blindly:
 * Mirakl has no idempotency key, so a resend could refund a customer twice. Callers check the
 * current state on Decathlon before trying again.
 */
export class DecathlonOutcomeUnknownError extends DecathlonApiError {
  constructor(endpoint: string, cause?: unknown) {
    super(`Decathlon did not confirm ${endpoint}; it may or may not have been applied`, endpoint, undefined, cause);
  }
}

/** Thrown by packages/shopify when an Admin API call fails. */
export class ShopifyApiError extends AppError {
  constructor(
    message: string,
    public readonly endpoint: string,
    public readonly shopifyHttpStatus?: number,
    cause?: unknown,
  ) {
    super(message, "SHOPIFY_API_ERROR", 502, cause);
  }
}

/** Endpoint documented as NOT part of the confirmed Decathlon integration scope (see docs/api-mapping.md). */
export class UnsupportedOperationError extends AppError {
  constructor(operation: string) {
    super(
      `${operation} is not confirmed/supported by the Decathlon Partner API per docs/api-mapping.md`,
      "UNSUPPORTED_OPERATION",
      501,
    );
  }
}
