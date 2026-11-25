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
| `limits.timeoutMs` | `30000` | Wall-clock budget per call. |
| `limits.maxOutputBytes` | `1048576` | Captured stdout/stderr budget per call. |

Arrays are trimmed, de-duplicated and sorted so manifests are deterministic.
Unknown capability keys and non-positive limits are rejected.

`process.run` takes `{ argv, cwd?, env?, stdin? }` and rejects an empty argv at
the SDK boundary. `fs` paths may be workspace-relative or absolute inside the
workspace; the test harness rejects lexical escapes, and the runtime still owns
the real check (symlinks, mounts, TOCTOU).

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

## CLI reference

```
z1-tool init <name> [dir]   create tool.ts, package.json, tsconfig.json, README, LICENSE, .gitignore
z1-tool build [dir]         bundle tool.ts -> dist/index.js, write dist/tool.json
z1-tool test [dir]          run vitest when installed, else validate manifest + run
z1-tool pack [dir]          write <name>-<version>.tgz, print path and sha256
z1-tool --help
```

Every command prints one line on success and exits non-zero on failure.

## License

MIT © 2026 ayzitix
