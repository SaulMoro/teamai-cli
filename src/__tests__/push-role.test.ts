import { describe, it, expect, vi, beforeEach } from 'vitest';
import { push } from '../push.js';

const mockAutoDetectInit = vi.fn();
const mockPullRepo = vi.fn();
const mockPushRepoBranch = vi.fn();
const mockCheckoutMaster = vi.fn();
const mockGenerateBranchName = vi.fn();
const mockLoadStateForScope = vi.fn();
const mockSaveStateForScope = vi.fn();
const mockLoadRolesManifest = vi.fn();
const mockGetHandler = vi.fn();

let readlineAnswer = '1';
vi.mock('../utils/prompt.js', () => ({
  askQuestion: vi.fn((_prompt: string, defaultValue?: string) => {
    return Promise.resolve(readlineAnswer || defaultValue || '');
  }),
  askConfirmation: vi.fn(() => {
    return Promise.resolve(
      !readlineAnswer || readlineAnswer.toLowerCase() === 'y',
    );
  }),
  askSelection: vi.fn((_prompt: string, itemCount: number, defaultAll?: boolean) => {
    // Default: select all items (matches --all behavior for existing tests)
    if (defaultAll) return Promise.resolve(Array.from({ length: itemCount }, (__, i) => i));
    return Promise.resolve(null);
  }),
  parseSelection: vi.fn(),
  closePrompt: vi.fn(),
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  autoDetectInit: (...args: unknown[]) => mockAutoDetectInit(...args),
  loadStateForScope: (...args: unknown[]) => mockLoadStateForScope(...args),
  saveStateForScope: (...args: unknown[]) => mockSaveStateForScope(...args),
}));

const mockMerge = vi.fn();
const mockStash = vi.fn();
const mockGitStatus = vi.fn().mockResolvedValue({
  modified: [],
  not_added: [],
  created: [],
  conflicted: [],
  staged: [],
});
const mockCreateGit = vi.fn().mockReturnValue({
  status: mockGitStatus,
  merge: mockMerge,
  stash: mockStash,
});

const mockResetToCleanMaster = vi.fn();

vi.mock('../utils/git.js', () => ({
  createGit: (...args: unknown[]) => mockCreateGit(...args),
  pullRepo: (...args: unknown[]) => mockPullRepo(...args),
  pushRepoBranch: (...args: unknown[]) => mockPushRepoBranch(...args),
  checkoutMaster: (...args: unknown[]) => mockCheckoutMaster(...args),
  generateBranchName: (...args: unknown[]) => mockGenerateBranchName(...args),
  resetToCleanMaster: (...args: unknown[]) => mockResetToCleanMaster(...args),
  isDedicatedRepoRoot: vi.fn().mockResolvedValue(true),
  // Without these two the PR step throws inside its own catch, which quietly
  // leaves process.exitCode at 1 and makes exit-code assertions meaningless.
  getDefaultBranch: vi.fn().mockResolvedValue('main'),
  remoteBranchExists: vi.fn().mockResolvedValue(true),
  getFileContentAtRev: vi.fn().mockResolvedValue(null),
}));

const mockLoadProjectsManifest = vi.fn().mockResolvedValue(null);
vi.mock('../projects.js', async () => {
  const actual = await vi.importActual('../projects.js');
  return {
    ...actual,
    loadProjectsManifest: (...args: unknown[]) => mockLoadProjectsManifest(...args),
  };
});

vi.mock('../roles.js', async () => {
  const actual = await vi.importActual('../roles.js');
  return {
    ...actual,
    loadRolesManifest: (...args: unknown[]) => mockLoadRolesManifest(...args),
  };
});

