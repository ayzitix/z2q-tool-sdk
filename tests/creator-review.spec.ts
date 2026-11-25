import { describe, expect, it } from 'vitest';
import { reviewToolSource, verifyToolSource } from '../src/creator/review.js';
import type { ToolSourceReport } from '../src/creator/review.js';

interface SourceOptions {
  imports?: string[];
  capabilities?: string | null;
  description?: string;
  body?: string;
  name?: string;
  definition?: string;
}

/** A literal, reviewable tool source; each test overrides the part it measures. */
function toolSource(options: SourceOptions = {}): string {
  const description = options.description ?? 'Reads a file and returns its length.';
  return [
    "import { defineTool } from 'z1-tool-sdk';",
    "import { z } from 'zod';",
    ...(options.imports ?? []),
    '',
    options.definition ?? 'export const tool = defineTool({',
    `  name: '${options.name ?? 'tool.sample'}',`,
    "  version: '0.1.0',",
    `  description: ${JSON.stringify(description)},`,
    '  parameters: z.object({ path: z.string() }),',
    ...(options.capabilities === null
      ? []
      : [`  capabilities: ${options.capabilities ?? "{ fs: { read: ['**/*'] } }"},`]),
    '  run: async (ctx, args) => {',
    options.body ?? "    const text = await ctx.fs.read(args.path);\n    return { length: text.length };",
    '  },',
    '});',
    '',
  ].join('\n');
}

function firstCode(report: ToolSourceReport): string | undefined {
  return report.issues[0]?.code;
}

function lineOf(source: string, needle: string): number {
  return source.split('\n').findIndex((line) => line.includes(needle)) + 1;
}

describe('reviewToolSource: the accepted shape', () => {
  it('accepts a literal tool and fills name, version, description and capabilities', () => {
    const report = reviewToolSource(toolSource());

    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.name).toBe('tool.sample');
    expect(report.version).toBe('0.1.0');
    expect(report.description).toBe('Reads a file and returns its length.');
    expect(report.capabilities).toEqual({
      fs: { read: ['**/*'], write: [] },
      process: { argv: [] },
      net: { hosts: [] },
      env: { read: [] },
      limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576 },
    });
  });

  it('accepts both allowed type annotations on the export', () => {
    const simple = toolSource({ definition: 'export const tool: AnyToolDefinition = defineTool({' });
    const generic = toolSource({
      definition: 'export const tool: ToolDefinition<() => void> = defineTool({',
    });

    expect(reviewToolSource(simple).ok).toBe(true);
    expect(reviewToolSource(generic).ok).toBe(true);
  });

  it('does not execute the source: a top-level throw is still a static pass', () => {
    const report = reviewToolSource(`${toolSource()}\nthrow new Error('executed on the host');\n`);

    expect(report.ok).toBe(true);
  });
});

describe('rule 1: source_too_large', () => {
  it('refuses a non-string, an empty source and anything over 32 KiB', () => {
    expect(firstCode(reviewToolSource(42 as unknown as string))).toBe('source_too_large');
    expect(firstCode(reviewToolSource(''))).toBe('source_too_large');
    expect(firstCode(reviewToolSource('x'.repeat(33 * 1024)))).toBe('source_too_large');
  });

  it('allows exactly 32 KiB through to the next rule', () => {
    const report = reviewToolSource('x'.repeat(32 * 1024));

    expect(firstCode(report)).toBe('missing_definition');
  });
});

describe('rule 2: missing_definition', () => {
  it('refuses a source without `export const tool = defineTool(`', () => {
    const report = reviewToolSource('const tool = 1;\nexport const other = 2;\n');

    expect(report.ok).toBe(false);
    expect(firstCode(report)).toBe('missing_definition');
  });

  it('refuses CommonJS', () => {
    const report = reviewToolSource("const tool = require('z1-tool-sdk');\nmodule.exports = tool;\n");

    expect(firstCode(report)).toBe('missing_definition');
  });

  it('refuses a default export instead of the named tool export', () => {
    const report = reviewToolSource(toolSource().replace('export const tool =', 'export default'));

    expect(firstCode(report)).toBe('missing_definition');
  });
});

