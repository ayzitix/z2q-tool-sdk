import { defineTool } from 'z1-tool-sdk';
import { z } from 'zod';

type AdbDevice = {
  serial: string;
  state: string;
};

/**
 * Example only: list Android devices through the runtime's process broker.
 * The capability declares the executable; the runtime decides whether to run it.
 */
export const tool = defineTool({
  name: 'tool.adb-devices',
  version: '0.1.0',
  description: 'List Android devices attached to the local adb server using argv-only process calls.',
  parameters: z.object({}),
  capabilities: {
    process: { argv: ['adb'] },
    limits: { timeoutMs: 15_000 },
  },
  run: async (ctx) => {
    const result = await ctx.process.run({ argv: ['adb', 'devices'] });
    if (result.code !== 0) {
      throw new Error(`adb devices failed with exit code ${result.code}: ${result.stderr.trim()}`);
    }

    const devices: AdbDevice[] = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('List of devices'))
      .map((line) => {
        const [serial = '', state = 'unknown'] = line.split(/\s+/);
        return { serial, state };
      });

    return { devices, count: devices.length };
  },
});
