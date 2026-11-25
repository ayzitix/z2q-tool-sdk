# z1-tool-sdk

A small library for authoring **z1 tools** without importing z1-sdk internals.

It defines the tool shape, capabilities, a typed context, an in-memory test
harness, a deterministic manifest, and a build/pack CLI. The runtime (host
broker or QuickJS) injects the context; **the SDK never grants anything itself**.

Status: early. `0.1.0`, API may still change. Node.js >= 20.

## Install

```sh
npm install z1-tool-sdk zod
npm install --save-dev esbuild typescript
```

This SDK uses **zod 4** (`^4.6.7`) for parameter schemas. Your tool imports
`zod` directly; `esbuild` is only needed by `buildTool` / `z1-tool build`.

## Quick start

```ts
import { defineTool } from 'z1-tool-sdk';
import { z } from 'zod';

type Match = { path: string; line: number; text: string };

export const tool = defineTool({
  name: 'tool.find-todos',
  version: '0.1.0',
  description: 'Find TODO comments in workspace files.',
  parameters: z.object({
    glob: z.string().default('**/*').describe('Files to scan.'),
  }),
  capabilities: {
    fs: { read: ['**/*'] },
    limits: { timeoutMs: 10_000 },
  },
  run: async (ctx, args) => {
    const files = await ctx.fs.glob(args.glob);
    const matches: Match[] = [];
    for (const path of files) {
      const text = await ctx.fs.read(path);
      text.split('\n').forEach((line, index) => {
        if (line.includes('TODO')) matches.push({ path, line: index + 1, text: line.trim() });
      });
    }
    return { matches, count: matches.length };
  },
});
```

`defineTool` validates the definition and returns:

- `manifest` — frozen, plain JSON: `schemaVersion: 1`, `name`, `version`,
  `description`, `parameters` (JSON Schema) and `capabilities` with defaults.
- `parameters` — the zod 4 schema, kept for runtime validation. The manifest
  holds the draft-2020-12 JSON Schema produced by `z.toJSONSchema` in input
  mode, so defaulted fields stay optional and keep their `default`.
- `run` — your function. Raw arguments are trusted; hosts should call
  `runTool(tool, args, ctx)` instead.

Names must match `^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$` and be 3–64 characters.
`tool.<slug>` is recommended but not required. Versions are strict semver.

## Capabilities

Capabilities are **declarations**, not enforcement. The runtime broker reads the
manifest and decides what to allow; the SDK only normalizes the request.

| Capability | Default | Meaning |
| --- | --- | --- |
| `fs.read` | `[]` | Workspace-relative globs the tool may read. |
| `fs.write` | `[]` | Workspace-relative globs the tool may write. |
| `process.argv` | `[]` | Executables the tool may start (`argv[0]`). Never a shell string. |
| `net.hosts` | `[]` | Host allow-list for `ctx.net.fetch`. |
| `limits.timeoutMs` | `30000` | Call budget, checked between bytecodes: an allocation-bound tool can overrun it by seconds (see [SECURITY.md](./SECURITY.md)). |
| `limits.maxOutputBytes` | `1048576` | Captured stdout/stderr budget per call. |
| Runtime | — | `z1-tool-sdk/runtime` enforces every row above inside QuickJS. Anything not granted is denied. |

Arrays are trimmed, de-duplicated and sorted so manifests are deterministic.
Unknown capability keys and non-positive limits are rejected.

`process.run` takes `{ argv, cwd?, env?, stdin? }` and rejects an empty argv at
the SDK boundary. `fs` paths may be workspace-relative or absolute inside the
workspace; the test harness rejects lexical escapes, and the runtime still owns
the real check (symlinks, mounts, TOCTOU).

A child process gets an OS allow-list, not the host environment: `PATH`,
`PATHEXT`, `SystemRoot`, `windir`, `TEMP`, `TMP`, `HOME`, `USERPROFILE`,
`APPDATA`, `LOCALAPPDATA`, `COMSPEC`, `OS`, `NUMBER_OF_PROCESSORS`,
`PROCESSOR_ARCHITECTURE`, `LANG`, `LC_ALL`, copied only when present. Opt in to
full inheritance with `createToolRuntime({ process: { inheritEnv: true } })`, or
supply `process: { env: { … } }` yourself; a tool's own `env` merges on top.

## Testing

