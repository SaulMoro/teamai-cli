import { describe, expect, it } from 'vitest';
import { launch } from './launch.js';

describe('the sign-in variables of Claude Code', () => {
  it('name the gateway Claude reads, as a base URL and the token it signs in to it with', () => {
    expect(launch.claude.signIn.gateway).toEqual({ url: 'ANTHROPIC_BASE_URL', token: 'ANTHROPIC_AUTH_TOKEN' });
  });
});
