// The MCP surface: JSON-RPC 2.0 over Streamable HTTP at POST /mcp. Modern
// revision 2026-07-28 first (server/discover, no session), the legacy
// initialize handshake as fallback. Tools act on the same store as REST, so
// a repository or issue created over MCP is the same object over REST, with
// the same ids. Every request answers inside its own JSON-RPC id; a tool
// failure is isError:true, never an HTTP 500; no Authorization header is a 401.

import { Forge, buildCommit, type Issue, type PullRequest, type Repo } from './store.ts';
import { FIXED_ISO_TIME, VIEWER } from './scenario.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      },
      required: ['repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_repos',
    description: 'List the authenticated user’s repositories.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'string', description: 'Comma-separated label names (each must already exist).' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        number: { type: 'number', description: 'The issue number.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['repo', 'number'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        state: { type: 'string', description: 'open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'close_issue',
    description: 'Close an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        number: { type: 'number', description: 'The issue number.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['repo', 'number'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get one pull request by repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
        number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['repo', 'pull_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        state: { type: 'string', description: 'open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
        number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_branch',
    description: 'Create a branch at an existing commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        branch: { type: 'string', description: 'The new branch name.' },
        sha: { type: 'string', description: 'The commit the branch starts at.' },
      },
      required: ['repo', 'branch', 'sha'],
      additionalProperties: false,
    },
  },
];

const TOOL_ALIASES: Record<string, string> = {
  create_repository: 'create_repo',
  repo_create: 'create_repo',
  repos_create: 'create_repo',
  repository_create: 'create_repo',
  get_repository: 'get_repo',
  repo_get: 'get_repo',
  repos_get: 'get_repo',
  repository_get: 'get_repo',
  issue_create: 'create_issue',
  issues_create: 'create_issue',
  issues_list: 'list_issues',
  issue_list: 'list_issues',
  pull_request_create: 'create_pull_request',
  pulls_create: 'create_pull_request',
  create_pr: 'create_pull_request',
  pr_create: 'create_pull_request',
  pull_request_merge: 'merge_pull_request',
  pulls_merge: 'merge_pull_request',
  merge_pr: 'merge_pull_request',
  pr_merge: 'merge_pull_request',
};

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Resolve a requested tool name to its canonical definition (prefix or alias). */
function findTool(name: string): ToolDef | null {
  const wanted = normalizeToolName(name);
  for (const tool of TOOLS) {
    if (normalizeToolName(tool.name) === wanted) return tool;
    const alias = TOOL_ALIASES[normalizeToolName(name)];
    if (alias && tool.name === alias) return tool;
  }
  for (const tool of TOOLS) {
    const normalized = normalizeToolName(tool.name);
    if (wanted.length > normalized.length && wanted.endsWith(normalized)) return tool;
  }
  return null;
}

// ---------------------------------------------------------------- tool results

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO_TIME,
    updated_at: FIXED_ISO_TIME,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: FIXED_ISO_TIME,
    updated_at: FIXED_ISO_TIME,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: FIXED_ISO_TIME,
    updated_at: FIXED_ISO_TIME,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

type ToolOutcome = { content: { type: 'text'; text: string }[]; structuredContent?: unknown; isError?: boolean };

function okResult(value: unknown): ToolOutcome {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], structuredContent: value };
}

