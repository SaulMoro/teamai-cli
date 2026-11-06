import { describeFamily, fixtureText } from '@teamai/tool-testing/conformance';
import { family } from './index.js';

const fixture = (name: string): string => fixtureText(new URL(`./fixtures/${name}`, import.meta.url));

describeFamily('tool-copilot', family, {
  // `copilot -p <prompt> -s` prints the reply alone, and nothing when the call fails.
  calls: { copilot: { answered: { stdout: fixture('copilot-answered.txt'), text: 'It uses Vitest.' }, failed: { stdout: fixture('copilot-failed.txt') } } },
  transcripts: {},
  tokens: {},
  versions: {},
});