describe('rule 3: forbidden_import', () => {
  it('refuses a relative, node: and side-effect import', () => {
    expect(firstCode(reviewToolSource(toolSource({ imports: ["import './x.js';"] })))).toBe(
      'forbidden_import',
    );
    const node = toolSource({ imports: ["import { readFile } from 'node:fs';"] });
    const nodeReport = reviewToolSource(node);
    expect(firstCode(nodeReport)).toBe('forbidden_import');
    expect(nodeReport.issues[0]?.line).toBe(3);
    expect(firstCode(reviewToolSource(toolSource({ imports: ["import 'node:fs';"] })))).toBe(
      'forbidden_import',
    );
  });

  it('refuses a re-export from a forbidden module', () => {
    const report = reviewToolSource(
      toolSource({ imports: ["export { readFile } from 'node:fs';"] }),
    );

    expect(firstCode(report)).toBe('forbidden_import');
  });

  it('refuses import() with a non-literal argument and import.meta', () => {
    const dynamic = toolSource({
      body: '    const x = 1;\n    const m = await import(x);\n    return { m };',
    });
    expect(firstCode(reviewToolSource(dynamic))).toBe('forbidden_import');

    const meta = toolSource({ body: '    return { url: import.meta.url };' });
    expect(firstCode(reviewToolSource(meta))).toBe('forbidden_import');
  });

  it('accepts a literal import("zod") and both allowed static imports', () => {
    const dynamic = toolSource({
      body: "    const m = await import('zod');\n    return { ok: typeof m };",
    });

    expect(reviewToolSource(dynamic).ok).toBe(true);
  });
});

describe('rule 4: forbidden_identifier', () => {
  it('refuses a host identifier with its line', () => {
    const source = toolSource({ body: '    const p = process.env;\n    return { p };' });
    const report = reviewToolSource(source);

    expect(firstCode(report)).toBe('forbidden_identifier');
    expect(report.issues[0]?.line).toBe(lineOf(source, 'process.env'));
    expect(report.issues[0]?.message).toContain('process');
  });

  it('refuses eval, Function, globalThis and WebAssembly', () => {
    for (const used of ['eval', 'Function', 'globalThis', 'WebAssembly']) {
      const report = reviewToolSource(toolSource({ body: `    return { value: ${used} };` }));
      expect(firstCode(report), used).toBe('forbidden_identifier');
    }
  });

  it('decodes an identifier escape, so \\u0070rocess cannot evade the rule', () => {
    const source = toolSource({
      body: '    const \\u0070rocess = 1;\n    return { process: 1 };',
    });

    expect(firstCode(reviewToolSource(source))).toBe('forbidden_identifier');
  });

  it('does not trip on a string or a comment containing process/eval', () => {
    const text = toolSource({
      body: "    const label = 'process'; // eval is not an identifier here\n    return { label };",
    });

    expect(reviewToolSource(text).ok).toBe(true);
  });

  it('tokenizes template interpolation but not template text', () => {
    const text = toolSource({ body: '    const x = `just text about process`;\n    return { x };' });
    expect(reviewToolSource(text).ok).toBe(true);

    const code = toolSource({
      body: '    const x = `${process.env.HOME}`;\n    return { x };',
    });
    expect(firstCode(reviewToolSource(code))).toBe('forbidden_identifier');
  });

  it('skips regex literals but never division', () => {
    const regex = toolSource({
      body: "    const re = /process/;\n    return { ok: re.test('x') };",
    });
    expect(reviewToolSource(regex).ok).toBe(true);

    const division = toolSource({ body: '    const half = 12 / 2;\n    return { half };' });
    expect(reviewToolSource(division).ok).toBe(true);

    // Two regex literals with apostrophes used to pair the quotes and hide the
    // process reference between them. The lexer now skips each regex body.
    const attack = toolSource({
      body: "    const r1 = /'/;\n    const a = 'x';\n    const p = process.env;\n    const r2 = /'/;\n    const b = 'y';\n    return { a, b, p };",
    });
    const report = reviewToolSource(attack);
    expect(firstCode(report)).toBe('forbidden_identifier');
    expect(report.issues[0]?.line).toBe(lineOf(attack, 'process.env'));
  });

  it('refuses an ambiguous slash instead of guessing', () => {
    const report = reviewToolSource(
      toolSource({ body: '    const x = { a: 1 } / 2;\n    return { x };' }),
    );

    expect(firstCode(report)).toBe('scan_failed');
    expect(report.issues[0]?.message).toContain('cannot tell a regular expression from division');
  });

  it('uses scan_failed, never missing_definition, for the ambiguous slash families', () => {
    for (const body of [
      '    const x = 1 + /d/.test(String(1));\n    return { x };',
      '    const x = 1 - /d/.test(String(1));\n    return { x };',
      "    for (const m of /a(b)/g[Symbol.matchAll]('ab')) {}\n    return { ok: true };",
      '    if (args.path) /a/.test(args.path);\n    return { ok: true };',
    ]) {
      const report = reviewToolSource(toolSource({ body }));
      expect(firstCode(report), body).toBe('scan_failed');
    }
  });

  it('allows regex literals in a zod schema', () => {
    const source = toolSource().replace(
      'parameters: z.object({ path: z.string() })',
      'parameters: z.object({ path: z.string().regex(/^[a-z]+$/) })',
    );

    expect(reviewToolSource(source).ok).toBe(true);
  });

  it('allows property names and ctx.process, but not shorthand or spread references', () => {
    const surface = toolSource({
      capabilities: "{ process: { argv: ['git'] } }",
      body: "    const r = await ctx.process.run({ argv: ['git', 'status'] });\n    return { code: r.code };",
    });
    expect(reviewToolSource(surface).ok).toBe(true);

    const shorthand = toolSource({ body: '    const { process } = args;\n    return { process };' });
    expect(firstCode(reviewToolSource(shorthand))).toBe('forbidden_identifier');

    const spread = toolSource({ body: '    const x = { ...process };\n    return { x };' });
    expect(firstCode(reviewToolSource(spread))).toBe('forbidden_identifier');
  });

  it('treats a class field name and a pattern binding as names, not references', () => {
    const classField = toolSource({
      body: '    class C { os = 1; }\n    return { ok: true };',
    });
    expect(reviewToolSource(classField).ok).toBe(true);

    const pattern = toolSource({
      body: '    const { net } = { net: 1 };\n    return { ok: true };',
    });
    expect(reviewToolSource(pattern).ok).toBe(true);

    const reference = toolSource({
      body: '    class C { os = process; }\n    return { ok: true };',
    });
    expect(firstCode(reviewToolSource(reference))).toBe('forbidden_identifier');
  });

  it('does not mistake a method named import for a dynamic import', () => {
    const source = toolSource({
      body: "    const box = { import: 1 };\n    box.import('node:fs');\n    return { ok: true };",
    });

    expect(reviewToolSource(source).ok).toBe(true);
  });
});

