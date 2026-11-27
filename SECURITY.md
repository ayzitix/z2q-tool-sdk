# Security model

`z1-tool-sdk/runtime` executes a built tool bundle inside QuickJS-WASM (one
runtime per call) and exposes exactly one host function. This document says what
that boundary is, what it is not, and where the sharp edges are.

The authoring entry (`z1-tool-sdk`) is unaffected: it still only validates and
describes tools. Everything below lives behind the `z1-tool-sdk/runtime`
subpath.

## The boundary

Inside the VM a tool can reach exactly these globals, measured by
`tests/runtime-sandbox.spec.ts`:

- `globalThis.__z1_invoke(kind, payloadJson)` — the only host function. `kind` is
  one of `fs.read`, `fs.write`, `fs.list`, `fs.glob`, `fs.grep`, `process.run`,
  `net.fetch`, `env.read`, `log`. Every payload and every reply is limited to
  1 MiB; larger reads, writes, response bodies and results are chunked, never
  sent whole.
- `globalThis.__z1_args` and `globalThis.__z1_workspace` — two strings.
- `globalThis.__z1_ctx` — the `ToolContext` the shim builds over the bridge.
- `globalThis.__z1_run(argsJson)` — the entry point the host calls once.
- `globalThis.__z1_encode(offset, length)` — the result encoder: it returns
  `{ data, next }` chunks, never the whole envelope.
- `globalThis.__z1_value` — the tool's result, between `__z1_run` and the first
  `__z1_encode` call.
- `globalThis.console` — `log`, `info`, `warn`, `error`, `debug`, all mapped onto
  the `log` kind.

That list is the whole surface. If a review finds another name, it is a
regression.

There is no `process`, no `require`, no `fetch`, no timers, no `std`/`os`
modules and no `Buffer`. The network is reachable **only** through
`ctx.net.fetch`, which the host validates and relays; the VM itself has no
socket API. Module loading is limited to the bundle itself: any other request
(including every Node builtin) is refused when the loader is asked for it, with
an `invalid_tool` error naming the module.

## Capability policy

The broker reads the manifest and enforces it on every call:

1. Paths are workspace-relative, `/`-separated, at most 1024 characters, with no
   NUL bytes, no `\`, no leading `/`, `~`, drive letter or UNC prefix, and no
   `.`/`..` segments. A segment containing `:` is refused (an NTFS alternate data
   stream such as `.env::$DATA` reads the real `.env`), as is a segment that ends
   in `.` or a space (Windows strips them, so `.git.` is `.git`) and any reserved
   device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, with or
   without an extension).
2. The resolved path must stay inside the workspace, and so must its **realpath**
   — an existing target is realpath'd itself, a new one through its deepest
   existing ancestor. That is what stops a junction or symlink inside the
   workspace from reaching `~/.ssh`.
3. Denied segments anywhere (case-insensitive): `.git`, `.z1`, `.z1-sessions`,
   `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `.svn`, `.hg`.