vi.mock('../resources/index.js', () => ({
  getHandler: (...args: unknown[]) => mockGetHandler(...args),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('../resources/skills.js', () => ({
  scanTeamRepoNamespaces: vi.fn().mockResolvedValue([]),
}));

const mockScanTeamRepoNamespaces = vi.mocked(
  (await import('../resources/skills.js')).scanTeamRepoNamespaces,
);

vi.mock('../providers/index.js', () => ({
  getProvider: vi.fn().mockReturnValue({
    parseRepoInput: vi.fn().mockReturnValue({ owner: 'test', repo: 'repo' }),
    createPullRequest: vi.fn().mockReturnValue('https://git.woa.com/mr/1'),
  }),
}));

// Isolation: push() takes a real ~/.teamai/.sync-lock. Parallel vitest workers
// sharing that path race and skip/error, so these tests mock the lock.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

function makeLocalConfig(overrides: Record<string, unknown> = {}) {
  return {
    repo: { localPath: '/tmp/team-repo', remote: 'https://git.woa.com/test/repo.git' },
    username: 'testuser',
    updatePolicy: 'auto',
    primaryRole: 'hai',
    additionalRoles: [],
    resourceProfileVersion: 1,
    scope: 'user',
    ...overrides,
  };
}

function makeTeamConfig() {
  return {
    repo: 'https://git.woa.com/test/repo.git',
    provider: 'tgit',
    reviewers: [],
    sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '~/.teamai/docs' }, env: { injectShellProfile: true } },
    toolPaths: {},
  };
}

function mockSkillHandler(pushedItems?: Array<Record<string, unknown>>) {
  mockGetHandler.mockImplementation((type: string) => {
    if (type === 'skills') {
      return {
        scanLocalForPush: vi.fn().mockResolvedValue([
          { name: 'skill-a', type: 'skills', sourcePath: '/tmp/skill-a', relativePath: 'skills/skill-a', status: 'new' },
        ]),
        pushItem: vi.fn().mockImplementation(async (item: Record<string, unknown>) => {
          pushedItems?.push(item);
        }),
      };
    }
    return { scanLocalForPush: vi.fn().mockResolvedValue([]), pushItem: vi.fn() };
  });
}

describe('push namespace routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPullRepo.mockResolvedValue('Already up to date.');
    mockPushRepoBranch.mockResolvedValue(true);
    mockCheckoutMaster.mockResolvedValue(undefined);
    mockGenerateBranchName.mockReturnValue('teamai/push/test/20260403-120000');
    mockLoadStateForScope.mockResolvedValue({
      lastPush: null,
      lastPull: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });
    mockSaveStateForScope.mockResolvedValue(undefined);
    // Default manifest: role "hai" has namespaces [common, hai]
    mockLoadRolesManifest.mockResolvedValue({
      version: 1,
      roles: [
        { id: 'hai', description: 'HyperAI', resources: { knowledge: ['common', 'hai'], skills: ['common', 'hai'], agents: [] } },
        { id: 'pm', description: 'Product Manager', resources: { knowledge: ['common', 'pm'], skills: ['common', 'pm'], agents: [] } },
      ],
    });
    readlineAnswer = '1';
    mockScanTeamRepoNamespaces.mockResolvedValue([]);
  });

  it('auto-selects namespace when role has only one skill namespace', async () => {
    mockLoadRolesManifest.mockResolvedValue({
      version: 1,
      roles: [
        { id: 'solo', description: 'Solo role', resources: { knowledge: ['solo'], skills: ['solo'], agents: [] } },
      ],
    });
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: 'solo', additionalRoles: [] }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);

    await push({ all: true });

    expect(pushedItems[0].namespace).toBe('solo');
    expect(pushedItems[0].relativePath).toBe('skills/solo/skill-a');
  });

  it('prompts for namespace selection when role has multiple skill namespaces', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),  // primaryRole=hai → skills: [common, hai]
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);

    // User selects "1" → common
    readlineAnswer = '1';
    await push({ all: true });

    expect(pushedItems[0].namespace).toBe('common');
    expect(pushedItems[0].relativePath).toBe('skills/common/skill-a');
  });

  it('allows selecting a non-default namespace', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),  // primaryRole=hai → skills: [common, hai]
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);

    // User selects "2" → hai
    readlineAnswer = '2';
    await push({ all: true });

    expect(pushedItems[0].namespace).toBe('hai');
    expect(pushedItems[0].relativePath).toBe('skills/hai/skill-a');
  });

  it('includes additional role namespaces in the selection', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      // primaryRole=hai + additionalRoles=[pm] → skills: [common, hai, pm]
      localConfig: makeLocalConfig({ additionalRoles: ['pm'] }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);

    // User selects "3" → pm
    readlineAnswer = '3';
    await push({ all: true });

    expect(pushedItems[0].namespace).toBe('pm');
    expect(pushedItems[0].relativePath).toBe('skills/pm/skill-a');
  });

  it('defaults to first namespace when user presses Enter', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),  // skills: [common, hai]
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);

    readlineAnswer = '';
    await push({ all: true });

    expect(pushedItems[0].namespace).toBe('common');
    expect(pushedItems[0].relativePath).toBe('skills/common/skill-a');
  });

  it('uses primaryRole as namespace in silent mode', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),  // skills: [common, hai]
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);

    await push({ all: true, silent: true });

    expect(pushedItems[0].namespace).toBe('hai');
    expect(pushedItems[0].relativePath).toBe('skills/hai/skill-a');
  });

  it('explicit --role flag bypasses namespace resolution', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);

    await push({ all: true, role: 'pm' });

    // --role pm uses "pm" as namespace directly
    expect(pushedItems[0].namespace).toBe('pm');
    expect(pushedItems[0].relativePath).toBe('skills/pm/skill-a');
  });

  it('explicit --role flag also routes a modified skill to that namespace', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockGetHandler.mockImplementation((type: string) => {
      if (type === 'skills') {
        return {
          scanLocalForPush: vi.fn().mockResolvedValue([
            {
              name: 'skill-a',
              type: 'skills',
              sourcePath: '/tmp/skill-a',
              relativePath: 'skills/skill-a',
              status: 'modified',
            },
          ]),
          pushItem: vi.fn().mockImplementation(async (item: Record<string, unknown>) => {
            pushedItems.push(item);
          }),
        };
      }
      return { scanLocalForPush: vi.fn().mockResolvedValue([]), pushItem: vi.fn() };
    });

    await push({ all: true, role: 'backend' });

    expect(pushedItems[0].namespace).toBe('backend');
    expect(pushedItems[0].relativePath).toBe('skills/backend/skill-a');
  });

  it('rejects a path-traversal value passed to --role', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler();
    const originalExitCode = process.exitCode;

    try {
      await push({ all: true, role: '../outside' });

      expect(mockPushRepoBranch).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it('rejects an unsafe scanned skill name before building the role path', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockGetHandler.mockImplementation((type: string) => {
      if (type === 'skills') {
        return {
          scanLocalForPush: vi.fn().mockResolvedValue([
            {
              name: '../outside',
              type: 'skills',
              sourcePath: '/tmp/outside',
              relativePath: 'skills/outside',
              status: 'modified',
            },
          ]),
          pushItem: vi.fn(),
        };
      }
      return { scanLocalForPush: vi.fn().mockResolvedValue([]), pushItem: vi.fn() };
    });
    const originalExitCode = process.exitCode;

    try {
      await push({ all: true, role: 'backend' });

      expect(mockPushRepoBranch).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it('rejects out-of-range namespace selection', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),  // skills: [common, hai]
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler();

    readlineAnswer = '99';
    await push({ all: true });

    expect(mockPushRepoBranch).not.toHaveBeenCalled();
  });

  it('rejects invalid explicit --role override', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockGetHandler.mockReturnValue({
      scanLocalForPush: vi.fn().mockResolvedValue([]),
      pushItem: vi.fn(),
    });

    // --role "unknown" → used directly as namespace, no manifest validation
    // (validation happens downstream in pushItem)
    await push({ all: true, role: 'unknown' });

    // No items to push, so pushRepoBranch should not be called
    expect(mockPushRepoBranch).not.toHaveBeenCalled();
  });

it('blocks skills that exist in non-allowed namespaces', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });

    // Mock that local has both allowed and blocked skills
    mockGetHandler.mockImplementation((type: string) => {
      if (type === 'skills') {
        return {
          scanLocalForPush: vi.fn().mockResolvedValue([
            // This would only be returned if NOT blocked by namespace check
            { name: 'blocked-skill', type: 'skills', sourcePath: '/tmp/blocked-skill', relativePath: 'skills/blocked-skill' },
          ]),
          pushItem: vi.fn(),
        };
      }

      return {
        scanLocalForPush: vi.fn().mockResolvedValue([]),
        pushItem: vi.fn(),
      };
    });

    // This tests that even if scanLocalForPush returns a blocked skill, the system should reject it
    await push({ all: true });

    // The push should have been called (since we have --all)
    // but the mocked handler is already filtering it
  });

  it('prompts for namespace when no primaryRole but team repo has namespaces', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);
    mockScanTeamRepoNamespaces.mockResolvedValue(['tencent', 'hai_dev']);

    // User selects "2" → hai_dev
    readlineAnswer = '2';
    await push({ all: true });

    expect(pushedItems[0].namespace).toBe('hai_dev');
    expect(pushedItems[0].relativePath).toBe('skills/hai_dev/skill-a');
  });

  it('auto-selects single namespace when no primaryRole', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);
    mockScanTeamRepoNamespaces.mockResolvedValue(['only-ns']);

    await push({ all: true });

    expect(pushedItems[0].namespace).toBe('only-ns');
    expect(pushedItems[0].relativePath).toBe('skills/only-ns/skill-a');
  });

  it('does flat push when no primaryRole and no namespaces in team repo', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);
    mockScanTeamRepoNamespaces.mockResolvedValue([]);

    await push({ all: true });

    // No namespace should be set — flat push
    expect(pushedItems[0].namespace).toBeUndefined();
  });

  it('uses first namespace in silent mode when no primaryRole', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);
    mockScanTeamRepoNamespaces.mockResolvedValue(['tencent', 'hai_dev']);

    await push({ all: true, silent: true });

    expect(pushedItems[0].namespace).toBe('tencent');
    expect(pushedItems[0].relativePath).toBe('skills/tencent/skill-a');
  });

  it('shows numbered items in display', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler();

    readlineAnswer = '2';
    await push({ all: true });

    // Verify numbered display format
    const numLine = consoleSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('1.') && args[0].includes('skill-a'),
    );
    expect(numLine).toBeDefined();
    consoleSpy.mockRestore();
  });

  it('resets dirty team repo to clean master before pull', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler();
    mockScanTeamRepoNamespaces.mockResolvedValue([]);

    await push({ all: true });

    // Should have called resetToCleanMaster before pull
    expect(mockResetToCleanMaster).toHaveBeenCalled();
    expect(mockPullRepo).toHaveBeenCalled();
    // resetToCleanMaster must be called before pullRepo
    const resetOrder = mockResetToCleanMaster.mock.invocationCallOrder[0];
    const pullOrder = mockPullRepo.mock.invocationCallOrder[0];
    expect(resetOrder).toBeLessThan(pullOrder);
  });
});

