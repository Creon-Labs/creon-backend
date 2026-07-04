/**
 * Success envelope emitted by `ResponseEnvelopeInterceptor` for every JSON
 * response except `204 No Content` (no body) and handlers that return
 * `undefined`/`void`.
 *
 * `message` is a short, human-readable string for display — never intended
 * for client-side branching logic (branch on `statusCode` / `data` instead).
 */
export interface ApiSuccessResponse<T = unknown> {
  statusCode: number;
  message: string;
  data: T;
}

/**
 * Error envelope emitted by `HttpExceptionFilter`. `message` mirrors Nest's
 * own `HttpException` body — a `string` for most thrown exceptions (e.g.
 * `NotFoundException('Campaign not found')`), or a `string[]` for
 * `ValidationPipe`/class-validator failures. `error` is the stock HTTP reason
 * phrase Nest's built-in exceptions already produce (e.g. "Not Found").
 *
 * `data` is always `null` here — never omitted — so a client can safely do
 * `if (response.data === null)` as a single "this failed" check regardless of
 * whether it's inspecting a success or error envelope.
 */
export interface ApiErrorResponse {
  statusCode: number;
  message: string | string[];
  error: string;
  data: null;
}