4. Denied file names/patterns (case-insensitive): `.env`, `.env.*`, `*.pem`,
   `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `id_rsa*`, `id_ed25519*`,
   `id_ecdsa*`, `credentials`, `.netrc`, `.npmrc`, `.git-credentials`. A trailing
   `:stream` is stripped before the match, so the list always sees `.env`.
5. Rules 3-4 are re-checked on the **real** target, relative to the real
   workspace root: a junction inside the workspace that points at `.git` is
   refused for `repo/config` even though the literal path is clean. The same
   check filters `fs.glob` results and `fs.list` entries.
6. A grant must match (`capabilities.fs.read` / `fs.write`) using the same
   `globToRegExp` the SDK already ships; on win32 both the grant and the path are
   folded to lower case, because the filesystem is. No grant, no access. A
   directory is listable when a grant matches the directory itself or anything
   beneath it, so `docs/**` can list `docs`.
7. Writes need an existing parent inside the workspace, must not target a
   directory, and must not realpath outside the workspace.
8. Globs are validated (512 characters, no `..`, no absolute patterns, no `\`)
   and their results are filtered through rules 3-5, so `**/*` never reveals
   `.git/config`. `fs.list` applies the same filter to every entry and to the
   directory itself, so a listing never shows a name no grant covers.
9. `process.run` is argv-only, never a shell string. `argv[0]`'s basename must be
   listed in `capabilities.process.argv` (case-insensitive on Windows), `cwd`
   obeys rules 1-3, and environment overrides of `NODE_OPTIONS`, `LD_PRELOAD`,
   `DYLD_*`, `PYTHONPATH`, `GIT_*`, `BASH_ENV`, `ENV` and `SHELL` are refused.
10. `fs.grep` refuses unknown option keys instead of ignoring them: only `glob`
    and `ignoreCase` are accepted, so `{ path: '.git' }` fails rather than
    searching the whole workspace.

### Child processes

A child gets an OS allow-list, never the host environment: `PATH`, `PATHEXT`,
`SystemRoot`, `windir`, `TEMP`, `TMP`, `HOME`, `USERPROFILE`, `APPDATA`,
`LOCALAPPDATA`, `COMSPEC`, `OS`, `NUMBER_OF_PROCESSORS`,
`PROCESSOR_ARCHITECTURE`, `LANG`, `LC_ALL` — matched case-insensitively on
Windows and copied only when present. Everything else the host holds (tokens,
API keys, its own settings) is invisible to the child. Inheritance is an explicit
opt-in (`process: { inheritEnv: true }`) and a host-supplied `process: { env }`
replaces the allow-list. A tool's own `env` merges on top and still cannot
override the keys listed in rule 9.

A refusal is thrown into the VM as `Error('<code>: <detail>')` so a tool can
catch it; if it reaches the host, it becomes a `ToolRuntimeError` with the same
code.

### Self-protection: the runtime a tool must not break

A tool may not write into the runtime that executes it. A broken runtime cannot
be repaired by the agent that broke it, so this is a policy refusal, not a prompt
instruction:

- `node_modules` is never writable at any depth, whoever owns it. Reading stays
  allowed, because inspecting a dependency damages nothing.
- `protectedRoots` (absolute paths the host passes to `createToolRuntime`: the CLI
  checkout, the SDK checkout, the agent home) are never writable. A workspace that
  *is* one of those roots is refused outright: every write in it would land in the
  code that is executing the tool.
- Both fail with `protected_path` before the approval prompt, and the refusal names
  the runtime directory it refused.

Creating a tool is unaffected: the Tool Creator writes through the host, not
through the tool sandbox. Only the generated tool's own `ctx.fs.write` is bound.

## Limits

| Limit | Value | Enforced by |
| --- | --- | --- |
| Memory | 128 MiB per call | `runtime.setMemoryLimit` |
| Stack | 1 MiB | `runtime.setMaxStackSize` |
| Time | 60 s ceiling (manifest and per-call values may lower it) | interrupt handler + broker deadline check |
| Bridge | 1 MiB per crossing | shim and broker chunk reads, writes, results and arguments |
| Result size | 8 MiB ceiling, still capped by the manifest | host, after serialization |
| Bundle | 8 MiB | `loadToolPackage` |
| Job pump | 100 000 pending jobs | `loop_limit` |
| Audit rows | 1 000 per call, then one `audit_limit` row | audit collector |
| Net body | 4 MiB per response, then `output_too_large` | relay helper, before it crosses the bridge |
| Net request | 1 MiB per request body | broker, and the 1 MiB bridge cap before it |
| Net headers | 64 per request | broker |
| Net redirects | 5 hops | broker, one validated request per hop |
| Net time | 15 s default, never past the call deadline | helper's `AbortSignal.timeout` + `spawnSync` timeout |
| Env names | 32 per manifest | `defineTool` and the broker |

`setInterruptHandler` stops busy loops. A tool that awaits a promise that can
never settle is caught by the pump loop and fails with `loop_limit`. The deadline
is a bytecode check, not a wall-clock kill: `while (true) {}` stops within a few
milliseconds, but an allocation-bound tool can overrun the budget by seconds at
the default heap — measured: `for (;;) chunks.push('x'.repeat(4MB))` reported
`time_limit` after **12.6 s against a 500 ms budget**. `tests/runtime-bridge.spec.ts`
pins the code and the fact that it can overrun, never a tight bound.

## What the sandbox does not protect against

- **A malicious tool is still code you chose to run.** The definition read is
  sandboxed, but once the host invokes the tool it has every capability the
  manifest declares. Treat generated code as untrusted and keep the approval.
- **TOCTOU.** Path checks happen before the read or write. A workspace the tool
  can also modify through another process could change between the check and the
  operation.
- **`fs.grep` patterns are compiled on the host.** A pathological regular
  expression can burn host CPU; the interrupt handler cannot stop a host regex.
  Patterns are capped at 4096 characters, which is not a ReDoS defence.
- **Symlinks are not followed by `fs.glob`/`fs.grep`.** They are skipped during
  the walk; a link inside the workspace can still be read through `fs.read` when
  its realpath resolves inside the workspace.
- **`process.run` cannot be interrupted mid-run.** The run is synchronous; a
  caller abort is observed before and after the child, and the child itself is
  bounded by `min(remaining budget, process.timeoutMs)`. On timeout Node kills
  the direct child only.
- **`stderr` of a successful child is not captured.** `execFileSync` exposes
  `stdout` on success and both streams only on failure; the runtime follows the
  brief and uses `execFileSync`. A tool that needs stderr should let the child
  fail, or write to a file.
- **The deny lists are lists.** They are not a sandbox boundary by themselves:
  files the OS lets you read are readable if they are inside the workspace,
  match a grant and are not on a list. Add your own checks for anything more
  sensitive.

## Network

`ctx.net.fetch` is implemented, but not in the VM. The bridge is one synchronous
JSON function and a fetch is not synchronous, so the broker spawns the **same
Node binary** with an inline ESM helper (`node --input-type=module -e …`), blocks
the host thread on it, and returns the decoded hop. Nothing ambient reaches that
child: its environment is `{}`, its stdin is the one request, its stdout is the
one reply, and it exits 0 even for a failed request so the failure travels in the
JSON instead of stderr. No `curl`, no shell, no new dependency.

### What is enforced

1. **Scheme.** `http:` and `https:` only. `file:`, `data:`, `ftp:` and every
   other scheme are refused as `invalid_arguments` before a socket exists, as is
   a URL carrying `user:pass@` (those credentials would travel as a header the
   audit cannot see) and a URL with a NUL byte or over 2048 characters.
2. **Host, on every hop.** `capabilities.net.hosts` is the allow-list: exact
   names, `*.example.com` (the apex and any subdomain) or `*` (any host — the
   product decision a host makes when it grants full network access). An IP
   literal is allowed only when listed verbatim or through `*`. When the host
   passes `createToolRuntime({ net: { hosts } })`, the URL host must be covered
   by **both** lists; `net: false` fails every call with `net_disabled`.
3. **Redirects.** The helper uses `redirect: 'manual'` and reports `location`;
   the broker resolves it against the current URL, validates the new host, and
   only then issues the next request. A redirect to a host the manifest does not
   list is refused as `net_denied` **before** the second request, so a denied
   host never sees even a connection. At most 5 redirects are followed; a sixth
   fails with `net_failed`. `303` becomes a `GET` and drops the body, `301`/`302`
   turn a `POST` into a `GET` the same way, and `307`/`308` keep method and body.
4. **Method.** `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, upper-
   cased. Anything else is `invalid_arguments`.
