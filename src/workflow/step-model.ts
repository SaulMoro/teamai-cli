/**
 * Which model a prompt step runs on, first match wins: the step's `model`, the model its definition sets for the
 * tool, the `defaults.model` in effect, the tool's default. The lease carries the first and third as written; they
 * resolve here, with the member's aliases for the step's tool. A definition's model, or none, launches as before.
 */
import { isModelAlias, loadModelAliases, resolveModelValue, TEAM_ALIASES_FILE, type ResolutionStep } from '../models/aliases.js';
import { toolExtrasFor, type AgentSpec } from '../resources/agent-format.js';
import type { LocalConfig } from '../types.js';
import { localToolFamily, type LocalToolRun, type LocalWorkflowTool } from './local-tool-adapter.js';
import type { WorkflowFailure } from './types.js';

export type StepModel = NonNullable<LocalToolRun['model']>;

/** The model the step chose, none when the launch is as before, or why the step cannot run. */
export type StepModelChoice = { ok: true; model?: StepModel } | { ok: false; failure: WorkflowFailure };

export interface StepModelRequest {
  /** The step path the lease names, such as `check.classify`. */
  step: string;
  tool: LocalWorkflowTool;
  /** The lease's `model`, as written. */
  model?: string;
  /** The lease's `defaultModel`, as written. */
  defaultModel?: string;
  /** The definition deployed for the tool, when the step names an agent. */
  agent?: AgentSpec;
  /** The scope whose aliases resolve the step's `model` or `defaults.model`. */
  config: LocalConfig;
}

type ModelOrigin = 'step' | 'defaults';

/** Why a value gives the tool no model: no entry for it, the member's `~` or `default`, a model switch, or an error. */
type NoModel = 'unmapped' | 'local' | 'switched' | 'unresolved';

interface NoModelContext {
  step: string;
  /** `model alias "fast"`, or `model "fast"` when it cannot be told to be an alias. */
  value: string;
  tool: string;
  source: string;
  reason: string;
}

const NO_MODEL: Record<NoModel, Record<ModelOrigin, (at: NoModelContext) => string>> = {
  unmapped: {
    step: (at) => `Step "${at.step}" asks for ${at.value}, which has no model for ${at.tool} in ${at.source}. Add one or remove model from the step.`,
    defaults: (at) => `Step "${at.step}" gets ${at.value} from defaults, which has no model for ${at.tool} in ${at.source}. Add one, or set model on the step.`,
  },
  local: {
    step: (at) => `Step "${at.step}" asks for ${at.value}, which ${at.source} turns off for ${at.tool}. Remove that entry or remove model from the step.`,
    defaults: (at) => `Step "${at.step}" gets ${at.value} from defaults, which ${at.source} turns off for ${at.tool}. Remove that entry, or set model on the step.`,
  },
  switched: {
    step: (at) => `Step "${at.step}" asks for ${at.value}, which gives no model for ${at.tool} while teamai models switch points ${at.tool} at a model profile. `
      + 'Run teamai models restore, or remove model from the step.',
    defaults: (at) => `Step "${at.step}" gets ${at.value} from defaults, which gives no model for ${at.tool} while teamai models switch points ${at.tool} at a model profile. `
      + 'Run teamai models restore, or set model on the step.',
  },
  unresolved: {
    step: (at) => `Step "${at.step}" asks for ${at.value}, which cannot be resolved for ${at.tool}: ${at.reason}. Fix that, or remove model from the step.`,
    defaults: (at) => `Step "${at.step}" gets ${at.value} from defaults, which cannot be resolved for ${at.tool}: ${at.reason}. Fix that, or set model on the step.`,
  },
};

/** Why a resolution step gives no model. The only other one that can is `default`: the alias does not map the tool. */
const NO_MODEL_STEPS: Partial<Record<ResolutionStep, NoModel>> = { local: 'local', switched: 'switched' };

function unavailable(message: string): StepModelChoice {
  return { ok: false, failure: { code: 'model_unavailable', message } };
}

export async function chooseStepModel(request: StepModelRequest): Promise<StepModelChoice> {
  const { step, tool, agent } = request;
  const chosen: { origin: ModelOrigin; value: string } | undefined = request.model !== undefined
    ? { origin: 'step', value: request.model }
    : agent?.model === undefined && request.defaultModel !== undefined ? { origin: 'defaults', value: request.defaultModel } : undefined;
  if (!chosen) return { ok: true };
  const aliases = await loadModelAliases(request.config);
  const resolution = resolveModelValue(aliases, chosen.value, tool);
  if (!resolution.ok || resolution.model === undefined) {
    const why = resolution.ok ? NO_MODEL_STEPS[resolution.step] ?? 'unmapped' : 'unresolved';
    return unavailable(NO_MODEL[why][chosen.origin]({
      step,
      value: isModelAlias(aliases, chosen.value) ? `model alias "${chosen.value}"` : `model "${chosen.value}"`,
      tool,
      source: (resolution.ok && resolution.source) || TEAM_ALIASES_FILE,
      reason: resolution.ok ? '' : resolution.reason,
    }));
  }
  const model: StepModel = { name: resolution.model, ...(resolution.effort !== undefined ? { effort: resolution.effort } : {}) };
  // OpenCode applies the agent's variant to a launch on the agent's own model that passes none. Not a subagent's:
  // `opencode run --agent` runs the default agent in its place.
  const extras = agent && agent.model === model.name && localToolFamily(tool) === 'opencode' ? toolExtrasFor(agent, 'opencode') : undefined;
  const variant = extras?.['mode'] === 'subagent' ? undefined : extras?.['variant'];
  if (agent && variant !== undefined && model.effort === undefined) {
    return unavailable(`Step "${step}" runs agent "${agent.name}" on its own model "${model.name}" with no effort for ${tool}, so ${tool} would apply `
      + `the agent's variant "${String(variant)}". Remove model from the step to run at that variant, or set it to an alias with an effort for ${tool}.`);
  }
  return { ok: true, model };
}
