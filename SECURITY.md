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
  `net.fetch` (always refused), `log`. Every payload and every reply is limited
  to 1 MiB; larger reads, writes and results are chunked, never sent whole.
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
modules, no `Buffer`, and no network. Module loading is limited to the bundle
itself: any other request (including every Node builtin) is refused when the
loader is asked for it, with an `invalid_tool` error naming the module.

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

`setInterruptHandler` stops busy loops. A tool that awaits a promise that can
never settle is caught by the pump loop and fails with `loop_limit`. The deadline
is a bytecode check, not a wall-clock kill: `while (true) {}` stops within a few
milliseconds, but an allocation-bound tool can overrun the budget by seconds at
the default heap — measured: `for (;;) chunks.push('x'.repeat(4MB))` reported
`time_limit` after **12.6 s against a 500 ms budget**. `tests/runtime-bridge.spec.ts`
pins the code and the fact that it can overrun, never a tight bound.

## What the sandbox does not protect against

- **A malicious tool is still code you built.** `buildTool` imports the entry in
  the host to read its definition; that is outside the sandbox. Review a tool
  before building it.
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

v1 implements no `net.fetch`. The VM bridge is a single synchronous JSON
function, and a fetch is not synchronous; `ctx.net.fetch` therefore always fails
with `net_not_supported`, and `createToolRuntime({ net: { hosts } })` is refused
at creation. The z1 host performs network access outside the sandbox, where it
can apply its own allow-list.

## Audit

Every bridged call writes a row: `ts`, `tool`, `version`, `kind`, `decision`
(`allow`/`deny`), the runtime `code` for denials, a `target` and a duration.
`target` is the workspace-relative path, the `argv[0]` basename, or the kind. It
is never file contents, never an absolute host path, and never a denied secret
name — secret denials record `target: '<redacted>'`.

Rows are capped per call; when the cap is hit the sink sees one summary row with
`code: 'audit_limit'`. A sink that throws is ignored after one warning: auditing
never breaks a tool call.

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

## Reporting

This is a small SDK under active development (`0.1.x`). Report a sandbox escape
or policy bypass privately to the maintainer listed in `package.json` rather
than in a public issue.