5. **Headers.** At most 64. `host`, `content-length`, `transfer-encoding`,
   `connection` and `upgrade` are refused (`invalid_arguments`) rather than
   dropped, because a tool must not believe it sent something it did not. Every
   name and value must be a non-empty string with no CR, LF or NUL, so a value
   cannot split the header block.
6. **Size.** A response body over 4 MiB is cancelled in the relay and fails with
   `output_too_large`; a request body over 1 MiB is `invalid_arguments`. The
   bridge's own 1 MiB cap already refuses a larger payload first.
7. **Time.** One fetch gets `min(SANDBOX_DEFAULT_NET_TIMEOUT_MS, remaining call
   budget)`. The relay hands the helper an absolute abort instant — the
   deadline minus a 250 ms reserve — instead of a duration, so a slow Node
   start-up shortens the request window rather than pushing the abort past the
   deadline: the tool sees `net_failed`, not the call's `time_limit`. The child
   is always killed at the call deadline.
8. **Audit and logs.** A `net.fetch` allow row carries the URL; a denial row
   carries `<redacted>`, so the query string of a refused request — which can
   hold exactly the credential the tool could not send — never lands in a sink.
   `env.read` rows carry the granted names, never a value. In every log line and
   every refusal message, a resolved secret value of 8+ characters is replaced
   with `[redacted]`.