`createTestContext` builds an in-memory `ToolContext`. Capabilities are opt-in:
`fs` needs `files`, `process` needs `commands`, `net` needs `fetches`. Anything
else throws a clear error instead of silently succeeding.

```ts
import { createTestContext, runTool } from 'z1-tool-sdk';
import { describe, expect, it } from 'vitest';

it('finds todos', async () => {
  const ctx = createTestContext({
    files: { 'src/a.ts': '// TODO: later\nconst a = 1;\n' },
    commands: [
      { argv: ['adb', 'devices'], handler: () => ({ stdout: 'device-1\tdevice\n' }) },
    ],
    fetches: [
      { url: /^https:\/\/api\.example\.com\//, handler: () => ({ body: '{"ok":true}' }) },
    ],
  });

  const result = await runTool(tool, {}, ctx);

  expect(result).toMatchObject({ count: 1 });
  expect(ctx.calls.map((call) => call.kind)).toEqual(['fs.glob', 'fs.read']);
  expect(ctx.files()['src/a.ts']).toContain('TODO');
});
```

The harness supports `read`, `write`, `list`, `glob` (`*`, `**`, `?`) and `grep`
over memory, exact-argv command handlers, URL or RegExp fetch handlers, an
`AbortSignal`, and a recorder (`ctx.calls`, `ctx.reset()`). It never touches the
network or the real filesystem.

## Running tools

`z1-tool-sdk/runtime` executes a built tool inside QuickJS-WASM and exposes only
a brokered capability surface. One QuickJS runtime is created per call, so a tool
cannot leave state behind for the next call.

```ts
import { createMemoryAuditSink, createToolRuntime } from 'z1-tool-sdk/runtime';

const audit = createMemoryAuditSink();
const runtime = await createToolRuntime({
  workspace: '/home/me/project', // the only filesystem root the VM can reach
  audit, // a sink, an array, or nothing
});

const result = await runtime.run('./my-tool', { glob: '**/*' });
console.log(result.value); // the tool's JSON result
console.log(result.tool, result.version, result.durationMs);
console.log(result.audit); // one row per allow and per denial

await runtime.run('./my-tool', {}, { timeoutMs: 5_000 }); // lower this call only
```

`run` takes a tool directory (`dist/tool.json` + `dist/index.js`) or a
`ToolPackage` you already loaded with `loadToolPackage(dir)`. Failures reject
with a `ToolRuntimeError` carrying an exact `code` from `ToolRuntimeCode`:
`invalid_tool`, `invalid_arguments`, `invalid_output`, `capability_denied`,
`path_outside_workspace`, `path_denied`, `secret_path_denied`,
`process_argv_denied`, `process_failed`, `process_timeout`, `net_not_supported`,
`time_limit`, `memory_limit`, `loop_limit`, `output_too_large`, `tool_threw`,
`audit_limit`.

The VM gets exactly this: one host function `__z1_invoke(kind, payloadJson)` and
these globals — `__z1_args`, `__z1_ctx`, `__z1_encode`, `__z1_run`,
`__z1_workspace`, `__z1_value`, `console` — with a `ToolContext` the shim builds
on top. The kinds are `fs.read`, `fs.write`, `fs.list`, `fs.glob`, `fs.grep`,
`process.run`, `log` (and `net.fetch`, which is always refused). `SECURITY.md`
lists the globals with the test that measures them, so a new one is visible in
review.

What it gives you:

- a workspace-confined filesystem: relative paths only, realpath containment
  checked before the open (not atomically — a concurrent writer can race it, see
  [SECURITY.md](./SECURITY.md)), deny lists for VCS and cloud credential
  directories and for secret-like file names, refused NTFS streams and device
  names, the deny lists re-checked on the real target of a junction, and a grant
  match through the same glob matcher the SDK ships;
- argv-only child processes, with `argv[0]` grants, a checked `cwd`, refused
  environment overrides, and captured output under a byte cap;
- per-call memory, stack, time, result-size and job-pump limits, plus an
  interrupt handler that stops `while (true) {}`;
- audit rows for every allow and every denial, with redacted secret paths;
- structured errors that survive the QuickJS boundary.

What it does not do (see [SECURITY.md](./SECURITY.md)):

- no network — `ctx.net.fetch` always throws `net_not_supported`, and
  `net: { hosts }` is refused at creation;
- no `process`, `require`, `fetch`, timers, `Buffer`, or Node builtins; a bundle
  that imports one is refused as `invalid_tool` with the module named;