function errorResult(message: string): ToolOutcome {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function stringArg(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function numberArg(args: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function resolveRepo(forge: Forge, args: Record<string, unknown>): { repo: Repo } | { error: string } {
  let owner = stringArg(args, 'owner', 'owner_login', 'login');
  let repoName = stringArg(args, 'repo', 'repository', 'repository_name', 'repo_name');
  const fullName = stringArg(args, 'full_name', 'repo_full_name', 'repository_full_name');
  if ((!owner || !repoName) && fullName && fullName.includes('/')) {
    const [o, r] = fullName.split('/', 2);
    owner = owner ?? o;
    repoName = repoName ?? r;
  }
  owner = owner ?? forge.viewerLogin;
  if (!repoName) return { error: 'Missing required argument: repo' };
  if (owner !== forge.viewerLogin) return { error: `Repository ${owner}/${repoName} not found` };
  const repo = forge.getRepo(repoName);
  if (!repo) return { error: `Repository ${owner}/${repoName} not found` };
  return { repo };
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = findTool(name);
  if (!tool) return errorResult(`Unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return errorResult(`Missing required argument: ${required}`);
    }
  }
  switch (tool.name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name', 'repo', 'repository');
      if (!repoName) return errorResult('Missing required argument: name');
      const repo = forge.createRepo(repoName, stringArg(args, 'description') ?? '', args.private === true || args.is_private === true);
      if (!repo) return errorResult(`Repository ${repoName} already exists`);
      return okResult(repoJson(repo));
    }
    case 'get_repo': {
      const resolved = resolveRepo(forge, args);
      if ('error' in resolved) return errorResult(resolved.error);
      return okResult(repoJson(resolved.repo));
    }
    case 'list_repos': {
      return okResult(forge.listRepos().map((repo) => repoJson(repo)));
    }
    case 'create_issue': {
      const resolved = resolveRepo(forge, args);
      if ('error' in resolved) return errorResult(resolved.error);
      const repo = resolved.repo;
      const title = stringArg(args, 'title', 'issue_title', 'subject');
      if (!title) return errorResult('Missing required argument: title');
      const body = stringArg(args, 'body', 'issue_body', 'description', 'content', 'text', 'comment') ?? '';
      const labelsRaw = stringArg(args, 'labels');
      const labels = labelsRaw ? labelsRaw.split(',').map((label) => label.trim()).filter((label) => label !== '') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return errorResult(`Label "${label}" does not exist`);
      }
      const issue: Issue = {
        id: forge.nextGlobalId(),
        number: repo.issueSeq++,
        title,
        body,
        state: 'open',
        labels,
        seq: repo.issueSeq,
      };
      repo.issues.push(issue);
      repo.comments.set(issue.number, []);
      return okResult(issueJson(repo, issue));
    }
    case 'get_issue': {
      const resolved = resolveRepo(forge, args);
      if ('error' in resolved) return errorResult(resolved.error);
      const number = numberArg(args, 'number', 'issue_number');
      if (number === undefined) return errorResult('Missing required argument: number');
      const issue = resolved.repo.issues.find((item) => item.number === number);
      if (!issue) return errorResult(`Issue #${number} not found`);
      return okResult(issueJson(resolved.repo, issue));
    }
    case 'list_issues': {
      const resolved = resolveRepo(forge, args);
      if ('error' in resolved) return errorResult(resolved.error);
      const state = stringArg(args, 'state', 'status') ?? 'open';
      const issues = resolved.repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.seq - a.seq)
        .map((issue) => issueJson(resolved.repo, issue));
      return okResult(issues);
    }
    case 'close_issue': {
      const resolved = resolveRepo(forge, args);
      if ('error' in resolved) return errorResult(resolved.error);
      const number = numberArg(args, 'number', 'issue_number');
      if (number === undefined) return errorResult('Missing required argument: number');
      const issue = resolved.repo.issues.find((item) => item.number === number);
      if (!issue) return errorResult(`Issue #${number} not found`);
      issue.state = 'closed';
      return okResult(issueJson(resolved.repo, issue));
    }
    case 'create_pull_request': {
      const resolved = resolveRepo(forge, args);
      if ('error' in resolved) return errorResult(resolved.error);
      const repo = resolved.repo;
      const title = stringArg(args, 'title', 'pr_title', 'pull_request_title', 'subject');
      const head = stringArg(args, 'head', 'head_ref', 'head_branch', 'source', 'source_branch', 'from', 'from_branch', 'branch');
      const base = stringArg(args, 'base', 'base_ref', 'base_branch', 'target', 'target_branch', 'into', 'into_branch');
      if (!title) return errorResult('Missing required argument: title');
      if (!head) return errorResult('Missing required argument: head');
      if (!base) return errorResult('Missing required argument: base');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha) return errorResult(`Head branch "${head}" does not exist`);
      if (!baseSha) return errorResult(`Base branch "${base}" does not exist`);
      const pull: PullRequest = {
        id: forge.nextGlobalId(),
        number: repo.pullSeq++,
        title,
        body: stringArg(args, 'body', 'description', 'content', 'text') ?? '',
        state: 'open',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: repo.pullSeq,
      };
      repo.pulls.push(pull);
      return okResult(pullJson(repo, pull));
    }
    case 'get_pull_request': {
      const resolved = resolveRepo(forge, args);
      if ('error' in resolved) return errorResult(resolved.error);
      const number = numberArg(args, 'pull_number', 'number', 'pr_number');
      if (number === undefined) return errorResult('Missing required argument: pull_number');
      const pull = resolved.repo.pulls.find((item) => item.number === number);
      if (!pull) return errorResult(`Pull request #${number} not found`);
      return okResult(pullJson(resolved.repo, pull));
    }
    case 'list_pull_requests': {
      const resolved = resolveRepo(forge, args);
      if ('error' in resolved) return errorResult(resolved.error);
      const state = stringArg(args, 'state', 'status') ?? 'open';
      const pulls = resolved.repo.pulls
        .filter((pull) => state === 'all' || pull.state === state)
        .sort((a, b) => b.seq - a.seq)
        .map((pull) => pullJson(resolved.repo, pull));
      return okResult(pulls);
    }
    case 'merge_pull_request': {
      const resolved = resolveRepo(forge, args);
      if ('error' in resolved) return errorResult(resolved.error);
      const repo = resolved.repo;
      const number = numberArg(args, 'pull_number', 'number', 'pr_number', 'pull_request_number');
      if (number === undefined) return errorResult('Missing required argument: pull_number');
      const pull = repo.pulls.find((item) => item.number === number);
      if (!pull) return errorResult(`Pull request #${number} not found`);
      if (pull.merged) return okResult(pullJson(repo, pull));
      const merged = forge.squashMerge(repo, pull);
      if (!merged.ok) return errorResult(merged.reason);
      return okResult(pullJson(repo, pull));
    }
    case 'create_branch': {
      const resolved = resolveRepo(forge, args);
      if ('error' in resolved) return errorResult(resolved.error);
      const repo = resolved.repo;
      const branch = stringArg(args, 'branch', 'ref', 'head', 'name');
      const sha = stringArg(args, 'sha');
      if (!branch) return errorResult('Missing required argument: branch');
      if (!sha) return errorResult('Missing required argument: sha');
      if (!repo.objects.has(sha)) return errorResult('Object does not exist');
      if (repo.refs.has(`refs/heads/${branch}`)) return errorResult(`Branch "${branch}" already exists`);
      repo.refs.set(`refs/heads/${branch}`, sha);
      return okResult({ ref: `refs/heads/${branch}`, sha });
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC

export interface McpRequest {
  headers: Map<string, string>;
  bodyText: string;
}

export interface McpResponse {
  status: number;
  body: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Route one MCP request. A notification (no id) answers 202 with no body. */
export function handleMcp(forge: Forge, request: McpRequest): McpResponse {
  const header = request.headers.get('authorization');
  const token = header && header.toLowerCase().startsWith('bearer ') ? header.slice('bearer '.length).trim() : '';
  if (!token) {
    return { status: 401, body: rpcError(null, -32000, 'Requires authentication') };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.bodyText);
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((item) => handleOne(forge, item));
    return { status: 200, body: results.filter((result) => result !== null) };
  }
  const result = handleOne(forge, parsed);
  if (result === null) return { status: 202, body: null };
  return { status: 200, body: result };
}

function handleOne(forge: Forge, parsed: unknown): Record<string, unknown> | null {
  if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { method?: unknown }).method !== 'string') {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const body = parsed as { jsonrpc?: unknown; id?: unknown; method: string; params?: Record<string, unknown> };
  const id = body.id === undefined ? null : body.id;
  const isNotification = body.id === undefined;
  const params = (body.params ?? {}) as Record<string, unknown>;
  switch (body.method) {
    case 'server/discover': {
      return rpcResult(id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        },
      });
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress': {
      return null;
    }
    case 'ping': {
      return rpcResult(id, {});
    }
    case 'tools/list': {
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (!name) return rpcError(id, -32602, 'Missing required argument: name');
      const tool = findTool(name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const outcome = callTool(forge, name, args);
      void tool;
      return rpcResult(id, outcome);
    }
    default: {
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${body.method}`);
    }
  }
}
