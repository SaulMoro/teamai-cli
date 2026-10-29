/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import { compilePlan, type BenchmarkPlan } from '../benchmark/plan.js';
import type { Suite } from '../benchmark/suite.js';

declare const plan: BenchmarkPlan;
declare const suite: Suite;

// @ts-expect-error a plan compiles only from a suite whose check files were committed, never beside a map of commits
export const besideCommits = (): unknown => compilePlan(plan, suite, new Map());

// @ts-expect-error only the function that commits a suite's check files makes a committed suite
export const unbranded = (): unknown => compilePlan(plan, { suite, files: new Map() });
