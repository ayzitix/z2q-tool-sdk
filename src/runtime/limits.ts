/**
 * Hard limits for the QuickJS tool runtime.
 *
 * Every value is a host ceiling: a tool manifest may ask for less, never more.
 * They are exported so hosts and tests can name the numbers they rely on.
 */

/** Per-call QuickJS heap, enforced with `runtime.setMemoryLimit`. */
export const SANDBOX_MEMORY_BYTES = 128 * 1024 * 1024;
/** Per-call QuickJS stack, enforced with `runtime.setMaxStackSize`. */
export const SANDBOX_STACK_BYTES = 1024 * 1024;
/** Host ceiling over `manifest.capabilities.limits.timeoutMs`. */
export const SANDBOX_MAX_TIMEOUT_MS = 60_000;
/** Host ceiling over `manifest.capabilities.limits.maxOutputBytes`. */
export const SANDBOX_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Largest bundle `loadToolPackage` accepts, in bytes. */
export const SANDBOX_MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
/** Pending jobs the host pumps before giving up on a settling promise. */
export const SANDBOX_MAX_PUMP_ITERATIONS = 100_000;
/** Audit rows kept per call, before the single `audit_limit` summary row. */
export const SANDBOX_MAX_AUDIT_ROWS = 1_000;
/** Files `fs.glob` may return; the rest is truncated and logged. */
export const SANDBOX_MAX_GLOB_RESULTS = 10_000;
/** Bytes `fs.read` may return; larger files fail with `output_too_large`. */
export const SANDBOX_MAX_READ_BYTES = 8 * 1024 * 1024;
/**
 * Largest string allowed to cross the bridge in one `__z1_invoke` call.
 *
 * Measured: a single value of ~4 MB crossing the bridge leaves one internal
 * object behind, and `runtime.dispose()` then throws its catchable abort
 * (3 MB is clean). Reads, writes, the result envelope and the bridge payload
 * are therefore chunked at this size.
 */
export const SANDBOX_MAX_BRIDGE_BYTES = 1024 * 1024;
/** Grep matches kept; the rest is truncated. */
export const SANDBOX_MAX_GREP_MATCHES = 1_000;

/**
 * Largest response body `ctx.net.fetch` accepts, in bytes.
 *
 * The body still crosses the bridge in `SANDBOX_MAX_BRIDGE_BYTES` chunks, so
 * this is a policy cap rather than a transport one: a server that sends more
 * has its transfer cancelled and the call fails with `output_too_large`.
 */
export const SANDBOX_MAX_NET_BODY_BYTES = 4 * 1024 * 1024;
/**
 * Largest request body `ctx.net.fetch` sends, in UTF-8 bytes.
 *
 * It equals `SANDBOX_MAX_BRIDGE_BYTES`, so in practice the bridge refuses an
 * oversized body first; the check still runs, because the broker is the
 * authority and a future bridge limit must not become a network limit.
 */
export const SANDBOX_MAX_NET_REQUEST_BYTES = 1024 * 1024;
/** Redirects the broker follows before treating the last hop as the answer. */
export const SANDBOX_MAX_NET_REDIRECTS = 5;
/** Request headers one call may send, after lower-casing. */
export const SANDBOX_MAX_NET_HEADERS = 64;
/**
 * Default wall-clock budget for one `ctx.net.fetch`, in milliseconds.
 *
 * A call never gets more than the remaining call budget; the broker passes the
 * smaller of the two to the helper, which aborts the request itself so the
 * failure arrives as `net_failed` instead of the call's own `time_limit`.
 */
export const SANDBOX_DEFAULT_NET_TIMEOUT_MS = 15_000;
/** Names one manifest may declare in `capabilities.env.read`. */
export const SANDBOX_MAX_ENV_ENTRIES = 32;
