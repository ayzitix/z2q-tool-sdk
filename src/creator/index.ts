/**
 * The Tool Creator core: request -> prompt -> static review -> project ->
 * sandbox smoke test -> install behind `approval.json`.
 *
 * The model call is the host's job. Nothing here imports a provider, opens a
 * network connection or calls a model.
 */

export {
  ToolCreatorError,
  buildToolPrompt,
  isValidToolName,
  normalizeToolName,
  resolveToolRequest,
} from './prompt.js';
export type { ToolCreatorCode, ToolPrompt, ToolRequest } from './prompt.js';

export { CREATOR_LIMITS, reviewToolSource, verifyToolSource } from './review.js';
export type { ToolSourceIssue, ToolSourceReport } from './review.js';

export {
  createToolProject,
  placeholderToolSource,
  scaffoldToolProject,
} from './project.js';
export type {
  ToolProjectOptions,
  ToolProjectResult,
  ToolProjectScaffold,
} from './project.js';

export { smokeTestTool } from './smoke.js';
export type { SmokeTestOptions, SmokeTestResult, SmokeTestRun } from './smoke.js';

export { installTool, listInstalledTools, loadInstalledTool } from './install.js';
export type { ApprovalRecord, InstallToolOptions, InstalledTool } from './install.js';

export { describeCapabilities } from './capabilities.js';
export type { CapabilityRisk, CapabilitySummary } from './capabilities.js';
