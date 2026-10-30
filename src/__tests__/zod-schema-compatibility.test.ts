import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadModelInputs } from '../models/profile.js';
import { DEFAULT_TOOL_PATHS, LocalConfigSchema, SharingConfigSchema, TeamaiConfigSchema } from '../types.js';
import { StepStateSchema } from '../workflow/step-state.js';
import { parseSkillCall } from '../workflow/drivers/skill/skill-driver.js';

describe('persisted schema compatibility', () => {
  it('fills nested sharing defaults and leaves undeclared policy blocks absent', () => {
    const config = TeamaiConfigSchema.parse({ team: 'example', repo: 'https://example.test/team.git' });
    expect(config.sharing).toEqual({
      skills: {},
      rules: { enforced: [] },
      docs: { localDir: '~/.teamai/docs' },
      env: { injectShellProfile: true },
    });
    expect(config.toolPaths).toEqual(DEFAULT_TOOL_PATHS);
    expect(Object.hasOwn(config.sharing, 'coAuthor')).toBe(false);
    expect(SharingConfigSchema.parse({ coAuthor: {} }).coAuthor).toEqual({ enabled: true });
  });

  it('normalizes legacy scopes and preserves invalid optional scoring settings for diagnostics', () => {
    const config = LocalConfigSchema.parse({
      repo: { remote: 'https://example.test/team.git', localPath: '/tmp/team' },
      username: 'member',
      scope: 'workspace',
      scoring: { isolation: 3, sessions: ['unknown'], daily_limit: { unknown: true } },
      dataHome: '/untrusted/path',
    });
    expect(config.scope).toBe('project');
    expect(config.scoring).toEqual({ isolation: '3', sessions: ['unknown'], daily_limit: '{"unknown":true}' });
    expect(Object.hasOwn(config, 'dataHome')).toBe(false);
  });

  it('accepts omitted driver flags and still refuses explicitly unsupported flags', () => {
    expect(parseSkillCall({ kind: 'start', name: 'review', options: {} }, {})).toEqual({
      kind: 'start', name: 'review', inputs: undefined, answers: { confirmed: false },
    });
    expect(parseSkillCall({ kind: 'next', run: 'r00000000', options: {} }, {})).toEqual({ kind: 'next', run: 'r00000000', wait: false });
    expect(parseSkillCall({ kind: 'next', run: 'r00000000', options: { json: '{}' } }, {})).toEqual({
      error: { code: 'invalid_arguments', message: '--driver skill takes no --json: the skill driver composes every request itself', next: null },
    });
  });

  it('reads named local model inputs and rejects unknown fields instead of dropping them', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-model-input-schema-'));
    const file = path.join(directory, 'values.json');
    try {
      const inputs = { 'team:review': { API_KEY: { env: 'REVIEW_API_KEY' } }, local: {} };
      await fs.writeFile(file, JSON.stringify(inputs));
      await expect(loadModelInputs(file)).resolves.toEqual(inputs);
      await fs.writeFile(file, JSON.stringify({ local: { unexpected: true } }));
      await expect(loadModelInputs(file)).rejects.toThrow('Invalid local model inputs');
    } finally {
      await fs.rm(directory, { recursive: true });
    }
  });

  it('reads settled foreach results whose item was absent in older run records', () => {
    const step = StepStateSchema.parse({
      id: 'review', status: 'succeeded', attempts: [], passes: [], results: [{ outcome: 'success' }],
    });
    expect(step).toMatchObject({ settledAt: 0, outcome: 'success', results: [{ outcome: 'success' }] });
    expect('results' in step && Object.hasOwn(step.results?.[0] ?? {}, 'item')).toBe(false);
  });
});
