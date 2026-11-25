#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, readdir, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { buildTool, mitLicenseText, packTool } from './build.js';
import { assertToolName } from './define.js';
import {
  ToolCreatorError,
  buildToolPrompt,
  createToolProject,
  describeCapabilities,
  installTool,
  listInstalledTools,
  loadInstalledTool,
  normalizeToolName,
  placeholderToolSource,
  reviewToolSource,
  scaffoldToolProject,
  smokeTestTool,
  verifyToolSource,
} from './creator/index.js';
import type { ToolRequest } from './creator/index.js';
import { ToolRuntimeError } from './runtime/errors.js';
import type { Json, ToolManifest } from './types.js';

const HELP = `z1-tool - author, test and package z1 tools

Usage:
  z1-tool <command> [options]

Commands:
  init <name> [dir]  create a tool package (default dir: ./<name>)
  build [dir]        bundle tool.ts to dist/index.js and write dist/tool.json
  test [dir]         run vitest when installed, otherwise a manifest smoke check
  pack [dir]         pack tool.json, dist/index.js, package.json, LICENSE into a .tgz
  run <dir>          run a built tool in the QuickJS sandbox (--args, --workspace)
  create <dir>       build a creator request and print the prompt (--purpose; --write)
  review <dir|file>  statically review generated tool source (--json)
  smoke <dir>        build a tool and run its samples in the sandbox (--args, --workspace)
  install <dir>      install behind approval.json (--tools, --approved-by, --expect-sha256, --allow-prebuilt)
  installed          list installed tools (--tools)

Options:
  -h, --help         show this help
  -v, --version      show the SDK version

Exit status is non-zero on failure.`;

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined) {
    console.log(HELP);
    return 0;
  }
  if (command === '-h' || command === '--help' || command === 'help') {
    console.log(HELP);
    return 0;
  }
  if (command === '-v' || command === '--version') {
    console.log(await readVersion());
    return 0;
  }
  switch (command) {
    case 'init':
      return initCommand(args);
    case 'build':
      return buildCommand(args);
    case 'test':
      return testCommand(args);
    case 'pack':
      return packCommand(args);
    case 'run':
      return runCommand(args);
    case 'create':
      return createCommand(args);
    case 'review':
      return reviewCommand(args);
    case 'smoke':
      return smokeCommand(args);
    case 'install':
      return installCommand(args);
    case 'installed':
      return installedCommand(args);
    default:
      throw new Error(`unknown command "${command}" (try: z1-tool --help)`);
  }
}

async function initCommand(args: string[]): Promise<number> {
  if (hasHelp(args)) {
    console.log('Usage: z1-tool init <name> [dir]\n\nCreates tool.ts, package.json, tsconfig.json, README.md, LICENSE and .gitignore.');
    return 0;
  }
  const name = args[0];
  if (name === undefined) {
    throw new Error('usage: z1-tool init <name> [dir]');
  }
  assertToolName(name);
  const target = resolve(args[1] ?? name);
  await ensureEmptyOrMissing(target);

  const files: Record<string, string> = {
    'tool.ts': toolTemplate(name),
    'package.json': packageTemplate(name),
    'tsconfig.json': TSCONFIG_TEMPLATE,
    'README.md': readmeTemplate(name),
    'LICENSE': mitLicenseText(`${name} authors`),
    '.gitignore': 'node_modules\ndist\n*.tgz\ncoverage\n',
  };

  await mkdir(target, { recursive: true });
  for (const [file, contents] of Object.entries(files)) {
    await writeFile(join(target, file), contents, 'utf8');
  }
  console.log(`created ${name} in ${target}`);
  return 0;
}

async function buildCommand(args: string[]): Promise<number> {
  if (hasHelp(args)) {
    console.log('Usage: z1-tool build [dir]\n\nBundles tool.ts to dist/index.js and writes dist/tool.json.');
    return 0;
  }
  const dir = resolve(args[0] ?? '.');
  const entry = join(dir, 'tool.ts');
  await ensureFile(entry, `tool.ts in ${dir}`);
  const result = await buildTool({ entry });
  console.log(
    `built ${result.manifest.name}@${result.manifest.version} -> ${result.bundlePath} + ${result.manifestPath}`,
  );
  return 0;
}