### What is not enforced

- **No TLS pinning, no certificate opinion, no content inspection.** The relay
  trusts Node's default trust store, exactly like any other `fetch`.
- **`'*'` is any host.** A manifest that declares it can reach the whole
  internet, and the runtime will not stop a tool from sending what it can read.
  `SECURITY.md`'s rule holds: capabilities are grants, not a filter.
- **No egress control beyond the host name.** A port and a path are the tool's
  choice: `net.hosts: ['api.example.com']` also allows `api.example.com:8443`
  and any path on it. There is no per-path, per-method or per-header policy.
- **No SSRF defence.** The allow-list is the only check, so a host that lists
  `'*'` — or `127.0.0.1` — lets a tool reach this machine's own services:
  loopback ports, `169.254.169.254` and the cloud metadata endpoints, a local
  admin UI, another tool's dev server. Nothing distinguishes a public host from
  a private address, and no address class is refused. A manifest that really
  needs the internet and not the host should name its hosts instead of `'*'`.
- **The request-body cap is shadowed by the bridge cap.** `SANDBOX_MAX_NET_REQUEST_BYTES`
  is 1 MiB, the same as `SANDBOX_MAX_BRIDGE_BYTES`, and the body travels inside
  the JSON payload, so the bridge refuses an oversized body first (measured: a
  1 MiB + 64 byte body fails as `invalid_arguments` naming the 1 048 576 byte
  bridge limit, before the broker's own check runs). The effective ceiling is
  therefore slightly *under* 1 MiB, because the URL, method and headers share
  the same payload.
- **Response headers are not counted by this runtime.** Only the body has a
  policy cap. A response whose header block is large is refused by Node's own
  HTTP client before the runtime sees it (measured against the helper: ten 1 KiB
  headers pass, a hundred fail as `net_failed` with `fetch failed`), so an
  oversized header set cannot reach `ctx.net.fetch` — but the ceiling is undici's
  default, not a number this SDK sets, and it is not configurable here.
- **Every fetch starts a Node process.** The relay reserves 250 ms of the
  budget for that start-up and the reply, measured at roughly 100-115 ms per
  fetch on a warm Windows machine. A call whose remaining budget is under about
  250 ms therefore fails as `net_failed` almost immediately — the request may be
  opened and aborted before it completes, so a server can still see a connection
  with no request. A host that sets a tight `limits.timeoutMs` chooses that
  failure mode.
- **A blocked body is not a blocked response.** The relay reads up to 4 MiB
  before it gives up; `HEAD` and a 204/304 response have no body at all.
- **The body is UTF-8.** A binary payload comes back lossy, and the lossy string
  is what the tool sees and what its result carries.
- **A body that is mostly escapable characters can hit the relay buffer.**
  `spawnSync`'s `maxBuffer` is the 4 MiB body cap plus 64 KiB, measured on
  stdout, where JSON escaping can multiply a body of quotes or backslashes. The
  call fails with `output_too_large`; it does not corrupt anything.
- **Secrets live in two heaps while a call runs.** The resolved values are in
  the host's broker (for masking) and in the VM's `ctx.env` for the duration of
  the call; `env: false` and `inherit: false` narrow that, and nothing wipes the
  strings afterwards. A tool can exfiltrate any secret it is granted through any
  host `net.hosts` allows.
- **The URL is recorded in the clear.** The audit target of an allowed fetch is
  the full URL, including its query string, so do not put a secret in a URL the
  tool is allowed to request.

## Audit

Every bridged call writes a row: `ts`, `tool`, `version`, `kind`, `decision`
(`allow`/`deny`), the runtime `code` for denials, a `target` and a duration.
`target` is the workspace-relative path, the `argv[0]` basename, or the kind. It
is never file contents, never an absolute host path, and never a denied secret
name — secret denials record `target: '<redacted>'`.

Rows are capped per call; when the cap is hit the sink sees one summary row with
`code: 'audit_limit'`. A sink that throws is ignored after one warning: auditing
never breaks a tool call.

## Tool Creator

`z1-tool-sdk` also ships the deterministic half of a tool creator
(`src/creator/*`, exported from the package root). It is authoring-side code. The
static review is an advisory lint; the boundary is the QuickJS sandbox, including
the sandboxed definition read that `buildTool` now uses. This section says what
each part guarantees and what it does not.

### What the creator guarantees

- `reviewToolSource(source)` is synchronous and static. It never executes the
  source, never loads it and never touches the filesystem. Its rules are closed
  (rules 1-10 in the README, plus the `scan_failed` lexer outcome): size and
  ESM/`defineTool` shape, allowed imports, forbidden identifiers, a literal
  `capabilities` object, bare `process.argv` names, workspace-relative `fs`
  grants, the limit ceilings and a literal description of at least 20
  characters, plus `capability_undeclared` for a `ctx.net.fetch` or
  `ctx.env.NAME` the declaration does not cover. Any issue means refuse. It is
  an advisory lint: passing proves shape, not intent.
- **`buildTool` never imports the bundle on the host.** `src/runtime/definition.ts`
  creates a fresh QuickJS runtime, serves the bundle from a module loader, and
  imports it with no bridge: no `__z1_invoke`, no `__z1_args`, no `console`
  passthrough, no host function. Only the manifest JSON leaves the VM, capped at
  1 MiB inside the VM before it crosses. A bundle containing a static import that
  survived bundling fails with the "bundle everything" message, except for
  `node:*`: esbuild always leaves those external, so the reader serves an inert
  module whose bindings are `undefined` and the runtime keeps its own node-builtin
  refusal at run time. A thrown value is capped inside the VM before it crosses,
  so an attacker-sized error cannot allocate on the host; while it disposes its
  own runtime the reader filters the one measured teardown assertion line
  (`Aborted(Assertion failed: list_empty(&rt->gc_obj_list) …`), so a review of
  hostile text stays readable, and the guarded dispose keeps any remaining
  teardown abort from propagating as an exception. `verifyToolSource`,
  `createToolProject`, `smokeTestTool`, `installTool`, `z1-tool build` and the
  definition read behind `z1-tool test` all inherit this boundary.
- **The boundary covers the tool entry, not the project's dependencies.**
  `buildTool` loads the project's own `esbuild` (measured: a project-local
  `node_modules/esbuild` runs on the host before the tool source is read), and
  `z1-tool test` runs the project's own vitest suite when vitest is installed.
  Point a build or an install at a directory whose dependency tree you trust;
  `npm install` already dominates that risk.
