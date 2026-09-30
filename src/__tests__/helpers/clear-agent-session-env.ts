import { AGENT_SESSION_ENV } from '../../utils/session-id.js';

// Tests run inside an agent's shell (Claude Code sets CLAUDE_CODE_SESSION_ID),
// and recall, contribute and session save read that id through
// agentSessionIdFromEnv; a test that does not isolate HOME would also write
// that live session's state into the real ~/.teamai. Start every test file,
// and the CLIs it spawns, with none set (an OpenCode shell's
// TEAMAI_AGENT_SESSION_ID and a Pi shell's PI_SESSION_ID included).
for (const name of AGENT_SESSION_ENV) {
  delete process.env[name];
}

// The same shell may relocate an agent's root (CLAUDE_CONFIG_DIR, COPILOT_HOME,
// OPENCLAW_STATE_DIR), which teamai honors, so a test that stubs only HOME
// would still read, write or remove the developer's real Claude Code, Copilot
// or OpenClaw files. A test that needs one sets it.
for (const name of ['CLAUDE_CONFIG_DIR', 'COPILOT_HOME', 'OPENCLAW_STATE_DIR']) {
  delete process.env[name];
}
