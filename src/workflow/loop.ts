/**
 * Step loops. A step with `loop` runs its range again after it succeeds: `back_to`, the step, and every step between
 * them. These rules are shared by pull, which rejects loops a run could not settle, and by the engine, which settles them.
 */
import type { ExpressionPass } from './expression.js';
import { endLoop, exhaust, passOf, repend, type StepState } from './step-state.js';
import type { RunState, StepLoop, WorkflowFailure, WorkflowStep } from './types.js';

type LoopStep = Pick<WorkflowStep, 'id' | 'needs' | 'loop' | 'end'>;

/** The steps of one workflow that loops run again, and what waits for those loops. */
export interface StepLoops {
  /** Each loop's range, by the id of the step that owns it. */
  ranges: Map<string, Set<string>>;
  /** The loop owners a step waits for besides what it needs and reads: the loops outside whose range it needs or reads a step inside it. */
  waitsFor(id: string, reads: Iterable<string>): string[];
}

/** A step loop pull rejects, at the key of the step it is reported on. */
export interface LoopProblem {
  id: string;
  key: 'loop' | 'loop.back_to' | 'needs';
  message: string;
}

/** The ids `id` needs, directly or through their needs. */
function ancestors(needs: Map<string, string[]>, id: string): Set<string> {
  const found = new Set<string>();
  const pending = [...needs.get(id) ?? []];
  for (let need = pending.pop(); need !== undefined; need = pending.pop()) {
    if (found.has(need)) continue;
    found.add(need);
    pending.push(...needs.get(need) ?? []);
  }
  return found;
}

/** R(X): `back_to`, the owner X, and every step that needs `back_to` and that X needs, directly or not. */
function rangeOf(needs: Map<string, string[]>, owner: string, backTo: string): Set<string> {
  const before = ancestors(needs, owner);
  return new Set([backTo, ...[...before].filter((id) => ancestors(needs, id).has(backTo)), owner]);
}

export function stepLoops(steps: LoopStep[]): StepLoops {
  const needs = new Map(steps.map((step) => [step.id, step.needs ?? []]));
  const ranges = new Map(steps.flatMap((step) => (step.loop ? [[step.id, rangeOf(needs, step.id, step.loop.backTo)] as const] : [])));
  return {
    ranges,
    waitsFor: (id, reads) => {
      const used = [...needs.get(id) ?? [], ...reads];
      return [...ranges].filter(([, range]) => !range.has(id) && used.some((read) => range.has(read))).map(([owner]) => owner);
    },
  };
}

/** The first cycle through `edges`, starting at the step declared first, or undefined when there is none. */
function firstCycle(ids: string[], edges: Map<string, string[]>): string[] | undefined {
  const state = new Map<string, 'open' | 'closed'>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    state.set(id, 'open');
    path.push(id);
    for (const next of edges.get(id) ?? []) {
      if (state.get(next) === 'open') return [...path.slice(path.indexOf(next)), next];
      const found = state.has(next) || !edges.has(next) ? undefined : visit(next);
      if (found) return found;
    }
    path.pop();
    state.set(id, 'closed');
    return undefined;
  };
  for (const id of ids) {
    const found = state.has(id) ? undefined : visit(id);
    if (found) return found;
  }
  return undefined;
}

/**
 * The step loops of one workflow that pull rejects. `reads` holds the steps of this workflow each step reads in the
 * current pass. A needs cycle is reported elsewhere, so a wait cycle is reported only when `needs` alone has none.
 */
