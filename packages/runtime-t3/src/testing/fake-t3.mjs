// A fake T3 Code server for the runtime's tests: the MCP endpoint at /mcp with the tools teamai-runtime-t3 calls, and
// the OAuth endpoints a sign-in walks. It keeps its threads in files under FAKE_T3_STATE, so a restarted runtime finds
// them again, and an agent of its own plays each thread's run: it reads the result path from the prompt, writes the
// result there and a Claude or Codex transcript in HOME, as the real tool would.
//
//   FAKE_T3_STATE/config.json   written by the test: { token, environment, projects, providers, agent }
//                               agent: { output, fail, hold, release, waits, noSession }; read again on every call
//   FAKE_T3_STATE/calls.jsonl   each tool call as { tool, args, bearer }; bearer is "valid" or "invalid", never the token
//   FAKE_T3_STATE/threads/      one JSON file per thread
//   T3CODE_HOME/userdata/server-runtime.json   written once listening: { origin }, as T3 writes it
//   FAKE_T3_HOME                the member's home, where the agent's tool keeps its transcripts

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const STATE = process.env.FAKE_T3_STATE;
const T3_HOME = process.env.T3CODE_HOME;
const HOME = process.env.FAKE_T3_HOME;
const THREADS = path.join(STATE, 'threads');
const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'cancelled']);

fs.mkdirSync(THREADS, { recursive: true });

const config = () => JSON.parse(fs.readFileSync(path.join(STATE, 'config.json'), 'utf8'));
const threadFile = (id) => path.join(THREADS, `${encodeURIComponent(id)}.json`);
const readThread = (id) => (fs.existsSync(threadFile(id)) ? JSON.parse(fs.readFileSync(threadFile(id), 'utf8')) : undefined);

const writeThread = (thread) => {
  fs.writeFileSync(`${threadFile(thread.threadId)}.tmp`, JSON.stringify(thread));
  fs.renameSync(`${threadFile(thread.threadId)}.tmp`, threadFile(thread.threadId));
};

const update = (id, change) => {
  const thread = readThread(id);

  if (thread) writeThread({ ...thread, ...change(thread) });
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The agent of one run: it works, then writes the result file and its transcript, and the run completes. */
async function play(threadId) {
  const thread = readThread(threadId);
  const agent = config().agent ?? {};
  update(threadId, () => ({ status: 'running' }));

  while (agent.hold || agent.release) {
    const now = readThread(threadId);

    if (now.status !== 'running') return;

    if (agent.release && fs.existsSync(agent.release)) break;
    await sleep(25);
  }

  await sleep(20);

  if (readThread(threadId).status !== 'running') return;

  if (agent.waits) {
    // The agent asks for an approval nobody gives.
    update(threadId, () => ({ status: 'waiting' }));

    return;
  }

  if (agent.fail) {
    update(threadId, () => ({ status: 'failed' }));

    return;
  }

  const result = /Write the workflow result as JSON to (\S+?)\.(?:\s|$)/.exec(thread.message)?.[1];

  if (result && agent.output !== undefined) fs.writeFileSync(result, JSON.stringify({ output: agent.output }));

  if (!agent.noSession) writeTranscript(thread);
  update(threadId, (now) => ({ status: 'completed', runs: now.runs }));
}

/** The transcript the thread's tool keeps, in its own layout under HOME. */
function writeTranscript(thread) {
  const sessionId = createHash('sha256').update(thread.threadId).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5');
  const cwd = fs.realpathSync(thread.worktreePath);
  const at = new Date().toISOString();

  if (thread.provider === 'codex') {
    const day = at.slice(0, 10).split('-');
    const dir = path.join(HOME, '.codex', 'sessions', ...day);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `rollout-${at.replace(/[:.]/g, '-')}-${sessionId}.jsonl`), [
      JSON.stringify({ timestamp: at, type: 'session_meta', payload: { id: sessionId, timestamp: at, cwd, originator: 'codex_exec', cli_version: '0.50.0' } }),
      JSON.stringify({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: thread.message }] } }),
    ].join('\n') + '\n');

    return;
  }

  const dir = path.join(HOME, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'user', sessionId, cwd, timestamp: at, uuid: randomUUID(), message: { role: 'user', content: thread.message } }),
    JSON.stringify({ type: 'assistant', sessionId, cwd, timestamp: at, uuid: randomUUID(), message: { role: 'assistant', model: thread.model, content: [{ type: 'text', text: 'Done.' }] } }),
  ].join('\n') + '\n');
}

const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });
const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const link = (threadId) => `t3-thread://v2/${config().environment.environmentId}/${threadId}`;

