# Brief — `ctx.net.fetch` + `ctx.env` for z2q (`z1-tool-sdk`)

Repo: `C:/Users/oleksii/Documents/z1-projects/z1-tool-sdk` (branch `main`, clean, Node 26 on Windows, PowerShell unavailable — use Git Bash).

**Boundaries.** Do not run any `git` command that writes (no add/commit/push/branch). Do not touch `../z1-cli` or `../z1-sdk` — only this repo. No new dependencies.

**Gates you must run and report verbatim (last lines each):** `npm test`, `npm run typecheck`, `npm run build`.

## Why

A tool created through the creator tried to do `ctx.env.EXA_API_KEY` and `ctx.net.fetch({url, method, headers, body})`. Neither existed: `ctx.env` is absent from the contract, and `net.fetch` is refused on purpose (`net_not_supported`) because the QuickJS bridge is synchronous and a fetch is not. A user then asked for network access and for secrets to arrive through a declared env allow-list. This brief implements exactly that.

**Product decisions already made — do not re-litigate, do not weaken:**
- The host user asked for **full network access**, so `'*'` in the manifest allow-list means "any host". The allow-list stays in the contract anyway; a tool that declares nothing gets no network.
- Secrets arrive as `ctx.env`, a frozen object containing **only** the names the manifest declares.

## Public API (exact)

`src/types.ts`:

```ts
export interface Capabilities { fs?, process?, net?, env?, limits? }
export interface NetCapabilities { hosts?: string[] }   // '*' = any host
export interface EnvCapabilities { read?: string[] }    // exact names, no globs, no '*'
export interface ManifestCapabilities {
  fs: { read: string[]; write: string[] };
  process: { argv: string[] };
  net: { hosts: string[] };            // default []
  env: { read: string[] };             // default []
  limits: { timeoutMs: number; maxOutputBytes: number };
}

export interface ToolContext {
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly fs: {...};                  // unchanged
  readonly process: {...};             // unchanged
  readonly net: { fetch(url: string, init?: NetFetchInit): Promise<NetFetchResult> };
  /** Only the names the manifest declares; an ungranted name is simply absent. */
  readonly env: Readonly<Record<string, string>>;
  log(level: LogLevel, message: string): void;
}

export interface NetFetchInit { method?: string; headers?: Record<string, string>; body?: string }

export interface NetFetchResult {
  ok: boolean;                 // 200-299
  status: number;
  statusText: string;
  url: string;                 // final URL, after redirects
  headers: Record<string, string>;   // lower-cased keys
  body: string;
  text: string;                // alias of body, so `response.text` works
  json(): unknown;             // JSON.parse(body); invalid JSON throws Error('tool_threw: ...')
}
```

The old `NetFetchResult { status, headers, body }` and `NetFetchInit.signal` are replaced — nothing has shipped, so this is not a breaking change.

`src/runtime/index.ts` — `ToolRuntimeOptions`:

```ts
net?: false | true | { hosts?: readonly string[] };   // ceiling; default true
env?: false | { read?: Record<string, string>; inherit?: boolean };
```

- `net: false` → every `ctx.net.fetch` fails with code `net_disabled`.
- default (`undefined` or `true`) → the manifest's `net.hosts` is the allow-list; `[]` means no network.
- `{ hosts }` → intersection: the URL host must be covered by the manifest **and** by this list.
- `env.inherit` default `true` → a **declared** name resolves from the host `process.env` when the runtime is created; `env.read` values win over inherited ones. `env: false` grants nothing. Undeclared names never resolve, whatever the host passes.
- Delete the `net_not_supported` throw in `normalizeOptions`.

Error codes (runtime `ToolRuntimeError`): add `net_disabled`, `net_denied`, `net_failed`. Remove `net_not_supported` and every reference to it — including `ToolCreatorCode` in `src/creator/prompt.ts`, the `network_not_supported` refusals in `src/creator/review.ts` and `src/creator/capabilities.ts`. Replace the creator-side refusal with a new review issue `capability_undeclared` (see «Creator»).

## The blocking fetch (the core piece)

`Broker.invoke(kind, payloadJson)` is synchronous and returns a string, so the fetch must block the host thread. Do it by spawning the **same node binary** with an inline ESM helper — no `curl`, no new dependency, no OS-specific code:

```ts
const child = spawnSync(process.execPath, ['--input-type=module', '-e', NET_HELPER_SOURCE], {
  input: JSON.stringify(request),
  encoding: 'utf8',
  timeout: remainingMs,
  maxBuffer: SANDBOX_MAX_NET_BODY_BYTES + 64 * 1024,
  windowsHide: true,
  env: {},          // nothing ambient reaches the helper
});
```

`NET_HELPER_SOURCE` (a `String.raw` constant in a new `src/runtime/fetch.ts`): read all of stdin, `JSON.parse` it as `{ url, method, headers, body, maxBodyBytes, timeoutMs }`, then

```js
const response = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
```

and read the body through `response.body.getReader()` stopping at `maxBodyBytes` (over the cap → `{"ok":false,"code":"output_too_large","message":...}`). Print exactly one JSON line to stdout:

- success: `{"ok":true,"value":{"status":n,"statusText":s,"headers":{lowercased},"body":text,"location":string|null}}`
- failure: `{"ok":false,"code":"net_failed","message":"…"}`

The helper always exits 0 for a failed request (the JSON carries the failure); a non-zero exit, a killed timeout, or unparsable stdout becomes `net_failed` with `stderr`'s first line truncated to 200 characters. Bodies are decoded as UTF-8; a binary body comes back lossy — document that.

`redirect: 'manual'` exists so the **broker** validates every hop: follow up to `SANDBOX_MAX_NET_REDIRECTS`; resolve each `Location` against the current URL, check it against the allow-list, then request again (303 → GET, body dropped; 301/302 on POST → GET; 307/308 keep method and body). `result.url` is the final URL.

## Limits — `src/runtime/limits.ts`

```ts
export const SANDBOX_MAX_NET_BODY_BYTES = 4 * 1024 * 1024;
export const SANDBOX_MAX_NET_REQUEST_BYTES = 1024 * 1024;
export const SANDBOX_MAX_NET_REDIRECTS = 5;
export const SANDBOX_MAX_NET_HEADERS = 64;
export const SANDBOX_DEFAULT_NET_TIMEOUT_MS = 15_000;
export const SANDBOX_MAX_ENV_ENTRIES = 32;
```

## Policy — `src/runtime/policy.ts` (pure, exported, unit-testable)

- `assertFetchUrl(url, hosts, label)` — absolute `http:`/`https:` only (refuse `file:`, `data:`, `ftp:`…), no embedded credentials (`user:pass@`), no NUL, then `hostAllowed`.
- `hostAllowed(host, allow)` — case-insensitive, trailing dot ignored; `'*'` allows anything; `'*.example.com'` allows `a.b.example.com` **and** `example.com`; otherwise exact match. An IP literal is allowed only when listed exactly (or `'*'`).
- `assertFetchMethod` — GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS, upper-cased; anything else `invalid_arguments`.
- `assertFetchHeaders` — ≤ `SANDBOX_MAX_NET_HEADERS`; refuse `host`, `content-length`, `transfer-encoding`, `connection`, `upgrade`; every name and value a non-empty string with no CR/LF.
- `assertEnvNames(read)` — ≤ `SANDBOX_MAX_ENV_ENTRIES`, each `^[A-Za-z_][A-Za-z0-9_]*$`, no duplicates, `'*'` refused (`invalid_arguments`).

## Broker — `src/runtime/broker.ts`

- `#dispatch`: `net.fetch` → `#fetch`, `env.read` → `#env`.
- `#fetch`: validate; loop redirects; return the result object. Map relay failures to the codes above; a denied host is `net_denied` with the host in the message (never the body).
- `#env`: return `{ values }` for the manifest's declared names only.
- Audit: `net.fetch` rows carry the URL (or `<redacted>` on denial), `env.read` rows carry the names — never a value.
- **Masking**: in `#log` (and in any message built from a payload), replace every resolved secret value of length ≥ 8 with `[redacted]`.

## Shim — `src/runtime/shim.ts`

