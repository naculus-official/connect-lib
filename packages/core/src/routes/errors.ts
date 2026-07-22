export type RouteErrorCode =
  | "no_routes_available"
  | "provider_unavailable"
  | "route_expired"
  | "execution_failed"
  | "invalid_params"
  | "insufficient_balance";

export class RouteEngineError extends Error {
  code: RouteErrorCode;
  details?: Record<string, unknown>;

  constructor(
    code: RouteErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RouteEngineError";
    this.code = code;
    this.details = details;
  }
}

export function isRouteEngineError(
  e: unknown,
  code?: RouteErrorCode,
): e is RouteEngineError {
  if (!e || typeof e !== "object") return false;
  const candidate = e as RouteEngineError;
  if (
    candidate.name !== "RouteEngineError" ||
    typeof candidate.code !== "string"
  )
    return false;
  return code ? candidate.code === code : true;
}
