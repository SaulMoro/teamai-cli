import fs from 'node:fs';

const recorded = (name: string): string => fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8').trim();

/**
 * How a fake `codex` answers, for `fakeAgent` of @teamai/tool-testing: the events `codex exec --json` printed for real
 * (codex-cli 0.167.0, a workflow step), with the reply in its agent message and a fresh thread id, or the same one for
 * `exec resume <id>`. The reply also goes to the `-o` file, as Codex writes its last message there. Unless the call
 * passes `--ephemeral`, the session goes where Codex keeps it: `$CODEX_HOME/sessions/YYYY/MM/DD/` (`~/.codex` without
 * the variable), named after the local time it started, and a resumed thread appends to its own.
 */
export const codexFake = {
  executable: 'codex',
  version: 'codex-cli 0.167.0',
  data: {
    answered: recorded('codex-exec-step-answered.jsonl'),
    failed: recorded('codex-exec-failed.jsonl'),
    rollout: recorded('codex-step-rollout.jsonl'),
  },
  script: String.raw`
  const at = args.indexOf('resume');
  const resumed = at !== -1 && args[at + 1] !== undefined && !args[at + 1].startsWith('-') ? args[at + 1] : undefined;
  const threadId = resumed ?? randomUUID();
  const events = (does('fail') ? data.failed : data.answered).split('\n').map((line) => JSON.parse(line));
  let lastMessage;
  for (const [index, event] of events.entries()) {
    if (event.type === 'thread.started') event.thread_id = threadId;
    if (event.type === 'item.completed' && event.item.type === 'agent_message') {
      if (reply !== undefined) event.item.text = reply;
      lastMessage = event.item.text;
    }
    await say(JSON.stringify(event));
    if (index === 0 && does('hang')) return hang();
  }
  const out = args.indexOf('-o');
  if (out !== -1 && lastMessage !== undefined) fs.writeFileSync(args[out + 1], lastMessage);
  if (!args.includes('--ephemeral')) {
    const sessions = path.join(process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex'), 'sessions');
    const fill = (text) => text.replaceAll('{{cwd}}', fs.realpathSync(process.cwd())).replaceAll('{{sessionId}}', threadId);
    const own = resumed === undefined || !fs.existsSync(sessions) ? undefined : fs.readdirSync(sessions, { recursive: true, encoding: 'utf8' }).find((name) => name.endsWith('-' + resumed + '.jsonl'));
    if (own !== undefined) {
      fs.appendFileSync(path.join(sessions, own), fill(data.rollout.split('\n').slice(1).join('\n')) + '\n');
    } else {
      const now = new Date();
      const two = (n) => String(n).padStart(2, '0');
      const day = [String(now.getFullYear()), two(now.getMonth() + 1), two(now.getDate())];
      const dir = path.join(sessions, ...day);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'rollout-' + day.join('-') + 'T' + [now.getHours(), now.getMinutes(), now.getSeconds()].map(two).join('-') + '-' + threadId + '.jsonl'), fill(data.rollout) + '\n');
    }
  }
  process.exit(does('fail') ? 1 : 0);
`,
};

export * from './fake-codex.js';
