# Developer notes

`z2q by z1` — the tool SDK for z1 agents. `z2q` is the product name; `z1` is the
internal codename and stays in identifiers, paths, package names and imports.
Small, dependency-light SDK for authoring z1 tools. The runtime injects the
context; this repository only describes tools, builds them and runs them in a
QuickJS sandbox.

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
- `src/manifest.ts` — shared `isToolManifest` shape check used by build, pack and the runtime.
- `src/build.ts` — `buildTool`, `packTool`, tar writer, lazy esbuild loader.
- `src/cli.ts` — `z1-tool` CLI (Node-only; may import node builtins).
- `src/creator/index.ts` — the Tool Creator public surface, re-exported from the package root.
- `src/creator/prompt.ts` — `ToolRequest`, `ToolPrompt`, name normalisation, `buildToolPrompt`, `ToolCreatorError`.
- `src/creator/review.ts` — the lexer, rules 1-10, `reviewToolSource`, `verifyToolSource`, `assessToolManifest`, `buildToolProject`.
- `src/creator/project.ts` — `scaffoldToolProject` (six files, no build), `createToolProject` (review, write, build, confirm).
- `src/creator/smoke.ts` — `smokeTestTool`, one sandbox run per sample.
- `src/creator/install.ts` — immutable installs, `approval.json`, list and load with the sha check.
- `src/creator/flow.ts` — `createToolCreator`, injected `generate`, repair retries, proposal and explicit install.
- `src/creator/capabilities.ts` — `describeCapabilities` for an approval prompt.
- `src/runtime/index.ts` — `z1-tool-sdk/runtime`: `createToolRuntime`, `ToolRuntime.run`, options, sinks.
- `src/runtime/definition.ts` — the sandboxed manifest read used by `buildTool`; one module, no bridge, one 1 MiB cap.
- `src/runtime/sandbox.ts` — the QuickJS half: one runtime per call, one `Scope`, every handle.
- `src/runtime/policy.ts` — the pure capability policy (paths, globs, argv, env, realpath).
- `src/runtime/broker.ts` — the only code that reads files or spawns processes.
- `src/runtime/audit.ts` — `AuditRow`, sinks, the per-call collector and the row cap.
- `src/runtime/limits.ts` — the limits table as constants.
- `src/runtime/errors.ts` — `ToolRuntimeError` and the 17 codes.
- `src/runtime/package.ts` — `loadToolPackage`: `dist/tool.json` + `dist/index.js`.
- `src/runtime/shim.ts` — the VM-side source strings; no host imports may appear inside.
- `src/runtime/host.ts` — lazy `node:` modules behind structural types.
- `examples/` — realistic tool entries built by the test suite.
- `tests/creator-*.spec.ts` — creator rules, project, install and CLI; the CLI spec bundles `dist/cli.js` and spawns it in temp dirs.

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
4. `buildTool` must never call `run`. It reads the bundle's definition in
   QuickJS, with no bridge; `tests/build.spec.ts` and
   `tests/creator-host-isolation.spec.ts` guard this.
5. `process.run` is argv-only. Never accept or build a shell string.
6. zod stays on 4.x and schema conversion goes through `z.toJSONSchema` with
   `target: 'draft-2020-12'` and `io: 'input'`. Do not add a JSON Schema
   converter dependency or switch to output mode: input mode keeps defaulted
   fields optional in the manifest, matching what `runTool` accepts. Check
   `tests/schema.spec.ts` after any zod bump.
7. Tests use `node:fs/promises` + `os.tmpdir()` and clean up. No network, no
   real adb, no real fetches.
8. Do not commit or push unless explicitly asked.
9. **Every QuickJS handle goes through the `Scope`.** A handle that is still
   alive at `runtime.dispose()` makes the dispose throw a catchable abort
   (`Aborted(Assertion failed: list_empty(&rt->gc_obj_list), ... JS_FreeRuntime)`)
   that the WASM module also prints to stderr. An *unguarded* `dispose()` in a
   host therefore takes the whole process down; `disposeCall`'s `try/catch` is
   what keeps it alive, the shared WASM module stays usable afterwards, and later
   calls are correct. That includes the `evalCode` value **and** error, every
   `getProp`, `newFunction` and `newString`, the promise state's
   `value`/`error`, and `computeMemoryUsage()`. A handle returned *from* a host
   function is the exception: ownership transfers to the VM, never dispose it.
   Large values are the other measured trigger (`SECURITY.md`): chunk every
   payload at `SANDBOX_MAX_BRIDGE_BYTES`, ask for 128 KiB per read, and build a
   read result with `+=`, never `Array.join`. `sandbox.ts` is the only file that
   touches QuickJS and it is written to be read line by line.