- At init: one `call('env.read')` and build `ctx.env` as a **frozen** object; an ungranted name is absent (so `ctx.env.X` is `undefined`).
- `ctx.net.fetch(url, init)`: validate nothing (the host does), one `call('net.fetch', { url, method, headers, body })`, then build the VM-side object:
  ```js
  var body = value.body;
  return { ok: value.ok, status: value.status, statusText: value.statusText, url: value.url,
           headers: value.headers, body: body, text: body,
           json: function () { return JSON.parse(body) } };
  ```
  `json` closes over `body` — never `this` (a destructured call must work).
- Keep the existing house style: `var`, no imports, `String.raw`, ES5-ish, no arrow functions, no template literals inside the shim source. Respect `SANDBOX_MAX_BRIDGE_BYTES` chunking for the response body: a 4 MiB body must not cross in one call — reuse the chunked-read pattern already used by `fs.read` (`next` cursor) or the chunked envelope the entry point already uses. **Measure it**: a 3 MiB body must arrive intact and the runtime must dispose cleanly afterwards (see the note in `SECURITY.md` about the teardown abort).

## Creator — `src/creator/*`

- `prompt.ts`: replace every "no network" line with the real contract, stated as precisely as the rest of that prompt:
  ```
  ctx.net.fetch(url, { method, headers, body }) -> { ok, status, statusText, url, headers, body, text, json() }
    http(s) only, and only the hosts the manifest declares.
  ctx.env.NAME is a string when the manifest declares env.read ['NAME']; otherwise undefined.
  ```
  Under capabilities: `net: { hosts: ['api.example.com'] }` — `'*'` means any host; `env: { read: ['EXA_API_KEY'] }`. Keep the forbidden-identifier list unchanged.
- `review.ts`: remove the two `network_not_supported` refusals. New issue `capability_undeclared` when the source calls `ctx.net.fetch` (or `net.fetch`) without `net.hosts`, or reads `ctx.env.X` without `X` in `env.read`. Match the existing issue shape and keep the report stable.
- `capabilities.ts`: the human summary names `net hosts: …` and `env read: …`; drop the "the runtime does not support net.fetch today" line.
- `smoke.ts`: pass the manifest's `net`/`env` through to the runtime so a smoke test really calls the API; the manifest is the gate, and the smoke result keeps reporting denials.

## Docs

`README.md`: capability table (`net.hosts`, `env.read`), the `ctx` reference, «no network» sentences, the lint/issue table, the example manifest, and the `z1-tool` usage block.
`SECURITY.md`: rewrite the network section — what is enforced (allow-list per hop, scheme, method, header and size caps, timeout, audit, masked logs) and what is **not** (any host with `'*'`, no TLS pinning, no content inspection, a tool may exfiltrate anything it can read, secrets live in the VM heap while the call runs).
`AGENTS.md`: fix any "no network" invariant sentence.

## Tests

Match existing naming (`tests/*.spec.ts`). Cover at least:

1. Real loopback server (`node:http`, ephemeral port): GET, POST with body and headers, `json()`, `text === body`, `ok`, lower-cased header keys.
2. Allow-list: exact host allowed; another host → `net_denied`; `'*'` allows both; `net: false` on the runtime → `net_disabled` even when declared.
3. Redirect: 302 to an allowed path follows; 302 to a denied host is refused **before** the second request (the denied server records zero requests).
4. Response over the body cap → `output_too_large` (a request body over `SANDBOX_MAX_NET_REQUEST_BYTES` → `invalid_arguments`).
5. A server that never responds → `net_failed` inside the tool's `limits.timeoutMs` (use 1000).
6. `env`: declared visible, undeclared absent, `env: false` grants nothing, an 8+ char value is masked in `ctx.log` (capture with an audit/log sink).
7. `file://` → `invalid_arguments`; a `host` header → `invalid_arguments`; `env: { read: ['*'] }` → `invalid_arguments`.
8. Manifest: `net: { hosts: ['*'] }` and `env: { read: [...] }` normalise, default to `[]`, appear in `tool.json`.
9. A 3 MiB response body arrives intact and the runtime disposes without an abort (the SECURITY.md note).

## Report

Return: (a) files with +/- measured by `git diff --numstat` and `git diff --no-index --numstat /dev/null <new file>`; (b) the three gate outputs verbatim, last lines; (c) test count before/after; (d) every deviation from this brief with the reason; (e) residual risks you would add to `SECURITY.md`. Never claim a check you did not run.