const TOOLS = {
  t3_environment_read: () => ok(config().environment),
  orchestrator_capabilities: () => ok({ providers: config().providers }),
  t3_project_list: () => ok({ projects: config().projects, nextCursor: null }),
  t3_thread_launch: (args) => {
    const threadId = `mcp:launch:${createHash('sha256').update(args.clientRequestId ?? randomUUID()).digest('hex')}`;
    const existing = readThread(threadId);

    if (existing) return ok({ threadId, link: link(threadId), status: existing.status });
    const provider = config().providers.find((one) => one.providerInstanceId === args.modelSelection?.instanceId);

    if (!provider) return fail(`No provider instance ${args.modelSelection?.instanceId}.`);
    writeThread({
      threadId, title: args.title, message: args.message, worktreePath: args.workspaceStrategy?.worktreePath, projectId: args.projectId,
      provider: provider.driverKind, model: args.modelSelection?.model, runtimeMode: args.runtimeMode, status: 'starting', settled: false,
    });
    void play(threadId);

    return ok({ threadId, link: link(threadId), status: 'starting' });
  },
  t3_thread_wait: async (args) => {
    const deadline = Date.now() + (args.timeoutMs ?? 30_000);
    let thread = readThread(args.threadId);

    if (!thread) return fail(`No thread ${args.threadId}.`);

    while (!TERMINAL.has(thread.status) && Date.now() < deadline) {
      await sleep(20);
      thread = readThread(args.threadId);
    }

    const runId = `run:${args.threadId}:1`;
    const settled = TERMINAL.has(thread.status);

    return ok({ threadId: args.threadId, runId, status: thread.status, timedOut: !settled, ...(settled && { resultRun: { runId, status: thread.status } }) });
  },
  t3_thread_interrupt: (args) => {
    const thread = readThread(args.threadId);

    if (!thread) return fail(`No thread ${args.threadId}.`);

    if (TERMINAL.has(thread.status)) return ok({ threadId: args.threadId, runId: null, status: 'no_active_run' });
    update(args.threadId, () => ({ status: 'interrupted' }));

    return ok({ threadId: args.threadId, runId: `run:${args.threadId}:1`, status: 'interrupt_requested' });
  },
  t3_thread_organize: (args) => {
    if (!readThread(args.threadId)) return fail(`No thread ${args.threadId}.`);
    update(args.threadId, () => ({ settled: args.action === 'settle' }));

    return ok({ threadId: args.threadId, action: args.action });
  },
};

const record = (tool, args, bearer) => fs.appendFileSync(path.join(STATE, 'calls.jsonl'), `${JSON.stringify({ tool, args, bearer })}\n`);

function mcpServer(bearer) {
  const server = new Server({ name: 'fake-t3', version: '0.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: Object.keys(TOOLS).map((name) => ({ name, inputSchema: { type: 'object' } })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    record(request.params.name, args, bearer);
    const tool = TOOLS[request.params.name];

    return tool ? tool(args) : fail(`Unknown tool ${request.params.name}.`);
  });

  return server;
}

const codes = new Map();

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const readBody = async (req) => {
  let text = '';

  for await (const chunk of req) text += chunk;

  return text;
};

async function route(req, res) {
  const origin = `http://127.0.0.1:${httpServer.address().port}`;
  const url = new URL(req.url, origin);

  if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
    return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['orchestration:read', 'orchestration:operate'], bearer_methods_supported: ['header'] });
  }

  if (url.pathname === '/.well-known/oauth-authorization-server') {
    return json(res, 200, {
      issuer: origin, authorization_endpoint: `${origin}/oauth/mcp/authorize`, token_endpoint: `${origin}/oauth/mcp/token`, registration_endpoint: `${origin}/oauth/mcp/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
    });
  }

  if (url.pathname === '/oauth/mcp/register') {
    const metadata = JSON.parse(await readBody(req));

    return json(res, 201, { ...metadata, client_id: `client-${randomUUID()}` });
  }

  if (url.pathname === '/oauth/mcp/authorize') {
    // The person approves at once.
    const code = randomUUID();
    codes.set(code, { challenge: url.searchParams.get('code_challenge'), redirect: url.searchParams.get('redirect_uri') });
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);

    if (url.searchParams.get('state')) back.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { location: back.toString() });

    return res.end();
  }

  if (url.pathname === '/oauth/mcp/token') {
    const form = new URLSearchParams(await readBody(req));
    const pending = codes.get(form.get('code'));
    const verified = pending && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === pending.challenge;

    if (!verified) return json(res, 400, { error: 'invalid_grant' });
    codes.delete(form.get('code'));
    fs.appendFileSync(path.join(STATE, 'calls.jsonl'), `${JSON.stringify({ tool: 'oauth_token', args: {}, bearer: 'none' })}\n`);

    return json(res, 200, { access_token: config().token, token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read orchestration:operate' });
  }

  if (url.pathname === '/mcp') {
    const presented = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];

    if (presented !== config().token) {
      return json(res, 401, { error: 'invalid_mcp_credential', message: 'A valid T3 Code MCP credential is required.' }, {
        'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"${presented ? ', error="invalid_token"' : ''}`,
      });
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = mcpServer('valid');
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);

    return transport.handleRequest(req, res, req.method === 'POST' ? JSON.parse(await readBody(req)) : undefined);
  }

  json(res, 404, { error: 'not_found' });
}

const httpServer = http.createServer((req, res) => {
  route(req, res).catch((error) => json(res, 500, { error: String(error) }));
});

httpServer.listen(0, '127.0.0.1', () => {
  const dir = path.join(T3_HOME, 'userdata');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server-runtime.json'), JSON.stringify({ version: 1, pid: process.pid, origin: `http://127.0.0.1:${httpServer.address().port}` }));
});

process.on('SIGTERM', () => { httpServer.close(); process.exit(0); });

// A test that removes its state is done with this server.
setInterval(() => { if (!fs.existsSync(STATE)) process.exit(0); }, 500);
