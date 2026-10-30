export type ErrorCode =
  | "UNAUTHENTICATED"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "CONFLICT"
  | "UNSUPPORTED_CAPABILITY"
  | "DEPENDENCY_UNAVAILABLE"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AppError";
  }
}

export function unsupportedCapability(capability: string, runtime: string): AppError {
  return new AppError(
    "UNSUPPORTED_CAPABILITY",
    `Capability '${capability}' is not available in runtime '${runtime}'.`,
    501,
  );
}
