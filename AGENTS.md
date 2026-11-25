# Developer notes

Small, dependency-light SDK for authoring z1 tools. The runtime injects the
context; this repository only describes tools and builds them.

## Commands

```sh
npm install
npm run build       # tsc -> dist, then esbuild bundles src/cli.ts -> dist/cli.js
npm test            # vitest, real temp dirs, no network
npm run typecheck   # tsc --noEmit over src, tests and examples
```

`tsconfig.json` is the typecheck config (no emit). `tsconfig.build.json` emits
`dist/` from `src/` only. `dist/cli.js` is an esbuild bundle with `esbuild`
external; the rest of `dist/` is plain `tsc` output.

## Layout

- `src/types.ts` — public types: `Json`, `ToolManifest`, `ToolContext`, capabilities.
- `src/schema.ts` — zod 4 object -> draft-2020-12 JSON Schema, plain-JSON guard.
- `src/define.ts` — `defineTool`, `runTool`, validation errors.
- `src/context.ts` — argv/URL/path/glob helpers shared by adapters and tests.
- `src/testing.ts` — `createTestContext` in-memory harness and recorder.
- `src/build.ts` — `buildTool`, `packTool`, tar writer, lazy esbuild loader.
- `src/cli.ts` — `z1-tool` CLI (Node-only; may import node builtins).
- `examples/` — realistic tool entries built by the test suite.

## Rules

1. **Capabilities are declarative.** Never grant, spawn, open or fetch in the
   SDK. The host broker enforces; the SDK only validates shape and normalizes.
   Do not add enforcement-looking code paths to `defineTool`.
2. Keep `node:child_process`, `node:fs` and `node:net` out of the library entry
   graph. `build.ts` may load them with `await import(...)` inside a function;
   `cli.ts` may import them statically because it is not part of the entry.
3. The manifest must stay deterministic, plain JSON and function-free. Use
   `toPlainJson` when accepting externally produced data, and update tests if
   the shape changes.
4. `buildTool` must never call `run`. It imports the bundle to read the
   definition; `tests/build.spec.ts` guards this.
5. `process.run` is argv-only. Never accept or build a shell string.
6. zod stays on 4.x and schema conversion goes through `z.toJSONSchema` with
   `target: 'draft-2020-12'` and `io: 'input'`. Do not add a JSON Schema
   converter dependency or switch to output mode: input mode keeps defaulted
   fields optional in the manifest, matching what `runTool` accepts. Check
   `tests/schema.spec.ts` after any zod bump.
7. Tests use `node:fs/promises` + `os.tmpdir()` and clean up. No network, no
   real adb, no real fetches.
8. Do not commit or push unless explicitly asked.

## Adding a capability

Add the input type in `types.ts`, the resolved manifest type, validation and
sorting in `define.ts` (`resolveCapabilities`), the matching `ToolContext`
surface, the test harness behavior in `testing.ts`, and a README table row.
Capabilities are requests; the runtime adapter is where they are enforced.