- `installTool` always rebuilds when `tool.ts` exists, so a stale `dist/` is
  never signed; a dist-only directory needs `expectSha256` or
  `allowPrebuilt: true`. It recomputes the sha256 with `node:crypto`, refuses a
  invalid grants or oversized limits in the manifest, copies exactly
  `dist/tool.json` and `dist/index.js`, re-reads the copied bytes and the copied
  manifest, writes `approval.json`, and never overwrites a version.
  `expectSha256` / `expectCapabilities` refuse a build different from the one the
  caller reviewed, before anything is written.
- `loadInstalledTool` rechecks the bundle sha256, the manifest name and version,
  and the capabilities against `approval.json` on every load. A tampered bundle
  or `tool.json` is refused.
- Generated capabilities must be literal declarations. A computed declaration
  is refused precisely so the decision happens before the build. `net` and
  `env` are read like the other declarations, and a call they do not cover is
  `capability_undeclared`. The static ceilings are 32 KiB of
  source, `timeoutMs <= 60000`, `maxOutputBytes <= 8388608` and a description of
  at least 20 characters.
- `describeCapabilities` only reads the manifest: it never grants, opens or
  runs anything, and it quotes values so a grant cannot break the prompt into
  extra lines.

### What it does not guarantee

- **Intent, not shape.** The lint cannot prove what a tool does or that it is
  safe. A source that passes every rule is still code. It runs only when the
  host invokes it, inside QuickJS with the capabilities the manifest declares,
  and the sandbox is the boundary. The lint is not a JavaScript verifier:
  reflection and dynamic property access are not modeled, and the identifier
  list does not include every ambient global. Treat generated code as untrusted
  even after a pass, and keep the human approval in the loop.
