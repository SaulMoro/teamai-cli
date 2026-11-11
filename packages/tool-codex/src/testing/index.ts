import fs from 'node:fs';

const recorded = (name: string): string => fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8').trim();

/**
 * How a fake `codex` answers, for `fakeAgent` of @teamai/tool-testing: the events `codex exec --json` printed for real
 * (codex-cli 0.167.0, a workflow step that answered and one whose model failed), with the reply in its agent message and
 * a fresh thread id, or the same one for `exec resume <id>`. An answer also goes to the `-o` file, as Codex writes its
 * last message there. The step that answered wrote its result file with a command: the fake writes that result to
 * `TEAMAI_WORKFLOW_RESULT` when Codex's sandbox would let it, in the cwd, `/tmp`, `TMPDIR` or a directory `--add-dir`
 * names, as the recorded turn shows; elsewhere it writes nothing, as 0.167.0 did. Unless the call passes `--ephemeral`, the session goes where Codex keeps it:
 * `$CODEX_HOME/sessions/YYYY/MM/DD/` (`~/.codex` without the variable), named after the local time it started, and a
 * resumed thread appends to its own. It refuses what 0.167.0 refused, with its words: a cwd outside a git repository
 * without `--skip-git-repo-check`, and a thread to resume that has no session there. Anything but `exec --json` is not
 * recorded, so it exits 2 naming its arguments.
 */
export const codexFake = {
  executable: 'codex',
  version: 'codex-cli 0.167.0',
  data: {
    answered: recorded('codex-exec-step-answered.jsonl'),
    failed: recorded('codex-exec-step-failed.jsonl'),
    rollout: recorded('codex-step-rollout.jsonl'),
    result: recorded('codex-step-result.json'),
    failedRollout: recorded('codex-step-failed-rollout.jsonl'),
  },
  script: String.raw`
  const refuse = (message) => { process.stderr.write(message + '\n'); process.exit(1); };
  if (!args.includes('exec') || !args.includes('--json')) {
    process.stderr.write('The fake codex answers only codex exec --json, as recorded; it was given: ' + args.join(' ') + '\n');
    process.exit(2);
  }
  const inRepository = (dir) => fs.existsSync(path.join(dir, '.git')) || (path.dirname(dir) !== dir && inRepository(path.dirname(dir)));
  if (!args.includes('--skip-git-repo-check') && !inRepository(fs.realpathSync(process.cwd()))) refuse('Not inside a trusted directory and --skip-git-repo-check was not specified.');
  const at = args.indexOf('resume');
  const resumed = at !== -1 && args[at + 1] !== undefined && !args[at + 1].startsWith('-') ? args[at + 1] : undefined;
  const sessions = path.join(process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex'), 'sessions');
  const own = resumed === undefined || !fs.existsSync(sessions) ? undefined : fs.readdirSync(sessions, { recursive: true, encoding: 'utf8' }).find((name) => name.endsWith('-' + resumed + '.jsonl'));
  if (resumed !== undefined && own === undefined) refuse('Error: thread/resume: thread/resume failed: no rollout found for thread id ' + resumed + ' (code -32600)');
  const threadId = resumed ?? randomUUID();
  const failed = does('fail');
  const cwd = fs.realpathSync(process.cwd());
  const result = process.env.TEAMAI_WORKFLOW_RESULT;
  // The recordings are JSON lines: a path goes in as a JSON string's content.
  const inJson = (text) => JSON.stringify(text).slice(1, -1);
  const fill = (text) => text.replaceAll('{{cwd}}', inJson(cwd)).replaceAll('{{sessionId}}', threadId)
    .replaceAll('{{resultDir}}', inJson(result === undefined ? '' : path.dirname(result))).replaceAll('{{result}}', inJson(result ?? ''));
  const real = (file) => fs.existsSync(file) ? fs.realpathSync(file) : path.join(real(path.dirname(file)), path.basename(file));
  const writable = [cwd, '/tmp', process.env.TMPDIR, ...args.flatMap((arg, index) => args[index - 1] === '--add-dir' ? [arg] : [])]
    .filter((root) => root !== undefined && root !== '').map(real);
  const isInside = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep); };
  const mayWrite = (file) => args.includes('--dangerously-bypass-approvals-and-sandbox') || writable.some((root) => isInside(root, real(file)));
  const events = fill(failed ? data.failed : data.answered).split('\n').map((line) => JSON.parse(line));
  let lastMessage;
  for (const [index, event] of events.entries()) {
    if (event.type === 'thread.started') event.thread_id = threadId;
    if (event.type === 'item.completed' && event.item.type === 'agent_message') {
      if (reply !== undefined) event.item.text = reply;
      lastMessage = event.item.text;
    }
    // The recorded command that wrote the result file.
    if (event.type === 'item.completed' && event.item.type === 'command_execution' && result !== undefined && event.item.command.includes(result) && mayWrite(result)) {
      fs.mkdirSync(path.dirname(result), { recursive: true });
      fs.writeFileSync(result, data.result + '\n');
    }
    await say(JSON.stringify(event));
    if (index === 0 && does('hang')) return hang();
  }
  const out = args.indexOf('-o');
  if (out !== -1 && lastMessage !== undefined) fs.writeFileSync(args[out + 1], lastMessage);
  if (!args.includes('--ephemeral')) {
    const rollout = failed ? data.failedRollout : data.rollout;
    if (own !== undefined) {
      fs.appendFileSync(path.join(sessions, own), fill(rollout.split('\n').slice(1).join('\n')) + '\n');
    } else {
      const now = new Date();
      const two = (n) => String(n).padStart(2, '0');
      const day = [String(now.getFullYear()), two(now.getMonth() + 1), two(now.getDate())];
      const dir = path.join(sessions, ...day);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'rollout-' + day.join('-') + 'T' + [now.getHours(), now.getMinutes(), now.getSeconds()].map(two).join('-') + '-' + threadId + '.jsonl'), fill(rollout) + '\n');
    }
  }
  process.exit(failed ? 1 : 0);
`,
};

export * from './fake-codex.js';