describe('rule 5: missing_capabilities', () => {
  it('refuses a definition without capabilities', () => {
    const report = reviewToolSource(toolSource({ capabilities: null }));

    expect(firstCode(report)).toBe('missing_capabilities');
  });

  it('refuses capabilities that are not a literal object', () => {
    for (const capabilities of ['buildCapabilities()', '{ ...baseCapabilities }']) {
      const report = reviewToolSource(toolSource({ capabilities }));
      expect(firstCode(report), capabilities).toBe('missing_capabilities');
    }
  });

  it('does not read a ternary as a capabilities key', () => {
    const withNet = toolSource({ capabilities: "{ net: { hosts: ['api.example.com'] } }" }).replace(
      '  run:',
      "  note: args.path ? 'capabilities' : {},\n  run:",
    );
    const report = reviewToolSource(withNet);
    expect(report.ok).toBe(true);
    expect(report.capabilities?.net).toEqual({ hosts: ['api.example.com'] });

    const without = toolSource({ capabilities: null }).replace(
      '  run:',
      "  note: args.path ? 'capabilities' : {},\n  run:",
    );
    expect(firstCode(reviewToolSource(without))).toBe('missing_capabilities');
  });
});

describe('rule 6: capability_undeclared', () => {
  it('reads net.hosts and env.read into the report', () => {
    const report = reviewToolSource(
      toolSource({
        capabilities:
          "{ net: { hosts: ['api.example.com', '*.example.org'] }, env: { read: ['EXA_API_KEY'] } }",
        body: "    const r = await ctx.net.fetch(ctx.env.EXA_API_KEY);\n    return { ok: r.ok };",
      }),
    );

    expect(report.ok).toBe(true);
    expect(report.capabilities?.net).toEqual({ hosts: ['*.example.org', 'api.example.com'] });
    expect(report.capabilities?.env).toEqual({ read: ['EXA_API_KEY'] });
  });

  it('refuses ctx.net.fetch without net.hosts, naming the line', () => {
    const report = reviewToolSource(
      toolSource({
        body: "    const r = await ctx.net.fetch('https://api.example.com/v1');\n    return { ok: r.ok };",
      }),
    );
    expect(firstCode(report)).toBe('capability_undeclared');
    expect(report.issues[0]?.message).toContain('capabilities.net.hosts');
    expect(report.issues[0]?.line).toBe(11);
  });

  it('refuses ctx.env.NAME without the name in env.read', () => {
    const undeclared = reviewToolSource(
      toolSource({
        capabilities: "{ env: { read: ['EXA_API_KEY'] } }",
        body: '    return { key: ctx.env.OTHER_KEY };',
      }),
    );
    expect(firstCode(undeclared)).toBe('capability_undeclared');
    expect(undeclared.issues[0]?.message).toContain('OTHER_KEY');

    const declared = reviewToolSource(
      toolSource({
        capabilities: "{ env: { read: ['EXA_API_KEY'] } }",
        body: '    return { key: ctx.env.EXA_API_KEY };',
      }),
    );
    expect(declared.ok).toBe(true);
  });

  it('treats net: undefined and env: undefined as absent, exactly like defineTool', () => {
    const report = reviewToolSource(
      toolSource({ capabilities: '{ net: undefined, env: undefined }' }),
    );

    expect(report.ok).toBe(true);
    expect(report.capabilities?.net).toEqual({ hosts: [] });
    expect(report.capabilities?.env).toEqual({ read: [] });
  });
});