- **The file can change between review and build.** `installTool` always
  rebuilds `tool.ts` before signing, rechecks the copied bytes and manifest, and
  binds the approval to the sha and capabilities it read. A dist-only directory
  is refused unless the caller passes `expectSha256` or `allowPrebuilt: true`;
  `loadInstalledTool` catches later modification.
- **`listInstalledTools` is a reader, not a verifier.** It does not rehash the
  bundle; `loadInstalledTool` does. Use the latter at run time.
- **The review is lexical.** Strings, comments and template text are skipped;
  template interpolations are code; identifier escapes are decoded; property
  names and member accesses are names (which is what lets `ctx.process.run` and
  the `process: { argv }` capability key reach rules 7 and 8). Regex literals
  are skipped where the scanner can tell them from division; an ambiguous slash
  (after `}`, `+`/`-`, a control-condition `)`, or the contextual `of`) is
  `scan_failed`, refused rather than guessed. A
  computed description or capabilities declaration is refused rather than
  evaluated.
- **The lint is not the build boundary.** `buildTool` reads the definition in
  QuickJS with no bridge, so `z1-tool build`, `z1-tool test`'s build path and
  every creator build avoid a host import. Do not reintroduce one. The sandbox
  still grants whatever the manifest declares; a valid capability is not a
  safety proof.
- **No provider and no model in the creator.** `src/creator/*` never calls a
  model and ships no provider client; the host owns the model call and the
  approval. The runtime's `ctx.net.fetch` relay (see Network) is the package's
  only outbound path, and a creator flow never opens it.

The `approval.json` hash covers `dist/index.js`; the capabilities comparison
covers `dist/tool.json`. Extra files are not copied. `--tools` defaults to
`./.z2q/tools`, the same root `createToolCreator` installs into under its
workspace, and `z1-tool installed` always prints the root it read. That root and
`<workspace>/.z2q/proposals` are **not** on the sandbox deny list (`.z1` is, and
`.z2q` is not), so a tool whose workspace is the project root and whose manifest
grants a broad `fs.read` can read other tools' bundles, their `tool.json`, their
`approval.json` and the generated proposal sources (measured:
`tests/runtime-policy.spec.ts` reads an installed `approval.json` through a
`**/*` grant and is refused `.z1/sessions`). Keep the tools root outside any
workspace a tool is granted when that matters.