async function testCommand(args: string[]): Promise<number> {
  if (hasHelp(args)) {
    console.log('Usage: z1-tool test [dir]\n\nRuns vitest when it is installed, otherwise checks the built manifest and run export.');
    return 0;
  }
  const dir = resolve(args[0] ?? '.');
  const entry = join(dir, 'tool.ts');
  await ensureFile(entry, `tool.ts in ${dir}`);

  const vitestPath = await findVitest(dir);
  if (vitestPath !== undefined) {
    await runVitest(vitestPath, dir);
    console.log(`tests passed (vitest): ${dir}`);
    return 0;
  }

  const pkg = await readPackageJson(dir);
  if (pkg !== undefined && declaresDependency(pkg, 'vitest')) {
    throw new Error(
      `vitest is declared but not installed in ${dir}; run npm install, or remove vitest to use the smoke check`,
    );
  }

  const manifest = await smokeCheck(entry);
  console.log(`smoke check passed for ${manifest.name}@${manifest.version} (vitest not installed)`);
  return 0;
}

async function packCommand(args: string[]): Promise<number> {
  if (hasHelp(args)) {
    console.log('Usage: z1-tool pack [dir]\n\nPacks dist/tool.json, dist/index.js, package.json and LICENSE into <name>-<version>.tgz and prints its sha256.');
    return 0;
  }
  const dir = resolve(args[0] ?? '.');
  await ensureFile(
    join(dir, 'dist', 'tool.json'),
    `dist/tool.json in ${dir} (run: z1-tool build)`,
  );
  await ensureFile(join(dir, 'dist', 'index.js'), `dist/index.js in ${dir} (run: z1-tool build)`);
  await ensureFile(join(dir, 'package.json'), `package.json in ${dir}`);
  const result = await packTool({ dir });
  console.log(`packed ${result.path} sha256 ${result.sha256}`);
  return 0;
}

async function runCommand(args: string[]): Promise<number> {
  if (hasHelp(args)) {
    console.log(
      [
        'Usage: z1-tool run <dir> [--args <json>] [--workspace <dir>]',
        '',
        'Runs a built tool (dist/tool.json + dist/index.js) in the sandboxed QuickJS',
        'runtime and prints its JSON result. --workspace defaults to the current',
        'directory. Exits 1 with the runtime error code on failure.',
      ].join('\n'),
    );
    return 0;
  }
  const parsed = parseRunArgs(args);
  let toolArgs: unknown;
  try {
    toolArgs = JSON.parse(parsed.argsJson);
  } catch {
    throw new Error('--args must be valid JSON');
  }
  const { createToolRuntime } = await import('./runtime/index.js');
  const runtime = await createToolRuntime({
    workspace: parsed.workspace,
    onLog: (level, message) => {
      console.error(`[${level}] ${message}`);
    },
  });
  const result = await runtime.run(parsed.dir, toolArgs);
  console.log(JSON.stringify(result.value));
  return 0;
}

interface RunArgs {
  dir: string;
  argsJson: string;
  workspace: string;
}

function parseRunArgs(args: string[]): RunArgs {
  let argsJson = '{}';
  let workspace = process.cwd();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--args' || arg === '--workspace') {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      if (arg === '--args') argsJson = value;
      else workspace = resolve(value);
      continue;
    }
    if (arg.startsWith('--args=')) {
      argsJson = arg.slice('--args='.length);
      continue;
    }
    if (arg.startsWith('--workspace=')) {
      workspace = resolve(arg.slice('--workspace='.length));
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`unknown option "${arg}" (try: z1-tool run --help)`);
    }
    positional.push(arg);
  }
  return { dir: resolve(positional[0] ?? '.'), argsJson, workspace };
}

interface CreatorArgs {
  positionals: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

function parseCreatorArgs(
  args: string[],
  valueOptions: readonly string[],
  flagOptions: readonly string[],
): CreatorArgs {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf('=');
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    const option = name.replace(/^--/, '');
    if (valueOptions.includes(option)) {
      const value = equals >= 0 ? arg.slice(equals + 1) : args[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error(`${name} requires a value`);
      }
      if (equals < 0) index += 1;
      values.set(option, value);
      continue;
    }
    if (flagOptions.includes(option) && equals < 0) {
      flags.add(option);
      continue;
    }
    throw new Error(`unknown option "${arg}"`);
  }
  return { positionals, values, flags };
}

