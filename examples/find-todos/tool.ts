import { defineTool } from 'z1-tool-sdk';
import { z } from 'zod';

type TodoMatch = {
  path: string;
  line: number;
  text: string;
};

/**
 * Find TODO/FIXME comments in workspace files. Read-only: no process, no net.
 */
export const tool = defineTool({
  name: 'tool.find-todos',
  version: '0.1.0',
  description: 'Find TODO and FIXME comments in workspace files and return their paths and line numbers.',
  parameters: z.object({
    glob: z.string().default('**/*').describe('Workspace-relative glob of files to scan.'),
    limit: z.number().int().positive().max(500).default(50).describe('Maximum number of matches.'),
  }),
  capabilities: {
    fs: { read: ['**/*'] },
    limits: { timeoutMs: 10_000, maxOutputBytes: 262_144 },
  },
  run: async (ctx, args) => {
    const matches: TodoMatch[] = [];
    const files = await ctx.fs.glob(args.glob);

    for (const path of files.sort()) {
      if (matches.length >= args.limit) break;
      const text = await ctx.fs.read(path);
      const lines = text.split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (!/\b(TODO|FIXME)\b/.test(line)) continue;
        matches.push({ path, line: index + 1, text: line.trim() });
        if (matches.length >= args.limit) break;
      }
    }

    return { matches, count: matches.length };
  },
});
