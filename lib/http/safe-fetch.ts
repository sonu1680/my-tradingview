/**
 * `fetch` with a rejection handler attached the instant the promise exists.
 *
 * WHY THIS EXISTS
 * ---------------
 * `const res = await fetch(url, { signal })` leaves a window: the promise is
 * created, and only when the `await` is evaluated does a rejection handler get
 * attached. If `controller.abort()` lands inside that window — which is exactly
 * what React does when an effect cleans up in the same tick it ran, as Strict
 * Mode's double-invoke guarantees in dev — the promise rejects with nobody
 * listening, and the browser reports `Uncaught (in promise) AbortError`.
 *
 * That is not cosmetic. In Next's dev mode an unhandled rejection raises the
 * full-screen error overlay: modal, swallows every click, cleared only by a
 * reload. It is indistinguishable from the app hanging.
 *
 * Wrapping the call site in try/catch does NOT fix it — the catch only runs
 * once the await is reached, which is the very thing that has not happened yet.
 * Nor does a window-level `unhandledrejection` guard: Next installs its own
 * error instrumentation at module load, so it observes the rejection first and
 * shows the overlay regardless of a later `preventDefault()`.
 *
 * The fix has to be here, at creation. `p.catch()` returns a new promise that
 * is deliberately discarded; its only job is to mark `p` as observed. The
 * original `p` is returned, so callers still await it and still receive the
 * rejection through their own try/catch exactly as before.
 */
export function safeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const p = fetch(input, init);
  // Marks `p` observed. Intentionally not returned and intentionally empty.
  void p.catch(() => {});
  return p;
}