async function createCommand(args: string[]): Promise<number> {
  if (hasHelp(args)) {
    console.log(
      [
        'Usage: z1-tool create <dir> --purpose "<text>" [--name tool.x] [--examples <json>]',
        '                        [--print-prompt] [--write] [--source <file>]',
        '',
        'Builds the creator prompt and prints it. Nothing is written and no model is',
        "called unless --write is given. --source <file> writes, reviews and builds the",
        "host's generated file; without it --write creates a reviewed skeleton.",
      ].join('\n'),
    );
    return 0;
  }
  const parsed = parseCreatorArgs(
    args,
    ['purpose', 'name', 'examples', 'source'],
    ['print-prompt', 'write'],
  );
  const target = parsed.positionals[0];
  if (target === undefined) {
    throw new Error('usage: z1-tool create <dir> --purpose "<text>"');
  }
  const purpose = parsed.values.get('purpose');
  if (purpose === undefined) {
    throw new Error('create requires --purpose "<text>"');
  }
  const dir = resolve(target);
  const name = parsed.values.get('name') ?? normalizeToolName(basename(dir));
  const request: ToolRequest = { name, purpose };
  const examples = parsed.values.get('examples');
  if (examples !== undefined) request.examples = parseExamples(examples);
  const shouldWrite = parsed.flags.has('write');
  const sourceFile = parsed.values.get('source');
  if (sourceFile !== undefined && !shouldWrite) {
    throw new Error('--source requires --write');
  }
  const prompt = buildToolPrompt(request);
  if (parsed.flags.has('print-prompt') || !shouldWrite) {
    console.log(prompt.system);
    console.log();
    console.log(prompt.user);
  }
  if (!shouldWrite) return 0;

  if (sourceFile !== undefined) {
    const source = await readFile(resolve(sourceFile), 'utf8');
    const result = await createToolProject({ dir, request, source, cwd: process.cwd() });
    console.log(`created ${result.dir}`);
    return 0;
  }
  const source = placeholderToolSource(request);
  const scaffold = await scaffoldToolProject({ dir, request, source, cwd: process.cwd() });
  console.log(`created ${scaffold.dir} (skeleton; replace tool.ts with generated source)`);
  return 0;
}

function parseExamples(text: string): { input: Json; note?: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('--examples must be valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('--examples must be a JSON array of { "input": ..., "note"?: ... }');
  }
  return parsed.map((entry, index) => {
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry) && 'input' in entry) {
      const note = (entry as { note?: unknown }).note;
      if (note !== undefined && typeof note !== 'string') {
        throw new Error(`--examples[${index}].note must be a string`);
      }
      const input = (entry as { input: Json }).input;
      return note === undefined ? { input } : { input, note };
    }
    return { input: entry as Json };
  });
}

async function reviewCommand(args: string[]): Promise<number> {
  if (hasHelp(args)) {
    console.log(
      [
        'Usage: z1-tool review <dir|file> [--json]',
        '',
        'Runs the static review, then builds the source in a temp directory (never',
        'the project) only when every static rule passed. Exits 1 with one line per',
        'issue; --json prints the report on stdout.',
      ].join('\n'),
    );
    return 0;
  }
  const parsed = parseCreatorArgs(args, [], ['json']);
  const target = parsed.positionals[0];
  if (target === undefined) {
    throw new Error('usage: z1-tool review <dir|file>');
  }
  const resolved = resolve(target);
  const info = await stat(resolved).catch(() => undefined);
  if (info === undefined) {
    throw new Error(`no such file or directory: ${resolved}`);
  }
  const file = info.isDirectory() ? join(resolved, 'tool.ts') : resolved;
  const source = await readFile(file, 'utf8').catch(() => {
    throw new Error(`cannot read ${file}`);
  });
  const report = await verifyToolSource(source);
  const asJson = parsed.flags.has('json');
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    console.log(`review ok: ${report.name ?? '(unnamed)'}@${report.version ?? '0.0.0'}`);
  }
  if (!report.ok) {
    if (!asJson) {
      for (const issue of report.issues) {
        console.error(
          `${issue.code}${issue.line === undefined ? '' : ` (line ${issue.line})`}: ${issue.message}`,
        );
      }
    }
    return 1;
  }
  return 0;
}

