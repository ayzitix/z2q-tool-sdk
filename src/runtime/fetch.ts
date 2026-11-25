import { ToolRuntimeError } from './errors.js';
import type { RuntimeHost } from './host.js';
import { SANDBOX_DEFAULT_NET_TIMEOUT_MS, SANDBOX_MAX_NET_BODY_BYTES } from './limits.js';

/**
 * One HTTP request, already validated by `policy.ts` and about to be relayed.
 *
 * `remainingMs` is the call budget the broker has left, not a preference: the
 * relay never waits longer than that, because the VM cannot be allowed to block
 * the host thread past its own deadline.
 */
export interface NetRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
  readonly remainingMs: number;
}

/** One response hop, after the helper decoded it. `location` drives redirects. */
export interface NetRelayResult {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly location: string | null;
}

/**
 * The inline ESM helper, spawned with the same Node binary as the host.
 *
 * Why a child process at all: `Broker.invoke(kind, payloadJson)` is synchronous
 * and returns a string, so a fetch has to block the host thread, and the VM
 * itself must never be able to open a socket. A second Node process gives both:
 * the VM keeps its single JSON bridge, the host keeps one blocking call, and the
 * helper is a plain `fetch` with no dependency of its own (`node -e`, no curl, no
 * shell, nothing OS-specific).
 *
 * Contract with {@link relayFetch}:
 *
 * - stdin is one JSON object `{ url, method, headers, body, maxBodyBytes, timeoutMs }`;
 * - `redirect: 'manual'` on purpose: the broker validates **every** hop, so the
 *   helper reports `location` instead of following it;
 * - the body is read through `response.body.getReader()` and the read stops at
 *   `maxBodyBytes`, so an endless response cannot grow the host's memory;
 * - stdout is exactly one JSON line, `{ ok: true, value }` or `{ ok: false, code, message }`;
 * - the process exits 0 for a request that failed, because the failure travels
 *   in the JSON. A non-zero exit means the relay itself broke, which the broker
 *   reports as `net_failed` with stderr's first line.
 *
 * Bodies are decoded as UTF-8, so a binary payload comes back lossy. That is a
 * deliberate limit, not an accident: the bridge carries JSON strings, and a tool
 * that needs bytes has to ask for them some other way.
 */
export const NET_HELPER_SOURCE = String.raw`
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

try {
  const init = {
    method: input.method,
    headers: input.headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(input.timeoutMs),
  };
  if (input.body !== undefined && input.method !== 'GET' && input.method !== 'HEAD') {
    init.body = input.body;
  }
  const response = await fetch(input.url, init);
  const headers = {};
  for (const entry of response.headers) headers[entry[0].toLowerCase()] = entry[1];
  let body = '';
  let bytes = 0;
  let overflow = false;
  const reader = response.body === null ? null : response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  if (reader !== null) {
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      bytes += step.value.byteLength;
      if (bytes > input.maxBodyBytes) {
        overflow = true;
        await reader.cancel();
        break;
      }
      body += decoder.decode(step.value, { stream: true });
    }
    if (!overflow) body += decoder.decode();
  }
  if (overflow) {
    emit({
      ok: false,
      code: 'output_too_large',
      message: 'the response body is over ' + input.maxBodyBytes + ' bytes'
    });
  } else {
    emit({
      ok: true,
      value: {
        status: response.status,
        statusText: response.statusText,
        headers: headers,
        body: body,
        location: response.headers.get('location')
      }
    });
  }
} catch (error) {
  const raw = error && error.message ? String(error.message) : String(error);
  emit({ ok: false, code: 'net_failed', message: raw.split('\n')[0] });
}
`;

/**
 * How much of the remaining budget the helper must not spend.
 *
 * Spawning Node costs tens of milliseconds before the helper's own
 * `AbortSignal.timeout` even starts counting, and the reply still has to be
 * parsed. Reserving a slice means a request that runs out of time fails as
 * `net_failed` (what the tool can act on) instead of the sandbox's `time_limit`
 * (which says nothing about the network).
 */
