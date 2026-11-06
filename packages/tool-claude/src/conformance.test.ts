import path from 'node:path';
import { encodeCwdClaude } from '@teamai/tool-core/sessions/fs';
import { describeFamily, fixtureText } from '@teamai/tool-testing/conformance';
import { family } from './index.js';

const fixture = (name: string): string => fixtureText(new URL(`./fixtures/${name}`, import.meta.url));

/** Claude Code keeps a session at `<store>/<cwd with every non-alphanumeric character as ->/<id>.jsonl`. */
const claudeTranscript = {
  text: fixture('claude-code-transcript.jsonl'),
  place: (store: string, cwd: string, sessionId: string): string => path.join(store, encodeCwdClaude(cwd), `${sessionId}.jsonl`),
  userText: 'Which test runner does this repo use?',
};

describeFamily('tool-claude', family, {
  calls: {
    claude: {
      answered: { stdout: fixture('claude-call-answered.json'), text: 'It uses Vitest.' },
      failed: {
        stdout: fixture('claude-call-failed.json'),
        message: "There's an issue with the selected model (claude-nonexistent). It may not exist or you may not have access to it. Run /model to pick a different model.",
      },
    },
  },
  transcripts: { 'claude-code': claudeTranscript, 'claude-internal': claudeTranscript, tclaude: claudeTranscript },
  tokens: {
    'claude-jsonl': { text: fixture('claude-code-transcript.jsonl'), tokens: { input: 2500, output: 65, cacheRead: 17200, cacheCreation: 300 } },
  },
  versions: { claude: { command: 'claude', stdout: '2.1.199 (Claude Code)', version: '2.1.199' } },
});