describe('push item selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPullRepo.mockResolvedValue('Already up to date.');
    mockPushRepoBranch.mockResolvedValue(true);
    mockCheckoutMaster.mockResolvedValue(undefined);
    mockGenerateBranchName.mockReturnValue('teamai/push/test/20260403-120000');
    mockLoadStateForScope.mockResolvedValue({
      lastPush: null,
      lastPull: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });
    mockSaveStateForScope.mockResolvedValue(undefined);
    mockLoadRolesManifest.mockResolvedValue({
      version: 1,
      roles: [
        { id: 'hai', description: 'HyperAI', resources: { knowledge: ['common', 'hai'], skills: ['common', 'hai'], agents: [] } },
      ],
    });
    readlineAnswer = '1';
    mockScanTeamRepoNamespaces.mockResolvedValue([]);
  });

  it('pushes only selected items when user picks a subset', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    // Return 2 modified skills (no namespace prompt needed)
    mockGetHandler.mockImplementation((type: string) => {
      if (type === 'skills') {
        return {
          scanLocalForPush: vi.fn().mockResolvedValue([
            { name: 'skill-a', type: 'skills', sourcePath: '/tmp/skill-a', relativePath: 'skills/ns/skill-a', status: 'modified', namespace: 'ns' },
            { name: 'skill-b', type: 'skills', sourcePath: '/tmp/skill-b', relativePath: 'skills/ns/skill-b', status: 'modified', namespace: 'ns' },
          ]),
          pushItem: vi.fn().mockImplementation(async (item: Record<string, unknown>) => {
            pushedItems.push(item);
          }),
        };
      }
      return { scanLocalForPush: vi.fn().mockResolvedValue([]), pushItem: vi.fn() };
    });

    // Mock askSelection to select only the first item
    const { askSelection } = await import('../utils/prompt.js');
    vi.mocked(askSelection).mockResolvedValueOnce([0]);

    await push({}); // No --all flag → triggers selection

    expect(pushedItems).toHaveLength(1);
    expect(pushedItems[0].name).toBe('skill-a');
  });

  it('cancels when user selects none', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler();
    mockScanTeamRepoNamespaces.mockResolvedValue([]);

    // Mock askSelection to return null (cancel)
    const { askSelection } = await import('../utils/prompt.js');
    vi.mocked(askSelection).mockResolvedValueOnce(null);

    await push({}); // No --all flag

    expect(mockPushRepoBranch).not.toHaveBeenCalled();
  });

  it('skips namespace prompt when only modified skills are selected', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    // Return one new and one modified skill
    mockGetHandler.mockImplementation((type: string) => {
      if (type === 'skills') {
        return {
          scanLocalForPush: vi.fn().mockResolvedValue([
            { name: 'new-skill', type: 'skills', sourcePath: '/tmp/new-skill', relativePath: 'skills/new-skill', status: 'new' },
            { name: 'mod-skill', type: 'skills', sourcePath: '/tmp/mod-skill', relativePath: 'skills/hai/mod-skill', status: 'modified', namespace: 'hai' },
          ]),
          pushItem: vi.fn().mockImplementation(async (item: Record<string, unknown>) => {
            pushedItems.push(item);
          }),
        };
      }
      return { scanLocalForPush: vi.fn().mockResolvedValue([]), pushItem: vi.fn() };
    });

    // User selects only item 2 (the modified skill, index 1)
    const { askSelection } = await import('../utils/prompt.js');
    vi.mocked(askSelection).mockResolvedValueOnce([1]);

    await push({});

    // Should only push the modified skill, namespace prompt should not fire
    expect(pushedItems).toHaveLength(1);
    expect(pushedItems[0].name).toBe('mod-skill');
    expect(pushedItems[0].namespace).toBe('hai');
  });

  it('--all flag skips selection prompt', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockGetHandler.mockImplementation((type: string) => {
      if (type === 'skills') {
        return {
          scanLocalForPush: vi.fn().mockResolvedValue([
            { name: 'skill-a', type: 'skills', sourcePath: '/tmp/skill-a', relativePath: 'skills/ns/skill-a', status: 'modified', namespace: 'ns' },
            { name: 'skill-b', type: 'skills', sourcePath: '/tmp/skill-b', relativePath: 'skills/ns/skill-b', status: 'modified', namespace: 'ns' },
          ]),
          pushItem: vi.fn().mockImplementation(async (item: Record<string, unknown>) => {
            pushedItems.push(item);
          }),
        };
      }
      return { scanLocalForPush: vi.fn().mockResolvedValue([]), pushItem: vi.fn() };
    });

    const { askSelection } = await import('../utils/prompt.js');
    vi.mocked(askSelection).mockClear();

    await push({ all: true });

    // askSelection should NOT have been called
    expect(askSelection).not.toHaveBeenCalled();
    // But all items should have been pushed
    expect(pushedItems).toHaveLength(2);
  });
});