async function smokeCommand(args: string[]): Promise<number> {
  if (hasHelp(args)) {
    console.log(
      [
        'Usage: z1-tool smoke <dir> [--args <json>] [--workspace <dir>]',
        '',
        'Builds the tool and runs every sample through the QuickJS sandbox with the',
        "manifest's own grants. --args is one input, or a JSON array of inputs;",
        '--workspace defaults to the current directory. Exits 1 if any sample fails.',
      ].join('\n'),
    );
    return 0;
  }
  const parsed = parseCreatorArgs(args, ['args', 'workspace'], []);
  const target = parsed.positionals[0];
  if (target === undefined) {
    throw new Error('usage: z1-tool smoke <dir> [--args <json>] [--workspace <dir>]');
  }
  const workspace = parsed.values.get('workspace');
  const inputs = parsed.values.get('args');
  let samples: Json[] | undefined;
  if (inputs !== undefined) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(inputs);
    } catch {
      throw new Error('--args must be valid JSON');
    }
    samples = Array.isArray(decoded) ? (decoded as Json[]) : [decoded as Json];
  }
  const result = await smokeTestTool(resolve(target), {
    workspace: workspace === undefined ? process.cwd() : resolve(workspace),
    ...(samples === undefined ? {} : { args: samples }),
  });
  result.runs.forEach((run, index) => {
    const denial =
      run.denied > 0
        ? ` (denied ${run.denied}${run.codes.length > 0 ? `: ${run.codes.join(', ')}` : ''})`
        : '';
    if (run.ok) {
      console.log(`run ${index + 1}: ok ${JSON.stringify(run.value ?? null)}${denial}`);
    } else {
      const code = run.code ?? (run.denied > 0 ? 'denied' : 'tool_threw');
      console.log(`run ${index + 1}: ${code} ${run.message ?? ''}${denial}`.trimEnd());
    }
  });
  const passed = result.runs.filter((run) => run.ok).length;
  console.log(`smoke: ${passed}/${result.runs.length} ok`);
  return result.ok ? 0 : 1;
}

async function installCommand(args: string[]): Promise<number> {
  if (hasHelp(args)) {
    console.log(
      [
        'Usage: z1-tool install <dir> [--tools <dir>] [--approved-by <name>]',
        '                        [--expect-sha256 <hex>] [--allow-prebuilt]',
        '',
        'Reviews and always rebuilds tool.ts when present, then installs the build',
        'under <tools>/<name>/<version>/ with approval.json. A dist-only directory',
        'needs --expect-sha256 or --allow-prebuilt. A version is immutable.',
        '--tools defaults to ./.z1/tools.',
      ].join('\n'),
    );
    return 0;
  }
  const parsed = parseCreatorArgs(
    args,
    ['tools', 'approved-by', 'expect-sha256'],
    ['allow-prebuilt'],
  );
  const target = parsed.positionals[0];
  if (target === undefined) {
    throw new Error(
      'usage: z1-tool install <dir> [--tools <dir>] [--approved-by <name>] [--expect-sha256 <hex>] [--allow-prebuilt]',
    );
  }
  const dir = resolve(target);
  const toolsDir = resolve(parsed.values.get('tools') ?? join(process.cwd(), '.z1', 'tools'));
  const approvedBy = parsed.values.get('approved-by');
  const entry = join(dir, 'tool.ts');
  const entryInfo = await stat(entry).catch(() => undefined);
  if (entryInfo?.isFile() === true) {
    const source = await readFile(entry, 'utf8');
    const report = reviewToolSource(source);
    if (!report.ok) {
      for (const issue of report.issues) {
        console.error(
          `${issue.code}${issue.line === undefined ? '' : ` (line ${issue.line})`}: ${issue.message}`,
        );
      }
      return 1;
    }
  }

  const expectSha256 = parsed.values.get('expect-sha256');
  const installed = await installTool({
    toolsDir,
    dir,
    ...(approvedBy === undefined ? {} : { approvedBy }),
    ...(expectSha256 === undefined ? {} : { expectSha256 }),
    ...(parsed.flags.has('allow-prebuilt') ? { allowPrebuilt: true } : {}),
  });
  const pkg = await loadInstalledTool(toolsDir, installed.name, installed.version);
  const summary = describeCapabilities(pkg.manifest);
  console.log(`installed ${installed.name}@${installed.version}`);
  for (const line of summary.lines) console.log(`- ${line}`);
  console.log(`risk: ${summary.risk}`);
  console.log(`path: ${installed.path}`);
  console.log(`sha256: ${installed.sha256}`);
  return 0;
}