const NET_REPORT_MARGIN_MS = 250;
/** Longest relay detail that may end up in an error message. */
const MAX_RELAY_DETAIL = 200;

/**
 * Perform one blocking HTTP request and return the decoded hop.
 *
 * Nothing ambient reaches the helper: `env: {}` means no `PATH`, no `HOME`, no
 * `NODE_OPTIONS` and none of the secrets the host holds. Every failure becomes a
 * {@link ToolRuntimeError}: `output_too_large` when the relay hit its own buffer
 * or the helper stopped at the body cap, `net_failed` for everything else.
 */
export function relayFetch(host: RuntimeHost, request: NetRequest): NetRelayResult {
  const budgetMs = Math.max(1, Math.floor(request.remainingMs));
  const abortMs = Math.max(
    1,
    Math.min(SANDBOX_DEFAULT_NET_TIMEOUT_MS, budgetMs - NET_REPORT_MARGIN_MS),
  );
  const payload = JSON.stringify({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.body,
    maxBodyBytes: SANDBOX_MAX_NET_BODY_BYTES,
    timeoutMs: abortMs,
  });

  const result = host.childProcess.spawnSync(
    host.execPath,
    ['--input-type=module', '-e', NET_HELPER_SOURCE],
    {
      input: payload,
      encoding: 'utf8',
      timeout: budgetMs,
      maxBuffer: SANDBOX_MAX_NET_BODY_BYTES + 64 * 1024,
      windowsHide: true,
      env: {},
    },
  );

  const stderrLine = truncate(firstLine(result.stderr));
  const errorCode = result.error?.code;
  // ENOBUFS is checked first: Node kills the child when its stdout buffer
  // overflows, so the same result also carries SIGTERM and would look like a
  // timeout. It means the body (JSON-escaped, so up to a few times its size)
  // outgrew the relay buffer.
  if (errorCode === 'ENOBUFS') {
    throw new ToolRuntimeError(
      'output_too_large',
      `the response body is over ${SANDBOX_MAX_NET_BODY_BYTES} bytes`,
    );
  }
  if (result.error !== undefined || result.status !== 0) {
    const detail = stderrLine === '' ? truncate(firstLine(result.error?.message ?? '')) : stderrLine;
    throw relayFailure(detail);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw relayFailure(stderrLine);
  }
  if (!isRecord(parsed)) throw relayFailure(stderrLine);

  if (parsed.ok !== true) {
    const message = typeof parsed.message === 'string' ? firstLine(parsed.message) : '';
    const code = parsed.code === 'output_too_large' ? 'output_too_large' : 'net_failed';
    const detail = truncate(message);
    throw new ToolRuntimeError(
      code,
      detail.length === 0 ? 'the request failed' : `the request failed: ${detail}`,
    );
  }

  const value = parsed.value;
  if (!isRecord(value)) throw relayFailure(stderrLine);
  const status = value.status;
  if (typeof status !== 'number' || !Number.isInteger(status)) throw relayFailure(stderrLine);
  const body = typeof value.body === 'string' ? value.body : '';
  return {
    status,
    statusText: typeof value.statusText === 'string' ? value.statusText : '',
    headers: stringRecord(value.headers),
    body,
    location: typeof value.location === 'string' && value.location.length > 0 ? value.location : null,
  };
}

function relayFailure(detail: string): ToolRuntimeError {
  return new ToolRuntimeError(
    'net_failed',
    detail.length === 0 ? 'the request failed' : `the request failed: ${detail}`,
  );
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    if (typeof item === 'string') out[name] = item;
  }
  return out;
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim();
}

function truncate(text: string): string {
  return text.length > MAX_RELAY_DETAIL ? `${text.slice(0, MAX_RELAY_DETAIL)}...` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
