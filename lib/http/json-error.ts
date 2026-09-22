/**
 * Shared JSON error envelope for the API routes.
 *
 * This lives outside `app/api/**` because Next's App Router validates a
 * `route.ts` module's exports against the Route Handler shape — exporting a
 * plain helper from a route file is not allowed, so the two routes would
 * otherwise each need their own copy.
 */

/** Sent on every API response, success or failure. See the routes for why. */
export const NO_STORE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
};

/** Error codes the client can branch on. */
export type ApiErrorCode =
  | 'INVALID_TIMEFRAME'
  | 'INVALID_PARAM'
  | 'TIMEFRAME_UNAVAILABLE'
  | 'INTERNAL';

export interface ApiError {
  error: string;
  code: ApiErrorCode;
}

export function jsonError(
  status: number,
  code: ApiErrorCode,
  error: string,
): Response {
  return Response.json({ error, code } satisfies ApiError, {
    status,
    headers: NO_STORE_HEADERS,
  });
}

/** Logs the full stack server-side; callers return a generic message. */
export function logInternal(context: string, err: unknown): void {
  console.error(
    `${context} failed:`,
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
}