## Known QuickJS issue: the teardown abort

`quickjs-emscripten@0.32.0` (the pinned version) can make `runtime.dispose()`
throw `Aborted(Assertion failed: list_empty(&rt->gc_obj_list), ... JS_FreeRuntime)`,
which the WASM module also prints to stderr. It is not caused by zod and not by a
leaked handle: the context-level leak detector stays silent, and the same call
with a hand-written bundle behaves the same way. Measured on this checkout, one
case per child process:

| Trigger | Aborts |
| --- | --- |
| 4 MB `fs.read` with a middle `slice()` | no |
| 6 MB `fs.read`, length only | no |
| 6 MB `fs.read` in 128 KiB chunks | no |
| 6 MB `fs.write` (128 KiB chunks, one flush) | no |
| 6 MB result through the chunked envelope | no |
| 3 MB `ctx.net.fetch` body, 128 KiB chunks | no |
| 8 MB argument object | refused: `invalid_arguments` |
| 8 MB `fs.read`, head and tail slices | no |
| 6 MB `fs.read`, then a middle `slice()` | **yes** |
| text outside Latin-1 above ~2.4M code units, then a slice | **yes** |
| `Array.prototype.join` of 1 MiB pieces into 4 MB | **yes** |
| a bundle that allocates 9 MB inside the async frame | **yes** |
| the same allocation at 1 MB or 4 MB | no |
| stack overflow (runaway recursion) | **yes** |

The runtime sidesteps the rows it can: every payload is chunked at 1 MiB, reads
ask for 128 KiB at a time, read results are built with `+=` rather than `join`,
and the result encoder runs as a top-level script in chunks. What remains is a
library bug, not a policy hole:

- in every "yes" row the call's own result is still correct, the shared WASM
  module stays usable, later calls are correct, and the abort is a catchable
  `RuntimeError` thrown from `dispose()` — `disposeCall`'s `try/catch` is what
  keeps the process alive;
- keep one call's strings under a few megabytes, and treat a middle `slice()` of
  a string above ~6 MB as the sharp edge it is.

`tests/runtime-bridge.spec.ts` runs the abort-prone cases (stack overflow, the
allocating loop) in their own child processes and captures stderr, so `npm test`
never prints an abort and each measured row above is reproducible.

## Tool creation flow

`createToolCreator({ generate })` is a host-side flow around the pieces above:

- The model's reply is **untrusted input**. It is extracted from a fence, linted,
  built by the sandboxed definition reader, and smoke-tested in QuickJS. Nothing
  in the flow imports the generated source on the host or calls `run` outside the
  sandbox.
- `propose()` writes a project tree under `proposalDir` (default
  `<workspace>/.z2q/proposals`). Treat that directory as untrusted content: it
  holds the model's source. A failed build or smoke test leaves the project there
  for inspection; nothing cleans it up.
- `install()` is the only writer into `toolsDir`, and the proposal's sha256 is
  authoritative: a bundle that changed after its smoke test is refused, and an
  `expectSha256` that disagrees is refused rather than accepted as an override.
  `approval.json` is a plain record, not a signature — a hand-edited
  `approvedBy`/`installedAt` is accepted while the sha256 and the capabilities are
  rechecked.
- A junction or symlink planted at the project path or at `<toolsDir>/<name>` is
  refused: both are created with `lstat` plus a non-recursive `mkdir`.
- The `workspace` you pass is the smoke test's workspace, and the generated tool
  runs there with the capabilities it declares. Use a dedicated test directory,
  not your working tree.

## Reporting

This is a small SDK under active development (`0.1.x`). Report a sandbox escape
or policy bypass privately to the maintainer listed in `package.json` rather
than in a public issue.
