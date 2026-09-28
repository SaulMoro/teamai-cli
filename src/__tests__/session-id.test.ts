import { describe, it, expect, afterEach, vi } from 'vitest';
import { AGENT_SESSION_ENV, agentSessionIdFromEnv, deriveSessionId } from '../utils/session-id.js';

describe('deriveSessionId', () => {
    const originalEnv = process.env.CLAUDE_SESSION_ID;

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env.CLAUDE_SESSION_ID;
        } else {
            process.env.CLAUDE_SESSION_ID = originalEnv;
        }
        vi.unstubAllEnvs();
    });

    it('prefers explicit session_id from payload', () => {
        expect(deriveSessionId({ session_id: 'explicit-session' })).toBe('explicit-session');
    });

    it('uses Copilot camelCase sessionId when the snake_case field is absent', () => {
        expect(deriveSessionId({ sessionId: 'copilot-session' })).toBe('copilot-session');
    });

    it('prefers canonical snake_case when both session ID forms are present', () => {
        expect(deriveSessionId({
            session_id: 'canonical-session',
            sessionId: 'copilot-session',
        })).toBe('canonical-session');
    });

    it('falls back to CLAUDE_SESSION_ID env var', () => {
        delete process.env.CLAUDE_SESSION_ID;
        process.env.CLAUDE_SESSION_ID = 'env-session';
        expect(deriveSessionId({})).toBe('env-session');
    });

    it('falls back to pid when nothing else is available', () => {
        delete process.env.CLAUDE_SESSION_ID;
        expect(deriveSessionId({})).toMatch(/^pid-/);
    });

    it('keeps a hook without a session_id on its pid fallback when it inherits another agent\'s variable', () => {
        // An OpenCode, Pi or OMP bridge started from a Claude Code shell sends no
        // session_id; its events must not be filed under the outer Claude session.
        delete process.env.CLAUDE_SESSION_ID;
        vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'outer-claude-session');
        const result = deriveSessionId({ cwd: '/tmp/project' }, { includeCwd: true });
        expect(result).toMatch(/^pid-\d+-\/tmp\/project$/);
    });

    it('ignores non-string session_id values', () => {
        delete process.env.CLAUDE_SESSION_ID;
        process.env.CLAUDE_SESSION_ID = 'env-session';
        expect(deriveSessionId({ session_id: 123 })).toBe('env-session');
    });

    it('includes cwd in pid fallback when includeCwd is true', () => {
        delete process.env.CLAUDE_SESSION_ID;
        const result = deriveSessionId({ cwd: '/tmp/project' }, { includeCwd: true });
        expect(result).toMatch(/^pid-\d+-\/tmp\/project$/);
    });

    it('uses process.cwd() when cwd is missing and includeCwd is true', () => {
        delete process.env.CLAUDE_SESSION_ID;
        const result = deriveSessionId({}, { includeCwd: true });
        expect(result).toContain(process.cwd());
    });

    it('uses workspace_roots in pid fallback when cwd is absent', () => {
        delete process.env.CLAUDE_SESSION_ID;
        const result = deriveSessionId(
            { workspace_roots: ['/Users/jeffxu/Project/teamai-cli'] },
            { includeCwd: true },
        );
        expect(result).toMatch(/^pid-\d+-\/Users\/jeffxu\/Project\/teamai-cli$/);
    });
});

// The test setup clears every AGENT_SESSION_ENV variable, so each case starts
// without the agent shell's own session.
describe('agentSessionIdFromEnv', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('reads the agent variables in this order', () => {
        expect(AGENT_SESSION_ENV).toEqual([
            'CLAUDE_CODE_SESSION_ID',
            'CODEX_SESSION_ID',
            'CODEBUDDY_SESSION_ID',
            'COPILOT_AGENT_SESSION_ID',
            'CURSOR_CONVERSATION_ID',
            'PI_SESSION_ID',
            'CLAUDE_SESSION_ID',
        ]);
    });

    it.each(AGENT_SESSION_ENV)('returns %s', (name) => {
        vi.stubEnv(name, 'env-session');
        expect(agentSessionIdFromEnv()).toBe('env-session');
    });

    it('prefers CODEBUDDY_SESSION_ID over the CLAUDE_SESSION_ID alias CodeBuddy also sets', () => {
        vi.stubEnv('CLAUDE_SESSION_ID', 'alias-session');
        vi.stubEnv('CODEBUDDY_SESSION_ID', 'codebuddy-session');
        expect(agentSessionIdFromEnv()).toBe('codebuddy-session');
    });

    it('skips an empty variable', () => {
        vi.stubEnv('CLAUDE_CODE_SESSION_ID', '');
        vi.stubEnv('CODEX_SESSION_ID', 'codex-session');
        expect(agentSessionIdFromEnv()).toBe('codex-session');
    });

    it('returns undefined when no agent variable is set', () => {
        expect(agentSessionIdFromEnv()).toBeUndefined();
    });
});
