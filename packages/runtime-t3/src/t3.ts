import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { z } from 'zod';

// ─── A T3 Code environment, over its MCP endpoint ───
//
//  The tools this runtime calls, each read back through a schema of the fields it uses. T3 answers a tool call with
//  its result as JSON text (and as structured content on newer servers); a tool error carries T3's own message.
//

export const EnvironmentSchema = z.object({ environmentId: z.string().min(1), label: z.string(), serverVersion: z.string().optional() });

export type Environment = z.infer<typeof EnvironmentSchema>;

const ModelSchema = z.object({ id: z.string().min(1), options: z.array(z.object({ id: z.string(), values: z.array(z.unknown()) })).optional() });

const ProviderSchema = z.object({
  providerInstanceId: z.string().min(1),
  driverKind: z.string().min(1),
  displayName: z.string(),
  models: z.array(ModelSchema),
  /** Why T3 cannot run this instance now, such as "Provider instance is disabled."; empty when it can. */
  constraints: z.array(z.string()).optional(),
});

export type Provider = z.infer<typeof ProviderSchema>;

/** A project as `t3_project_list` lists it; one T3 deleted keeps its row with `deletedAt` set. */
const ProjectSchema = z.object({ id: z.string().min(1), title: z.string(), workspaceRoot: z.string(), deletedAt: z.string().nullable().optional() });

export type Project = z.infer<typeof ProjectSchema>;

const ProjectPageSchema = z.object({ projects: z.array(ProjectSchema), nextCursor: z.number().int().nullable().optional() });

/** A thread's run as T3 reports it; `idle` when the thread has none. */
export const THREAD_STATUSES = ['idle', 'preparing', 'queued', 'starting', 'running', 'waiting', 'completed', 'interrupted', 'failed', 'cancelled', 'rolled_back'] as const;

const LaunchedSchema = z.object({ threadId: z.string().min(1), link: z.string().optional() });

const WaitedSchema = z.object({ threadId: z.string(), status: z.enum(THREAD_STATUSES), timedOut: z.boolean() });

export type Waited = z.infer<typeof WaitedSchema>;

/**
 * The T3 modes a step thread may run in, loosest first. `auto` is T3's Auto mode: the provider's own review approves
 * routine actions and asks the person about the rest (a provider without such a review asks about everything).
 * `approval-required` is Supervised: every command and edit waits for the person.
 */
export const STEP_MODES = ['auto', 'auto-accept-edits', 'approval-required'] as const;

export type StepMode = (typeof STEP_MODES)[number];

export interface Launch {
  title: string;
  message: string;
  projectId: string;
  worktreePath: string;
  modelSelection: { instanceId: string; model: string; options?: Array<{ id: string; value: string }> };
  /** Never inherited: set from the runtime's options, whatever the caller's mode or the member's grant would let T3 use. */
  runtimeMode: StepMode;
  /** T3 answers a repeated id with the thread it launched for it, and starts no second run. */
  clientRequestId: string;
}

/** A tool call T3 refused or could not answer, with T3's own message. */
export class T3Error extends Error {
  readonly tool: string;

  constructor(tool: string, message: string) {
    super(message);
    this.tool = tool;
  }
}

export interface T3 {
  environment(): Promise<Environment>;
  providers(): Promise<Provider[]>;
  projects(): Promise<Project[]>;
  launch(launch: Launch): Promise<z.infer<typeof LaunchedSchema>>;
  /** Waits up to `timeoutMs` for the thread's latest run, and the work it delegated, to settle. */
  wait(threadId: string, timeoutMs: number): Promise<Waited>;
  /** How many requests the thread's run holds for a person: tool approvals and questions. */
  pendingRequests(threadId: string): Promise<number>;
  /** Stops the thread as its Stop button does: its running turn and every task it delegated. */
  stop(threadId: string): Promise<void>;
  settle(threadId: string): Promise<void>;
  close(): Promise<void>;
}

