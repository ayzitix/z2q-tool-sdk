import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildToolPrompt } from '../src/creator/prompt.js';
import type { ToolCreatorModelRequest } from '../src/creator/flow.js';
import {
  ToolCreatorError,
  createToolCreator,
} from '../src/index.js';
import { cleanupTempDirs, tempDir } from './runtime-helpers.js';

afterAll(async () => {
  await cleanupTempDirs();
});

const PURPOSE = 'Find TODO comments and return a small JSON summary.';
const NAME = 'tool.flow-demo';
const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);

function sourceFor(run = 'return { ok: true };', name = NAME): string {
  return `import { defineTool } from 'z1-tool-sdk';
import { z } from 'zod';

export const tool = defineTool({
  name: '${name}',
  version: '0.1.0',
  description: 'Find TODO comments and return a small JSON summary.',
  parameters: z.object({}),
  capabilities: {},
  run: async () => {
    ${run}
  },
});
`;
}

interface Stub {
  calls: ToolCreatorModelRequest[];
  generate: (request: ToolCreatorModelRequest) => Promise<string>;
}

function stub(replies: Array<string | Error | (() => Promise<string>)>): Stub {
  const calls: ToolCreatorModelRequest[] = [];
  return {
    calls,
    async generate(request) {
      calls.push(request);
      const reply = replies.shift();
      if (reply === undefined) throw new Error('the stub ran out of replies');
      if (reply instanceof Error) throw reply;
      if (typeof reply === 'function') return reply();
      return reply;
    },
  };
}

function creatorFor(
  workspace: string,
  stubValue: Stub,
  extra: Record<string, unknown> = {},
) {
  return createToolCreator({
    workspace,
    generate: stubValue.generate,
    now: () => NOW,
    ...extra,
  });
}

async function rejection(promise: Promise<unknown>): Promise<ToolCreatorError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolCreatorError);
    return error as ToolCreatorError;
  }
  throw new Error('expected the call to reject, but it resolved');
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) !== undefined;
}

function detailsOf(error: ToolCreatorError): Record<string, unknown> {
  expect(error.details).toBeDefined();
  return error.details as Record<string, unknown>;
}

function request(name = NAME) {
  return { name, purpose: PURPOSE };
}