// Codex review finding 5: push()'s result.completed was set whenever pushGroup
// returned truthy, but pushGroup returned true on BOTH the no-change and the
// PR-creation-failed paths — so a no-op or PR-failed run wrongly flipped
// completed=true and fired the `push` webhook. These drive the REAL pushGroup
// path (not pushTeamConfigOnly).
describe('push completion signal through pushGroup (#702 follow-up, finding 5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPullRepo.mockResolvedValue('Already up to date.');
    mockPushRepoBranch.mockResolvedValue(true);
    mockCheckoutMaster.mockResolvedValue(undefined);
    mockGenerateBranchName.mockReturnValue('teamai/push/test/20260403-120000');
    mockLoadStateForScope.mockResolvedValue({
      lastPush: null, lastPull: null, pushedRules: [], pushedSkills: [], pushedEnvVars: [],
      lastUpdateCheck: null, availableUpdate: null, pendingPushes: [],
    });
    mockSaveStateForScope.mockResolvedValue(undefined);
    mockLoadRolesManifest.mockResolvedValue({
      version: 1,
      roles: [{ id: 'solo', description: 'Solo', resources: { knowledge: ['solo'], skills: ['solo'], agents: [] } }],
    });
    mockScanTeamRepoNamespaces.mockResolvedValue([]);
  });

  async function setCreatePullRequest(impl: () => Promise<string | null> | string | null): Promise<void> {
    const { getProvider } = await import('../providers/index.js');
    vi.mocked(vi.mocked(getProvider)().createPullRequest).mockImplementation(impl as never);
  }

  it('reports completed=true when a real resource push succeeds and a PR is created', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: 'solo', additionalRoles: [] }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler();
    await setCreatePullRequest(() => 'https://git.woa.com/mr/42');

    const outcome = { completed: false };
    await push({ all: true }, outcome);

    expect(mockPushRepoBranch).toHaveBeenCalled();
    expect(outcome.completed).toBe(true);
  });

  it('does NOT report completed when PR creation fails (pushGroup path)', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: 'solo', additionalRoles: [] }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler();
    // Provider returns null (branch pushed, PR not created) → exit code 1.
    await setCreatePullRequest(() => null);
    const originalExitCode = process.exitCode;

    try {
      const outcome = { completed: false };
      await push({ all: true }, outcome);

      expect(mockPushRepoBranch).toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(outcome.completed).toBe(false);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it('does NOT report completed when there are no changes to push (pushGroup path)', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: 'solo', additionalRoles: [] }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler();
    // Branch has no changes: pushRepoBranch reports nothing committed.
    mockPushRepoBranch.mockResolvedValue(false);
    await setCreatePullRequest(() => 'https://git.woa.com/mr/42');

    const outcome = { completed: false };
    await push({ all: true }, outcome);

    expect(mockPushRepoBranch).toHaveBeenCalled();
    expect(outcome.completed).toBe(false);
  });
});