/** What a tool call sends: JSON, as MCP carries it. */
type ToolArguments = Record<string, z.core.util.JSONType>;

const TextContentSchema = z.object({ type: z.literal('text'), text: z.string() });

const ToolResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z.array(z.unknown()).optional(),
});

/** The client of a connected endpoint. A request a wait holds open needs more than the SDK's 60 s default. */
function t3Over(client: Client): T3 {
  const call = async <TSchema extends z.ZodType>(tool: string, args: ToolArguments, schema: TSchema, timeout = 60_000): Promise<z.infer<TSchema>> => {
    const result = ToolResultSchema.parse(await client.callTool({ name: tool, arguments: args }, undefined, { timeout }));

    const texts = (result.content ?? []).flatMap((part) => {
      const text = TextContentSchema.safeParse(part);

      return text.success ? [text.data.text] : [];
    });

    if (result.isError) throw new T3Error(tool, texts.join(' ') || `T3 refused ${tool}.`);
    const body: unknown = result.structuredContent ?? JSON.parse(texts.join(''));
    const parsed = schema.safeParse(body);

    if (!parsed.success) throw new T3Error(tool, `T3 answered ${tool} in a shape this runtime does not read: ${z.prettifyError(parsed.error)}`);

    return parsed.data;
  };

  return {
    environment: () => call('t3_environment_read', {}, EnvironmentSchema),
    providers: async () => (await call('orchestrator_capabilities', {}, z.object({ providers: z.array(ProviderSchema) }))).providers,
    projects: async () => {
      const projects: Project[] = [];
      let cursor: number | null | undefined = 0;

      while (cursor !== null && cursor !== undefined) {
        const page: z.infer<typeof ProjectPageSchema> = await call('t3_project_list', { cursor, limit: 100 }, ProjectPageSchema);
        projects.push(...page.projects);
        cursor = page.nextCursor;
      }

      return projects;
    },
    launch: (launch) => call('t3_thread_launch', {
      title: launch.title,
      message: launch.message,
      projectId: launch.projectId,
      workspaceStrategy: { type: 'existing_worktree', worktreePath: launch.worktreePath },
      modelSelection: launch.modelSelection,
      runtimeMode: launch.runtimeMode,
      interactionMode: 'default',
      clientRequestId: launch.clientRequestId,
    }, LaunchedSchema),
    wait: (threadId, timeoutMs) => call('t3_thread_wait', { threadId, timeoutMs, untilDelegatedWorkSettled: true }, WaitedSchema, timeoutMs + 30_000),
    pendingRequests: async (threadId) => (await call('t3_thread_read', { threadId, limit: 1, view: 'messages' }, z.object({ thread: z.object({ pendingRequestCount: z.number().int().nonnegative() }) }))).thread.pendingRequestCount,
    stop: async (threadId) => { await call('t3_thread_interrupt', { threadId, stop: true, reason: 'teamai cancelled the workflow step' }, z.object({ threadId: z.string() })); },
    settle: async (threadId) => { await call('t3_thread_organize', { threadId, action: 'settle' }, z.object({}).loose()); },
    close: () => client.close(),
  };
}

/** Connects to the MCP endpoint at `resource`, signing in through `auth` when T3 asks for a credential. */
export async function connectT3(resource: URL, auth: OAuthClientProvider, authorize: () => Promise<string>): Promise<T3> {
  const client = new Client({ name: 'teamai-runtime-t3', version: '1' });
  const transport = new StreamableHTTPClientTransport(resource, { authProvider: auth });

  try {
    await client.connect(transport);
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    // The SDK sent the person to T3's sign-in page; the code comes back on the loopback redirect.
    await transport.finishAuth(await authorize());
    const signedIn = new Client({ name: 'teamai-runtime-t3', version: '1' });
    await signedIn.connect(new StreamableHTTPClientTransport(resource, { authProvider: auth }));

    return t3Over(signedIn);
  }

  return t3Over(client);
}
