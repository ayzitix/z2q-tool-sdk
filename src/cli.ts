#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, readdir, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildTool, mitLicenseText, packTool } from './build.js';
import { assertToolName } from './define.js';
import { ToolRuntimeError } from './runtime/errors.js';
import type { ToolManifest } from './types.js';

const HELP = `z1-tool - author, test and package z1 tools

Usage:
  z1-tool <command> [options]

Commands:
  init <name> [dir]  create a tool package (default dir: ./<name>)
  build [dir]        bundle tool.ts to dist/index.js and write dist/tool.json
  test [dir]         run vitest when installed, otherwise a manifest smoke check
  pack [dir]         pack tool.json, dist/index.js, package.json, LICENSE into a .tgz
  run <dir>          run a built tool in the QuickJS sandbox (--args, --workspace)

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
    const code = error instanceof ToolRuntimeError ? `${error.code}: ` : '';
    console.error(`z1-tool: ${code}${message}`);
    process.exitCode = 1;
  });
