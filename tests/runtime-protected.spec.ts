import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRuntimeError } from '../src/runtime/errors.js';
import { assertReadable, assertWritable, ensurePolicyHost } from '../src/runtime/policy.js';
import { capabilities, cleanupTempDirs, tempDir } from './runtime-helpers.js';

const ALL_WRITE = capabilities({ read: ['**/*'], write: ['**/*'], argv: ['node'] });

beforeAll(async () => {
  await ensurePolicyHost();
});

afterAll(async () => {
  await cleanupTempDirs();
});

function expectCode(fn: () => unknown, code: string): ToolRuntimeError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolRuntimeError);
    expect((error as ToolRuntimeError).code).toBe(code);
    return error as ToolRuntimeError;
  }
  throw new Error('expected the policy to refuse, but it allowed');
}

/**
 * Self-protection: the tool must not be able to break the runtime that executes
 * it. A broken runtime cannot be repaired by the agent that broke it, so these
 * refusals are part of the capability policy rather than a prompt instruction.
 */
describe('runtime self-protection', () => {
  it('refuses a write into node_modules at any depth but still allows reading it', async () => {
    const workspace = await tempDir('z1-protected-nm-');
    await mkdir(join(workspace, 'packages', 'app', 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(join(workspace, 'packages', 'app', 'node_modules', 'left-pad', 'index.js'), 'export default 1\n');

    expectCode(
      () => assertWritable('packages/app/node_modules/left-pad/index.js', ALL_WRITE, workspace),
      'protected_path',
    );
    expect(assertReadable('packages/app/node_modules/left-pad/index.js', ALL_WRITE, workspace)).toBe(
      'packages/app/node_modules/left-pad/index.js',
    );
  });

  it('allows an ordinary workspace write with the same grants', async () => {
    const workspace = await tempDir('z1-protected-ok-');
    expect(assertWritable('notes.md', ALL_WRITE, workspace)).toBe('notes.md');
  });

  it('refuses a write inside a protected runtime root', async () => {
    const workspace = await tempDir('z1-protected-root-');
    const runtime = join(workspace, 'z1-cli');
    await mkdir(join(runtime, 'src'), { recursive: true });

    expectCode(
      () => assertWritable('z1-cli/src/agent.ts', ALL_WRITE, workspace, { protectedRoots: [runtime] }),
      'protected_path',
    );
    // A sibling of the runtime is still writable: the refusal is scoped, not blanket.
    expect(assertWritable('notes.md', ALL_WRITE, workspace, { protectedRoots: [runtime] })).toBe('notes.md');
  });

  it('refuses every write when the workspace itself is the runtime', async () => {
    const workspace = await tempDir('z1-protected-self-');
    expectCode(
      () => assertWritable('src/agent.ts', ALL_WRITE, workspace, { protectedRoots: [workspace] }),
      'protected_path',
    );
  });

  it('ignores empty and relative protected roots instead of guessing at them', async () => {
    const workspace = await tempDir('z1-protected-junk-');
    expect(
      assertWritable('notes.md', ALL_WRITE, workspace, { protectedRoots: ['', '   ', 'relative/dir'] }),
    ).toBe('notes.md');
  });
});