export function loopProblems(steps: LoopStep[], reads: Map<string, Set<string>>): LoopProblem[] {
  const problems: LoopProblem[] = [];
  const needs = new Map(steps.map((step) => [step.id, step.needs ?? []]));
  const { ranges, waitsFor } = stepLoops(steps);
  const claimed = new Map<string, string>();
  for (const step of steps) {
    if (!step.loop) continue;
    const { backTo } = step.loop;
    if (backTo !== step.id && !ancestors(needs, step.id).has(backTo)) {
      problems.push({ id: step.id, key: 'loop.back_to', message: `step "${step.id}" loop.back_to is "${backTo}", which is not "${step.id}" or a step it needs, directly or through its needs` });
      continue;
    }
    if (step.end !== undefined) {
      problems.push({ id: step.id, key: 'loop', message: `step "${step.id}" has loop and end; a step that ends its workflow cannot run again` });
      continue;
    }
    const range = ranges.get(step.id) ?? new Set<string>();
    const shared = [...range].find((id) => claimed.has(id));
    if (shared !== undefined) {
      problems.push({
        id: step.id,
        key: 'loop',
        message: `step "${step.id}" loop runs "${shared}" again, which the loop of step "${claimed.get(shared)}" also runs; loops in one workflow share no step, so put the inner one in a sub-workflow`,
      });
      continue;
    }
    for (const id of range) claimed.set(id, step.id);
  }
  if (problems.length > 0 || firstCycle(steps.map((step) => step.id), needs)) return problems;
  const waits = new Map(steps.map((step) => [step.id, [...needs.get(step.id) ?? [], ...waitsFor(step.id, reads.get(step.id) ?? [])]]));
  const cycle = firstCycle(steps.map((step) => step.id), waits);
  if (cycle) {
    problems.push({
      id: cycle[0]!,
      key: 'needs',
      message: `step "${cycle[0]}" waits in a cycle: ${cycle.join(' -> ')}; a step that needs or reads a step inside a loop waits until the loop ends`,
    });
  }
  return problems;
}

/** A loop owner whose loop runs no more in this activation: skipped, failed or cancelled, or succeeded and decided final. */
export function loopSettled(owner: StepState | undefined): boolean {
  if (!owner) return false;
  if (owner.status === 'succeeded') return owner.loopFinal === true;
  return owner.status === 'skipped' || owner.status === 'failed' || owner.status === 'cancelled';
}

function exhausted(owner: StepState, loop: StepLoop): WorkflowFailure {
  return { code: 'loop_exhausted', message: `Loop of step "${owner.id}" is exhausted: it ran ${loop.maxIterations} times, its max_iterations` };
}

/**
 * Decides, once per run of a succeeded loop owner, what follows it. `holds` is its `while`, or true when it has none.
 * The loop ends when `while` is false. While it holds, the range runs again, unless the owner has already run
 * `max_iterations` times: then it fails `loop_exhausted` and keeps its outputs. A loop without `while` always runs
 * again, and `exhaustedAtStart` stops the run that would go past the limit.
 */
export function decideStepLoop(run: RunState, owner: Extract<StepState, { status: 'succeeded' }>, loop: StepLoop, holds: boolean, range: StepState[]): void {
  const runs = (owner.iteration ?? 0) + 1;
  if (!holds) {
    endLoop(owner, runs);
  } else if (loop.while !== undefined && runs >= loop.maxIterations) {
    exhaust(owner, exhausted(owner, loop), owner.settledAt, runs);
  } else {
    for (const state of range) {
      archiveUnder(run, state.id);
      repend(state, state === owner ? runs : undefined);
    }
  }
}

/**
 * A loop owner about to start an action it has already run `max_iterations` times fails instead, with the outputs of
 * its latest pass. Returns whether it did.
 */
export function exhaustedAtStart(owner: Extract<StepState, { status: 'pending' }>, loop: StepLoop, settledAt: number): boolean {
  if ((owner.iteration ?? 0) < loop.maxIterations) return false;
  exhaust(owner, exhausted(owner, loop), settledAt);
  return true;
}

/** Moves the instances under a step, those of the workflow it ran, from the run's steps to its archive, with every pass they had. */
export function archiveUnder(run: RunState, path: string): void {
  const under = run.steps.filter((state) => state.id.startsWith(`${path}.`) || state.id.startsWith(`${path}[`));
  for (const state of under) {
    const current = passOf(state);
    for (const pass of [...state.passes ?? [], ...(current ? [current] : [])]) (run.archive ??= []).push({ step: state.id, ...pass });
  }
  for (let index = run.steps.length - 1; index >= 0; index -= 1) if (under.includes(run.steps[index]!)) run.steps.splice(index, 1);
}

/** The pass a new instance at `path` starts at: after every pass the archive holds for that path, so a pass id is never reused. */
export function firstPass(run: RunState, path: string): number {
  return 1 + Math.max(0, ...(run.archive ?? []).filter((entry) => entry.step === path).map((entry) => entry.pass));
}

/** `steps.<id>.passes`: the passes a loop archived on the instance, then its current pass once it settled. */
export function passesOf(state: StepState): ExpressionPass[] {
  const current = passOf(state);
  return [...state.passes ?? [], ...(current ? [current] : [])].map(({ pass, outcome, outputs, end }) => ({
    pass, outcome, ...(outputs !== undefined ? { outputs } : {}), ...(end !== undefined ? { end } : {}),
  }));
}