describe('rule 7: invalid_argv_grant', () => {
  it('refuses a path, a flag and an empty string', () => {
    for (const grant of ['/usr/bin/adb', './adb', '--help', '-s', '']) {
      const report = reviewToolSource(
        toolSource({ capabilities: `{ process: { argv: [${JSON.stringify(grant)}] } }` }),
      );
      expect(firstCode(report), grant).toBe('invalid_argv_grant');
      expect(report.issues[0]?.line).toBe(9);
    }
  });

  it('accepts bare executable names', () => {
    const report = reviewToolSource(
      toolSource({ capabilities: "{ process: { argv: ['adb', 'adb.exe', 'git'] } }" }),
    );

    expect(report.ok).toBe(true);
    expect(report.capabilities?.process.argv).toEqual(['adb', 'adb.exe', 'git']);
  });
});

describe('rule 8: invalid_fs_grant', () => {
  it('refuses an absolute path, a parent segment, a backslash, ~ and a drive path', () => {
    const grants = ['/etc/passwd', '../secret', String.raw`a\b`, '~/.ssh', 'C:/Windows'];
    for (const grant of grants) {
      const report = reviewToolSource(
        toolSource({ capabilities: `{ fs: { read: [${JSON.stringify(grant)}] } }` }),
      );
      expect(firstCode(report), grant).toBe('invalid_fs_grant');
    }
  });

  it('accepts workspace-relative globs and sorts them', () => {
    const report = reviewToolSource(
      toolSource({ capabilities: "{ fs: { read: ['src/**/*.ts', '**/*'], write: ['dist/**'] } }" }),
    );

    expect(report.ok).toBe(true);
    expect(report.capabilities?.fs.read).toEqual(['**/*', 'src/**/*.ts']);
    expect(report.capabilities?.fs.write).toEqual(['dist/**']);
  });
});

describe('rule 9: limit_too_large', () => {
  it('refuses timeoutMs over 60000 and maxOutputBytes over 8388608', () => {
    expect(
      firstCode(reviewToolSource(toolSource({ capabilities: '{ limits: { timeoutMs: 60001 } }' }))),
    ).toBe('limit_too_large');
    expect(
      firstCode(
        reviewToolSource(toolSource({ capabilities: '{ limits: { maxOutputBytes: 8388609 } }' })),
      ),
    ).toBe('limit_too_large');
  });

  it('accepts the exact ceilings and fills defaults for the rest', () => {
    const report = reviewToolSource(
      toolSource({
        capabilities: '{ limits: { timeoutMs: 60000, maxOutputBytes: 8388608 } }',
      }),
    );

    expect(report.ok).toBe(true);
    expect(report.capabilities?.limits).toEqual({
      timeoutMs: 60_000,
      maxOutputBytes: 8_388_608,
    });
  });
});

describe('rule 10: weak_description', () => {
  it('refuses a description shorter than 20 characters and reports its line', () => {
    const source = toolSource({ description: 'Too short.' });
    const report = reviewToolSource(source);

    expect(firstCode(report)).toBe('weak_description');
    expect(report.issues[0]?.line).toBe(lineOf(source, 'Too short.'));
  });

  it('accepts exactly 20 characters and refuses a template description', () => {
    expect(reviewToolSource(toolSource({ description: '12345678901234567890' })).ok).toBe(true);

    const template = toolSource({ description: 'A description that is long enough.' }).replace(
      '"A description that is long enough."',
      '`A description that is long enough.`',
    );
    expect(firstCode(reviewToolSource(template))).toBe('weak_description');
  });
});

describe('verifyToolSource', () => {
  it('builds a statically clean source and confirms the manifest', async () => {
    const report = await verifyToolSource(toolSource());

    expect(report.ok).toBe(true);
    expect(report.name).toBe('tool.sample');
    expect(report.version).toBe('0.1.0');
    expect(report.capabilities?.fs.read).toEqual(['**/*']);
  });

  it('reports one build_failed issue with the esbuild message and no stack', async () => {
    const report = await verifyToolSource(toolSource({ body: '    const x = ;\n    return {};' }));

    expect(report.ok).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.code).toBe('build_failed');
    expect(report.issues[0]?.message).toContain('ERROR');
    expect(report.issues[0]?.line).toBe(11);
    expect(report.issues[0]?.message).not.toContain('    at ');
  });

  it('never builds a source that failed a static rule', async () => {
    const report = await verifyToolSource(toolSource({ body: '    return process.env;' }));

    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(['forbidden_identifier']);
  });
});