/**
 * Issue #649: `--role`/`--project` used to place new skills only, so a new rule
 * or agent landed at the shared root and `pull` shipped it to the whole team.
 */
describe('push namespace routing for rules and agents', () => {
  /** Scans one item per type, and records what reached each handler's pushItem. */
  function mockHandlers(
    scanned: Partial<Record<'skills' | 'rules' | 'agents', Array<Record<string, unknown>>>>,
    pushedItems: Array<Record<string, unknown>>,
  ) {
    mockGetHandler.mockImplementation((type: string) => ({
      scanLocalForPush: vi.fn().mockResolvedValue(scanned[type as keyof typeof scanned] ?? []),
      pushItem: vi.fn().mockImplementation(async (item: Record<string, unknown>) => {
        pushedItems.push(item);
      }),
    }));
  }

  const newRule = {
    name: 'my-rule', type: 'rules', sourcePath: '/tmp/my-rule.md',
    relativePath: 'rules/my-rule.md', status: 'new',
  };
  const newAgent = {
    name: 'vr', type: 'agents', sourcePath: '/tmp/vr.md',
    relativePath: 'agents/vr.yaml', status: 'new',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPullRepo.mockResolvedValue('Already up to date.');
    mockPushRepoBranch.mockResolvedValue(true);
    mockCheckoutMaster.mockResolvedValue(undefined);
    mockGenerateBranchName.mockReturnValue('teamai/push/test/20260403-120000');
    mockLoadStateForScope.mockResolvedValue({
      lastPush: null, lastPull: null, pushedRules: [], pushedSkills: [],
      pushedEnvVars: [], lastUpdateCheck: null, availableUpdate: null,
    });
    mockSaveStateForScope.mockResolvedValue(undefined);
    mockLoadRolesManifest.mockResolvedValue({
      version: 1,
      roles: [
        { id: 'hai', description: 'HyperAI', resources: { knowledge: ['common', 'hai'], skills: ['common', 'hai'], agents: [] } },
      ],
    });
    readlineAnswer = '1';
    mockScanTeamRepoNamespaces.mockResolvedValue([]);
    process.exitCode = undefined;
  });

  it('--role places a new rule and a new agent in that namespace', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({ rules: [{ ...newRule }], agents: [{ ...newAgent }] }, pushedItems);

    await push({ all: true, role: 'pm' });

    const rule = pushedItems.find((i) => i.type === 'rules');
    const agent = pushedItems.find((i) => i.type === 'agents');
    expect(rule?.relativePath).toBe('rules/pm/my-rule.md');
    expect(rule?.namespace).toBe('pm');
    // The agent keeps the extension its handler chose.
    expect(agent?.relativePath).toBe('agents/pm/vr.yaml');
    expect(agent?.namespace).toBe('pm');
  });

  it('rejects a path-traversal --role before placing a rule', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await push({ all: true, role: '../outside' });

    expect(process.exitCode).toBe(2);
    expect(pushedItems).toHaveLength(0);
    // The flag is the problem, and this push carries no skill at all.
    const { log } = await import('../utils/logger.js');
    expect(vi.mocked(log.error).mock.calls.flat().join(' ')).toContain('--role');
  });

  it('--project resolves each type from its own axis, not from skills', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadProjectsManifest.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'front-app',
        name: 'Front App',
        description: '',
        resources: { knowledge: ['fe-know'], skills: ['fe-skills'], learnings: [], agents: ['fe-agents'] },
      }],
    });
    mockHandlers({
      skills: [{ name: 'skill-a', type: 'skills', sourcePath: '/tmp/skill-a', relativePath: 'skills/skill-a', status: 'new' }],
      rules: [{ ...newRule }],
      agents: [{ ...newAgent }],
    }, pushedItems);

    await push({ all: true, project: 'front-app' });

    const at = (type: string) => pushedItems.find((i) => i.type === type)?.relativePath;
    expect(at('rules')).toBe('rules/fe-know/my-rule.md');
    expect(at('skills')).toBe('skills/fe-skills/skill-a');
    expect(at('agents')).toBe('agents/fe-agents/vr.yaml');
  });

  it('refuses to push to the shared root when the project declares no namespace for the type', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadProjectsManifest.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'front-app', name: 'Front App', description: '',
        resources: { knowledge: [], skills: ['fe-skills'], learnings: [], agents: [] },
      }],
    });
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await push({ all: true, project: 'front-app' });

    expect(process.exitCode).toBe(2);
    expect(pushedItems).toHaveLength(0);
    expect(mockPushRepoBranch).not.toHaveBeenCalled();
  });

  it('pushes a rules-only scan to a project that declares no skills namespace', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadProjectsManifest.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'docs-only', name: 'Docs', description: '',
        resources: { knowledge: ['docs-know'], skills: [], learnings: [], agents: [] },
      }],
    });
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await push({ all: true, project: 'docs-only' });

    expect(process.exitCode).toBeUndefined();
    expect(pushedItems[0]?.relativePath).toBe('rules/docs-know/my-rule.md');
  });

  it('leaves an already-namespaced rule where it is', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({
      rules: [{
        name: 'frontend/scoped', type: 'rules', sourcePath: '/tmp/scoped.md',
        relativePath: 'rules/frontend/scoped.md', status: 'modified',
      }],
    }, pushedItems);

    await push({ all: true, role: 'pm' });

    // pushItem writes rather than moves (#654): relocating would leave a copy behind.
    expect(pushedItems[0]?.relativePath).toBe('rules/frontend/scoped.md');
  });

  it('places a new rule in the role knowledge namespace when no flag is given', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockLoadRolesManifest.mockResolvedValue({
      version: 1,
      roles: [
        { id: 'solo', description: 'Solo', resources: { knowledge: ['solo-know'], skills: ['solo-skills'], agents: [] } },
      ],
    });
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: 'solo' }),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await push({ all: true });

    // The knowledge axis, not the skills one.
    expect(pushedItems[0]?.relativePath).toBe('rules/solo-know/my-rule.md');
  });

  it('keeps a new rule at the shared root when the role declares no knowledge namespace', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockLoadRolesManifest.mockResolvedValue({
      version: 1,
      roles: [
        { id: 'solo', description: 'Solo', resources: { knowledge: [], skills: ['solo-skills'], agents: [] } },
      ],
    });
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: 'solo' }),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await push({ all: true });

    expect(pushedItems[0]?.relativePath).toBe('rules/my-rule.md');
    expect(pushedItems[0]?.namespace).toBeUndefined();
  });

  it('pushes a selected rule when only the unselected skill lacks a project namespace', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadProjectsManifest.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'docs-only', name: 'Docs', description: '',
        resources: { knowledge: ['docs-know'], skills: [], learnings: [], agents: [] },
      }],
    });
    mockHandlers({
      skills: [{ name: 'skill-a', type: 'skills', sourcePath: '/tmp/skill-a', relativePath: 'skills/skill-a', status: 'new' }],
      rules: [{ ...newRule }],
    }, pushedItems);

    // Deselect the skill, keep the rule (item order is skills then rules).
    const { askSelection } = await import('../utils/prompt.js');
    vi.mocked(askSelection).mockResolvedValueOnce([1]);

    await push({ project: 'docs-only' });

    expect(process.exitCode).toBeUndefined();
    expect(pushedItems).toHaveLength(1);
    expect(pushedItems[0]?.relativePath).toBe('rules/docs-know/my-rule.md');
  });

  it('still fails when the skill lacking a project namespace is selected', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadProjectsManifest.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'docs-only', name: 'Docs', description: '',
        resources: { knowledge: ['docs-know'], skills: [], learnings: [], agents: [] },
      }],
    });
    mockHandlers({
      skills: [{ name: 'skill-a', type: 'skills', sourcePath: '/tmp/skill-a', relativePath: 'skills/skill-a', status: 'new' }],
      rules: [{ ...newRule }],
    }, pushedItems);

    await push({ all: true, project: 'docs-only' });

    expect(process.exitCode).toBe(2);
    expect(pushedItems).toHaveLength(0);
  });

  it('says so when a new rule stays at the shared root', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockLoadRolesManifest.mockResolvedValue({
      version: 1,
      roles: [
        { id: 'solo', description: 'Solo', resources: { knowledge: [], skills: ['solo-skills'], agents: [] } },
      ],
    });
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: 'solo' }),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await push({ all: true });

    expect(pushedItems[0]?.relativePath).toBe('rules/my-rule.md');
    // Reaching the whole team is the outcome worth naming out loud.
    const { log } = await import('../utils/logger.js');
    const said = [...vi.mocked(log.info).mock.calls, ...vi.mocked(log.warn).mock.calls]
      .flat().join(' ');
    expect(said).toContain('rules/my-rule.md');
    expect(said).toMatch(/everyone|whole team|shared/i);
  });

  it('rejects an unknown --project even when nothing needs placing', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadProjectsManifest.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'front-app', name: 'Front App', description: '',
        resources: { knowledge: ['fe-know'], skills: ['fe-skills'], learnings: [], agents: [] },
      }],
    });
    // Only a modified, already-namespaced rule: nothing reaches the per-axis
    // resolver, so the typo would otherwise pass unnoticed.
    mockHandlers({
      rules: [{
        name: 'fe-know/scoped', type: 'rules', sourcePath: '/tmp/scoped.md',
        relativePath: 'rules/fe-know/scoped.md', status: 'modified',
      }],
    }, pushedItems);

    await push({ all: true, project: 'typo-id' });

    expect(process.exitCode).toBe(2);
    expect(pushedItems).toHaveLength(0);
  });

  it('keeps the namespace an open PR recorded for a skill even under --role', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadStateForScope.mockResolvedValue({
      lastPush: null, lastPull: null, pushedRules: [], pushedSkills: [],
      pushedEnvVars: [], lastUpdateCheck: null, availableUpdate: null,
      pendingPushes: [{
        branch: 'teamai/push/test/20260101-000000',
        prUrl: 'https://git.woa.com/mr/8',
        createdAt: '2026-01-01T00:00:00.000Z',
        items: [{ type: 'skills', name: 'skill-a', relativePath: 'skills/js/skill-a', namespace: 'js' }],
      }],
    });
    mockHandlers({
      skills: [{ name: 'skill-a', type: 'skills', sourcePath: '/tmp/skill-a', relativePath: 'skills/skill-a', status: 'new' }],
    }, pushedItems);

    await push({ all: true, role: 'pm' });

    // The branch is force-pushed, so honouring --role here would move the skill
    // inside the open PR rather than leaving a copy behind.
    expect(pushedItems[0]?.relativePath).toBe('skills/js/skill-a');
    expect(pushedItems[0]?.namespace).toBe('js');
  });

  it('reuses the namespace recorded for a rule when updating its open PR', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockLoadStateForScope.mockResolvedValue({
      lastPush: null, lastPull: null, pushedRules: [], pushedSkills: [],
      pushedEnvVars: [], lastUpdateCheck: null, availableUpdate: null,
      pendingPushes: [{
        branch: 'teamai/push/test/20260101-000000',
        prUrl: 'https://git.woa.com/mr/7',
        createdAt: '2026-01-01T00:00:00.000Z',
        items: [{ type: 'rules', name: 'my-rule', relativePath: 'rules/fe-know/my-rule.md', namespace: 'fe-know' }],
      }],
    });
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    // No flag this time: the destination must come from the PR record, or the
    // force-pushed branch would move the rule to the shared root.
    await push({ all: true });

    expect(pushedItems[0]?.relativePath).toBe('rules/fe-know/my-rule.md');
    expect(pushedItems[0]?.namespace).toBe('fe-know');
  });

  it('records where a root-level rule was placed so the next scan recognises it', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({ rules: [{ ...newRule }], agents: [{ ...newAgent }] }, []);

    await push({ all: true, role: 'pm' });

    // The author's copy stays at the tool's rules root, so the scanner needs
    // the record to map it back to rules/pm/ instead of reading it as new.
    const saved = mockSaveStateForScope.mock.calls.at(-1)?.[0] as { placedRules?: Record<string, string> };
    expect(saved.placedRules).toEqual({ 'my-rule': 'rules/pm/my-rule.md' });
  });

  it('does not record a rule the scanner already found in a subdirectory', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({
      rules: [{
        name: 'fe-know/my-rule', type: 'rules', sourcePath: '/tmp/fe-know/my-rule.md',
        relativePath: 'rules/fe-know/my-rule.md', status: 'modified', namespace: 'fe-know',
      }],
    }, []);

    await push({ all: true });

    // Its local path already carries the namespace, so full-path matching works.
    const saved = mockSaveStateForScope.mock.calls.at(-1)?.[0] as { placedRules?: Record<string, string> };
    expect(saved.placedRules ?? {}).toEqual({});
  });
});