async function installedCommand(args: string[]): Promise<number> {
  if (hasHelp(args)) {
    console.log(
      [
        'Usage: z1-tool installed [--tools <dir>]',
        '',
        'Lists installed versions. --tools defaults to ./.z1/tools.',
      ].join('\n'),
    );
    return 0;
  }
  const parsed = parseCreatorArgs(args, ['tools'], []);
  if (parsed.positionals.length > 0) {
    throw new Error(`unexpected argument "${parsed.positionals[0]}"`);
  }
  const toolsDir = resolve(parsed.values.get('tools') ?? join(process.cwd(), '.z1', 'tools'));
  const installed = await listInstalledTools(toolsDir);
  if (installed.length === 0) {
    console.log(`no tools installed in ${toolsDir}`);
    return 0;
  }
  for (const tool of installed) {
    const approved = tool.approvedBy === undefined ? '' : ` approved-by=${tool.approvedBy}`;
    console.log(
      `${tool.name}@${tool.version} sha256=${tool.sha256.slice(0, 12)} installed=${tool.installedAt}${approved} path=${tool.path}`,
    );
  }
  return 0;
}

async function smokeCheck(entry: string): Promise<ToolManifest> {
  const outDir = await mkdtemp(join(tmpdir(), 'z1-tool-smoke-'));
  try {
    const result = await buildTool({ entry, outDir });
    return result.manifest;
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

function runVitest(vitestPath: string, cwd: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [vitestPath, 'run'], { cwd, stdio: 'inherit' });
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`vitest exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function readVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function ensureEmptyOrMissing(dir: string): Promise<void> {
  const info = await stat(dir).catch(() => undefined);
  if (info === undefined) return;
  if (!info.isDirectory()) {
    throw new Error(`not a directory: ${dir}`);
  }
  const entries = await readdir(dir);
  if (entries.length > 0) {
    throw new Error(`directory is not empty: ${dir}`);
  }
}

async function ensureFile(path: string, label: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    throw new Error(`missing ${label}`);
  }
}

async function isFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined);
  return info?.isFile() ?? false;
}

/** Find a directly installed or hoisted vitest CLI. */
async function findVitest(dir: string): Promise<string | undefined> {
  const direct = join(dir, 'node_modules', 'vitest', 'vitest.mjs');
  if (await isFile(direct)) return direct;
  try {
    const resolveFrom = createRequire(join(dir, 'package.json'));
    const packagePath = resolveFrom.resolve('vitest/package.json');
    const hoisted = join(dirname(packagePath), 'vitest.mjs');
    if (await isFile(hoisted)) return hoisted;
  } catch {
    // No vitest installed up the tree.
  }
  return undefined;
}

interface PackageJsonLike {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readPackageJson(dir: string): Promise<PackageJsonLike | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as PackageJsonLike;
  } catch {
    return undefined;
  }
}

function declaresDependency(pkg: PackageJsonLike, name: string): boolean {
  return pkg.dependencies?.[name] !== undefined || pkg.devDependencies?.[name] !== undefined;
}

function hasHelp(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

function toolTemplate(name: string): string {
  return `import { defineTool } from 'z1-tool-sdk';
import { z } from 'zod';

export const tool = defineTool({
  name: '${name}',
  version: '0.1.0',
  description: 'Describe what ${name} does in one sentence.',
  parameters: z.object({
    input: z.string().min(1).describe('Text to return unchanged.'),
  }),
  capabilities: {},
  run: async (_ctx, args) => ({ input: args.input }),
});
`;
}

function packageTemplate(name: string): string {
  return `${JSON.stringify(
    {
      name,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: {
        build: 'z1-tool build',
        test: 'z1-tool test',
        pack: 'z1-tool pack',
      },
      dependencies: {
        'z1-tool-sdk': '^0.1.0',
        zod: '^4.6.7',
      },
      devDependencies: {
        esbuild: '^0.28.2',
        typescript: '^5.9.3',
      },
    },
    null,
    2,
  )}\n`;
}

function readmeTemplate(name: string): string {
  return `# ${name}

A z1 tool built with \`z1-tool-sdk\`.

## Build

\`\`\`sh
npm install
npx z1-tool build
\`\`\`

This writes \`dist/index.js\` and \`dist/tool.json\`.

## Run

The runtime injects a \`ToolContext\`. The tool declares what it needs in
\`tool.ts\`; the runtime broker decides what to grant. The SDK never grants
anything by itself.
`;
}

const TSCONFIG_TEMPLATE = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["tool.ts"]
}
`;

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof ToolRuntimeError || error instanceof ToolCreatorError
        ? `${error.code}: `
        : '';
    console.error(`z1-tool: ${code}${message}`);
    process.exitCode = 1;
  });