describe('createToolCreator: propose', () => {
  it('returns a built, smoke-tested proposal on the first valid reply', async () => {
    const workspace = await tempDir('z2q-flow-happy-');
    const stubValue = stub([sourceFor()]);
    const creator = creatorFor(workspace, stubValue);

    const proposal = await creator.propose(request());

    expect(proposal.request.name).toBe(NAME);
    expect(proposal.manifest.name).toBe(NAME);
    expect(proposal.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(proposal.smoke.ok).toBe(true);
    expect(proposal.attempts).toBe(1);
    expect(proposal.history).toEqual([]);
    expect(proposal.summary.risk).toBe('read-only');
    expect(proposal.projectDir).toContain(join(workspace, '.z2q', 'proposals'));
    expect(stubValue.calls[0]?.attempt).toBe(1);
    expect(stubValue.calls[0]?.issues).toBeUndefined();
  });

  it('accepts the first fenced block with defineTool, prose and a filename line', async () => {
    const workspace = await tempDir('z2q-flow-fence-');
    const body = sourceFor();
    const reply = `Here is the tool you asked for:\n\n\`\`\`ts\ntool.ts\n${body}\n\`\`\`\n\nThat should be all.`;
    const creator = creatorFor(workspace, stub([reply]));

    const proposal = await creator.propose(request());

    expect(proposal.source).toContain("import { defineTool } from 'z1-tool-sdk';");
    expect(proposal.source.startsWith('import')).toBe(true);
    expect(proposal.source).not.toContain('tool.ts\n');
    expect(proposal.smoke.ok).toBe(true);
  });

  it('retries once with the exact review issues and uses the second reply', async () => {
    const workspace = await tempDir('z2q-flow-retry-');
    const bad = sourceFor('return { home: process.env.HOME };');
    const good = sourceFor('return { ok: true }; // second reply');
    const stubValue = stub([bad, good]);
    const creator = creatorFor(workspace, stubValue);

    const proposal = await creator.propose(request());

    expect(proposal.attempts).toBe(2);
    expect(proposal.history).toHaveLength(1);
    expect(proposal.history[0]?.attempt).toBe(1);
    expect(proposal.history[0]?.issues.join(' ')).toContain('forbidden_identifier');
    expect(proposal.history[0]?.issues.join(' ')).toContain('process');
    expect(proposal.source).toContain('second reply');
    expect(stubValue.calls[1]?.attempt).toBe(2);
    expect(stubValue.calls[1]?.issues?.length).toBeGreaterThan(0);
    expect(stubValue.calls[1]?.user).toContain('Fix exactly these issues');
  });

  it('throws review_failed after the last attempt and writes no project', async () => {
    const workspace = await tempDir('z2q-flow-review-');
    const proposalDir = join(workspace, 'proposals');
    const creator = creatorFor(workspace, stub([sourceFor('return { x: process.env.X };')]), {
      maxAttempts: 1,
      proposalDir,
    });

    const error = await rejection(creator.propose(request()));

    expect(error.code).toBe('review_failed');
    expect(error.issues?.length).toBeGreaterThan(0);
    expect(error.issues?.[0]?.code).toBe('forbidden_identifier');
    expect(await exists(proposalDir)).toBe(false);
  });

  it('maps a thrown model, a timeout and a thrown AbortError to distinct codes', async () => {
    const workspace = await tempDir('z2q-flow-model-');

    const failed = await rejection(
      creatorFor(workspace, {
        calls: [],
        generate: async () => {
          throw new Error('provider exploded');
        },
      }).propose(request()),
    );
    expect(failed.code).toBe('model_failed');
    expect(failed.message).toContain('provider exploded');

    const started = Date.now();
    const timedOut = await rejection(
      creatorFor(
        workspace,
        {
          calls: [],
          generate: () => new Promise<string>(() => undefined),
        },
        { timeoutMs: 75 },
      ).propose(request()),
    );
    const elapsed = Date.now() - started;
    expect(timedOut.code).toBe('model_timeout');
    expect(elapsed).toBeLessThan(3_000);

    const abort = new Error('the host aborted');
    abort.name = 'AbortError';
    const aborted = await rejection(
      creatorFor(workspace, {
        calls: [],
        generate: async () => {
          throw abort;
        },
      }).propose(request()),
    );
    expect(aborted.code).toBe('model_aborted');
  });

  it('honours a caller signal aborted before the first attempt', async () => {
    const workspace = await tempDir('z2q-flow-abort-');
    const controller = new AbortController();
    controller.abort();
    const calls: ToolCreatorModelRequest[] = [];
    const creator = createToolCreator({
      workspace,
      generate: async (modelRequest) => {
        calls.push(modelRequest);
        return sourceFor();
      },
    });

    const error = await rejection(creator.propose(request(), { signal: controller.signal }));

    expect(error.code).toBe('model_aborted');
    expect(calls).toEqual([]);
  });

  it('maps an empty reply and prose with no tool definition to no_source', async () => {
    const workspace = await tempDir('z2q-flow-empty-');

    const empty = await rejection(creatorFor(workspace, stub([''])).propose(request()));
    expect(empty.code).toBe('no_source');

    const prose = await rejection(
      creatorFor(workspace, stub(['I cannot write that tool today.'])).propose(request()),
    );
    expect(prose.code).toBe('no_source');
  });

  it('reports smoke_failed with the runs in details when run throws', async () => {
    const workspace = await tempDir('z2q-flow-smoke-');
    const creator = creatorFor(workspace, stub([sourceFor("throw new Error('boom');")]));

    const error = await rejection(creator.propose(request()));

    expect(error.code).toBe('smoke_failed');
    const details = detailsOf(error);
    expect(JSON.stringify(details)).toContain('tool_threw');
    expect(Array.isArray(details.runs)).toBe(true);
  });
});

describe('createToolCreator: install and defaults', () => {
  it('installs an approved proposal, refuses a changed bundle, and refuses a second version', async () => {
    const workspace = await tempDir('z2q-flow-install-');
    const toolsDir = join(workspace, 'tools');
    const creator = creatorFor(workspace, stub([sourceFor()]), { toolsDir });
    const proposal = await creator.propose(request());
    const bundle = join(proposal.projectDir, 'dist', 'index.js');
    const original = await readFile(bundle);

    await writeFile(bundle, `${original.toString('utf8')}\n// changed after the smoke test\n`, 'utf8');
    const changed = await rejection(creator.install(proposal));
    expect(changed.code).toBe('install_failed');
    expect(changed.message).toContain('sha_mismatch');
    expect(detailsOf(changed).code).toBe('sha_mismatch');
    expect(await exists(join(toolsDir, NAME, '0.1.0'))).toBe(false);

    await writeFile(bundle, original);
    const installed = await creator.install(proposal, { approvedBy: 'reviewer' });
    expect(installed.name).toBe(NAME);
    expect(installed.version).toBe('0.1.0');
    expect(await exists(join(installed.path, 'approval.json'))).toBe(true);

    const again = await rejection(creator.install(proposal));
    expect(again.code).toBe('install_failed');
    expect(detailsOf(again).code).toBe('version_exists');
  });

  it('refuses a reserved Windows device name as a tool directory', async () => {
    const { isValidToolName } = await import('../src/creator/prompt.js');

    for (const name of ['con', 'nul', 'com1', 'lpt1', 'CON']) {
      expect(isValidToolName(name)).toBe(false);
    }
    expect(isValidToolName('tool.con')).toBe(true);
    expect(isValidToolName('console')).toBe(true);
  });

  it('refuses malformed options and a signal that is not an AbortSignal', async () => {
    const workspace = await tempDir('z2q-flow-options-');
    const creator = creatorFor(workspace, stub([sourceFor()]));

    const nullOptions = await rejection(creator.propose(request(), null as never));
    expect(nullOptions.code).toBe('invalid_request');

    const badSignal = await rejection(
      creator.propose(request(), { signal: {} as AbortSignal }),
    );
    expect(badSignal.code).toBe('invalid_request');
    expect(badSignal.message).toContain('AbortSignal');
  });

  it('treats expectSha256 as a stricter expectation, not an override', async () => {
    const workspace = await tempDir('z2q-flow-expect-');
    const creator = creatorFor(workspace, stub([sourceFor()]));
    const proposal = await creator.propose(request());

    const mismatch = await rejection(
      creator.install(proposal, { expectSha256: 'a'.repeat(64) }),
    );
    expect(mismatch.code).toBe('install_failed');
    expect(detailsOf(mismatch).code).toBe('sha_mismatch');

    const installed = await creator.install(proposal, { expectSha256: proposal.sha256 });
    expect(installed.sha256).toBe(proposal.sha256);
  });

  it('reports a renamed tool as a review failure with a name_mismatch issue', async () => {
    const workspace = await tempDir('z2q-flow-rename-');
    const creator = creatorFor(workspace, stub([sourceFor('return { ok: true };', 'tool.other')]));

    const error = await rejection(creator.propose(request()));

    expect(error.code).toBe('review_failed');
    expect(error.issues?.[0]?.code).toBe('name_mismatch');
    expect(error.message).toContain('tool.other');
  });

  it('keeps proposalDir and toolsDir lazy under the default .z2q root', async () => {
    const workspace = await tempDir('z2q-flow-defaults-');
    const creator = creatorFor(workspace, stub([sourceFor()]));

    expect(await exists(join(workspace, '.z2q'))).toBe(false);

    const proposal = await creator.propose(request());
    expect(await exists(join(workspace, '.z2q', 'proposals'))).toBe(true);
    expect(await exists(join(workspace, '.z2q', 'tools'))).toBe(false);

    await creator.install(proposal);
    expect(await exists(join(workspace, '.z2q', 'tools', NAME, '0.1.0', 'approval.json'))).toBe(true);
  });
});

describe('createToolCreator: prompt contract', () => {
  it('keeps attempt 1 deterministic and adds the repair note only from attempt 2', async () => {
    const workspace = await tempDir('z2q-flow-prompt-');
    const stubValue = stub([
      sourceFor('return { home: process.env.HOME };'),
      sourceFor(),
    ]);
    const creator = creatorFor(workspace, stubValue);
    const toolRequest = request();
    const expected = buildToolPrompt(toolRequest);

    await creator.propose(toolRequest);

    expect(stubValue.calls[0]?.system).toBe(expected.system);
    expect(stubValue.calls[0]?.user).toBe(expected.user);
    expect(stubValue.calls[0]?.issues).toBeUndefined();
    expect(stubValue.calls[1]?.user).toContain(
      'Your previous reply was rejected by the static review.',
    );
    expect(stubValue.calls[1]?.user).toContain('forbidden_identifier');
    expect(stubValue.calls[1]?.user).not.toBe(expected.user);
  });
});
