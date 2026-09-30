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