10. **One host function.** The VM may see `__z1_invoke(kind, payloadJson)` and
   these globals, measured by `tests/runtime-sandbox.spec.ts`: `__z1_args`,
   `__z1_ctx`, `__z1_encode`, `__z1_invoke`, `__z1_run`, `__z1_workspace`,
   `__z1_value`, `console`. Do not add a second bridge, a Node object, or a module
   loader entry: the loader answers for the bundle only and refuses every other
   request, including every builtin.
11. **The deny lists are a list, not a boundary.** They stop the obvious
   (`~/.ssh`, `.git`, `.env`), and realpath containment stops links out of the
   workspace, but a file inside the workspace that matches a grant is readable.
   Keep the path-level hardening that the reviews bought: refuse `:` segments
   (NTFS streams), trailing dots/spaces and reserved device names, and re-check
   the deny lists on the real target so a junction onto `.git` is refused. Do not
   describe the sandbox as a general secret filter; `SECURITY.md` says what it
   does and does not cover.
12. `src/runtime/*` keeps `node:` imports dynamic (`await import(...)` inside a
   function, or through `src/runtime/host.ts`) and the VM source in `shim.ts` as
   a literal string. `npm run build` must keep `quickjs-emscripten` external in
   `dist/cli.js`; it loads a `.wasm` file esbuild cannot bundle.

13. **`reviewToolSource` is deny-by-default and its rule set is closed.** One
    issue per rule, and any issue means refuse. It never executes, never touches
    the filesystem and never imports the source. Strings, comments and template
    text are not identifiers; template interpolations are code; identifier
    escapes are decoded; property names, class field names, object-pattern
    shorthand bindings and member accesses are names (so `ctx.process.run` and
    `process: { argv }` reach rules 7 and 8). Regex literals are skipped only
    where the scanner can tell them from division; an ambiguous slash (after
    `}`, `+`/`-`, a control-condition `)`, or the contextual `of`) is
    `scan_failed`, never a guess. The review is an **advisory lint**, not a
    boundary. Do not add a rule, a code or an escape hatch without updating the
    tests, the README and `SECURITY.md`.
14. **A build never executes tool code on the host.** `src/runtime/definition.ts`
    imports the bundle in a fresh QuickJS runtime with no bridge and returns only
    the manifest; `buildTool` uses it, so `z1-tool build` and the definition
    read behind `z1-tool test` inherit the boundary. Do not reintroduce
    `await import(bundlePath)` in `build.ts` or any creator path. Keep the
    manifest cap at 1 MiB: a larger string can make `runtime.dispose()` throw the
    documented QuickJS abort. A static import that survives bundling must fail
    with the "bundle everything" message. A thrown value must be capped *inside*
    the VM before it crosses: an attacker-sized error otherwise allocates on the
    host and makes the teardown print its abort line. The lint still proves
    shape, not intent; the sandbox is the boundary. The boundary covers the tool
    entry, not the project's `node_modules`: `buildTool` loads the project's own
    esbuild.
15. **Installed versions are immutable.** When `tool.ts` exists, `installTool`
    always rebuilds before installing; never sign a stale `dist/`. A dist-only
    directory needs `expectSha256` or `allowPrebuilt: true`.
    `<toolsDir>/<name>/<version>` is reserved with a non-recursive `mkdir`; never
    overwrite, rename or patch an existing version. `approval.json` records the
    sha256 and the resolved capabilities, and `loadInstalledTool` rechecks both.
    The hash covers `dist/index.js`; the capabilities comparison covers
    `dist/tool.json`.
16. **The creator has no provider, no network and no model.** The model call is
    the host's. Do not add an SDK client, a key, a `fetch`, or provider-specific
    text to `src/creator/*`; the prompts are plain deterministic text.
17. **`flow.ts` stays model-agnostic and never installs implicitly.**
    `createToolCreator` calls only the injected `generate`; it must not import a
    provider, open a network connection or read a key. `propose()` writes only
    under `proposalDir`; `install()` is the only path that writes into `toolsDir`
    and must pass `expectSha256`. Keep the repair prompt deterministic and
    include the exact review issues.

## Adding a capability

Add the input type in `types.ts`, the resolved manifest type, validation and
sorting in `define.ts` (`resolveCapabilities`), the matching `ToolContext`
surface, the test harness behavior in `testing.ts`, and a README table row.
Capabilities are requests; the runtime adapter is where they are enforced.