- no mid-call abort inside `process.run` (the child is bounded by a timeout), and
  no `stderr` capture for a child that succeeds;
- no protection against host-side regex cost in `fs.grep`, or TOCTOU against a
  workspace another process is editing;
- no way around one remaining QuickJS bug: a middle `slice()` of a string above
  about 6 MB, or text outside Latin-1 above ~2.4M code units, still makes
  teardown abort (the call's result is correct and the process survives; the
  measured table is in [SECURITY.md](./SECURITY.md)).

`ctx.signal` is a frozen `{ aborted: false }`: a synchronous VM cannot observe an
abort mid-call, so the host ends the call instead.

### `z1-tool run`

```sh
npx z1-tool build                     # writes dist/tool.json + dist/index.js
npx z1-tool run . --args '{"glob":"**/*"}' --workspace ../my-project
```

`run <dir>` loads the built package, runs it with the given arguments (default
`{}`) in the sandbox, and prints the JSON value on one line. `--workspace`
defaults to the current directory. On failure it prints one line with the
runtime code and exits 1. Tool logs (`ctx.log`, `console.log`) go to stderr.

## Build and pack

```sh
npx z1-tool init my-tool        # scaffold ./my-tool
cd my-tool && npm install
npx z1-tool build               # dist/index.js + dist/tool.json
npx z1-tool test                # vitest if installed, else a manifest smoke check
npx z1-tool pack                # my-tool-0.1.0.tgz, prints path and sha256
```

Programmatic equivalent:

```ts
import { buildTool } from 'z1-tool-sdk';

const result = await buildTool({ entry: 'tool.ts' });
// result.bundlePath, result.manifestPath, result.manifest
```

`buildTool` bundles with esbuild (ESM, Node 20, dependencies included), imports
the bundle **only to read its definition**, and writes `tool.json`. It never
calls `run`. esbuild is resolved from the tool project first, then from the SDK
installation.

`z1-tool pack` produces a gzipped tar containing exactly `tool.json`,
`dist/index.js`, `package.json` and `LICENSE`. If the project has no `LICENSE`,
a standard MIT text is generated from `package.json`'s author.

## Manifest

```json
{
  "schemaVersion": 1,
  "name": "tool.find-todos",
  "version": "0.1.0",
  "description": "Find TODO comments in workspace files.",
  "parameters": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {}
  },
  "capabilities": {
    "fs": { "read": ["**/*"], "write": [] },
    "process": { "argv": [] },
    "net": { "hosts": [] },
    "limits": { "timeoutMs": 10000, "maxOutputBytes": 1048576 }
  }
}
```

The manifest contains no functions and is stable for the same input. Its
`parameters` value is draft-2020-12 JSON Schema. `tool.json` is the SDK's
contract with the runtime; no z1-sdk import is involved.

## Security model

- The manifest is **declarative**. `defineTool` only records what the tool asks
  for; it does not grant, open, spawn or fetch anything.
- The **runtime broker enforces** capabilities. It constructs the `ToolContext`,
  decides which calls are allowed, and applies time/output limits. A tool that
  asks for `fs.read` still gets nothing unless the host grants it.
- The SDK validates what it can see: definition shape, argv arrays, URL shape,
  and lexical workspace paths. It cannot see symlinks or the real filesystem.
- `buildTool` executes the entry module's top level (that is how it reads the
  definition) but never calls `run`. Treat a tool entry like any code you build.
- This package contains no `node:child_process`, `node:fs` or `node:net` import
  in its library entry graph. Those belong to the runtime adapter.
- `z1-tool-sdk/runtime` executes the built bundle in QuickJS-WASM and enforces
  the capabilities; read [SECURITY.md](./SECURITY.md) for the boundary, the
  limits and the known sharp edges.

## CLI reference

```
z1-tool init <name> [dir]   create tool.ts, package.json, tsconfig.json, README, LICENSE, .gitignore
z1-tool build [dir]         bundle tool.ts -> dist/index.js, write dist/tool.json
z1-tool test [dir]          run vitest when installed, else validate manifest + run
z1-tool pack [dir]          write <name>-<version>.tgz, print path and sha256
z1-tool run <dir> [--args <json>] [--workspace <dir>]   run in the QuickJS sandbox
z1-tool --help
```

Every command prints one line on success and exits non-zero on failure.

## License

MIT © 2026 ayzitix
