import path from 'node:path';
import { encodeCwdClaude } from '@teamai/tool-core/sessions/fs';
import { describeFamily, fixtureText } from '@teamai/tool-testing/conformance';
import { family } from './index.js';

const fixture = (name: string): string => fixtureText(new URL(`./fixtures/${name}`, import.meta.url));

/** Qoder keeps a Claude Code-shaped session at `<store>/<cwd with every non-alphanumeric character as ->/<id>.jsonl`. */
const qoderTranscript = {
  text: fixture('qoder-transcript.jsonl'),
  place: (store: string, cwd: string, sessionId: string): string => path.join(store, encodeCwdClaude(cwd), `${sessionId}.jsonl`),
  userText: 'Which test runner does this repo use?',
};

describeFamily('tool-qoder', family, {
  // `qodercli -p` prints the reply alone, and nothing when the call fails.
  calls: { qoder: { answered: { stdout: fixture('qoder-print-answered.txt'), text: 'It uses Vitest.' }, failed: { stdout: fixture('qoder-print-failed.txt') } } },
  transcripts: { qoder: qoderTranscript, 'qoder-cn': qoderTranscript },
  tokens: {
    'claude-jsonl': { text: fixture('qoder-transcript.jsonl'), tokens: { input: 2500, output: 65, cacheRead: 17200, cacheCreation: 300 } },
  },
  versions: {},
});
