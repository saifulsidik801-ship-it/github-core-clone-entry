// The REST v3 surface: repositories, branches, commits, refs, contents,
// labels, issues, comments and pull requests over the forge's store. Every
// reply is JSON (never HTML), every reply carries X-GitHub-Request-Id, an
// unknown route is a 404 JSON {message}, a malformed JSON body is a 400, and
// a missing bearer token is a 401. A repository belongs to the login the
// token names; the same name under another owner is a 404, never a 403.

import { Forge, buildCommit, buildTree, hashObject, parseCommit, parseTree, ZERO_OID, type Issue, type PullRequest, type Repo } from './store.ts';
import { DEFAULT_BRANCH, FIXED_EPOCH_SEC, FIXED_ISO_TIME, VIEWER } from './scenario.ts';

export interface RestRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Map<string, string>;
  bodyText: string;
  url: string;
}

export interface RestResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): RestResponse {
  return { status, headers: { 'X-GitHub-Request-Id': nextRequestId(), ...extraHeaders }, body };
}

function error(status: number, message: string): RestResponse {
  return json(status, { message });
}

function userShape(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: `U_${VIEWER.id}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER.id}`,
    gravatar_id: '',
    url: `https://api.github.com/users/${VIEWER.login}`,
    html_url: `https://github.com/${VIEWER.login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

function repoShape(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userShape(),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: FIXED_ISO_TIME,
    updated_at: FIXED_ISO_TIME,
    pushed_at: FIXED_ISO_TIME,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
  };
}

function labelShape(name: string, color: string): Record<string, unknown> {
  return {
    id: 0,
    node_id: `L_${name}`,
    url: `https://api.github.com/repos/${VIEWER.login}/labels/${encodeURIComponent(name)}`,
    name,
    color,
    default: false,
    description: '',
  };
}

function issueShape(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userShape(),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return labelShape(name, label?.color ?? 'ededed');
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: FIXED_ISO_TIME,
    updated_at: FIXED_ISO_TIME,
    closed_at: issue.state === 'closed' ? FIXED_ISO_TIME : null,
    author_association: 'OWNER',
  };
}

function commentShape(repo: Repo, issueNumber: number, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userShape(),
    created_at: FIXED_ISO_TIME,
    updated_at: FIXED_ISO_TIME,
    author_association: 'OWNER',
  };
}

function pullShape(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userShape(),
    labels: [],
    assignee: null,
    assignees: [],
    milestone: null,
    comments: 0,
    created_at: FIXED_ISO_TIME,
    updated_at: FIXED_ISO_TIME,
    closed_at: pull.state === 'closed' ? FIXED_ISO_TIME : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: null,
    mergeable_state: 'unknown',
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, user: userShape(), repo: repoShape(repo) },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, user: userShape(), repo: repoShape(repo) },
    author_association: 'OWNER',
  };
}

function branchShape(repo: Repo, name: string, sha: string): Record<string, unknown> {
  const commit = repo.objects.get(sha);
  const message = commit && commit.type === 'commit' ? parseCommit(commit.data).message : '';
  return {
    name,
    commit: {
      sha,
      commit: {
        message,
        author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO_TIME },
        committer: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO_TIME },
      },
    },
    protected: false,
  };
}

function commitShape(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return {
    sha,
    node_id: `C_${sha.slice(0, 12)}`,
    commit: {
      message: commit.message,
      author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO_TIME },
      committer: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO_TIME },
      tree: { sha: commit.tree },
    },
    author: userShape(),
    committer: userShape(),
    parents: commit.parents.map((parent) => ({ sha: parent })),
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

function parseJsonBody(request: RestRequest): { ok: true; value: Record<string, unknown> } | { ok: false; response: RestResponse } {
  if (request.bodyText === '') return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(request.bodyText);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, response: error(400, 'Request body must be a JSON object') };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, response: error(400, 'Problems parsing JSON') };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else if (item !== null && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
      out.push((item as { name: string }).name);
    }
  }
  return out;
}

/** Resolve a repo from the path's owner/name; a foreign owner is a 404, never a 403. */
function resolveRepo(forge: Forge, owner: string, name: string): { ok: true; repo: Repo } | { ok: false; response: RestResponse } {
  if (owner !== forge.viewerLogin) return { ok: false, response: error(404, 'Not Found') };
  const repo = forge.getRepo(name);
  if (!repo) return { ok: false, response: error(404, 'Not Found') };
  return { ok: true, repo };
}

/** Resolve a ref name (branch, tag, or full ref) to a commit oid, or null. */
function resolveRefToCommit(repo: Repo, ref: string): string | null {
  if (ref === 'HEAD') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const direct = repo.refs.get(ref);
  if (direct) return direct;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag) return tag;
  if (/^[0-9a-f]{40}$/.test(ref)) return repo.objects.has(ref) ? ref : null;
  return null;
}

/** Commits reachable from a tip, newest first (depth-first pre-order). */
function commitsFromTip(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    const commit = parseCommit(object.data);
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
  }
  return out;
}

// ---------------------------------------------------------------- routes

function handleRoot(): RestResponse {
  return json(200, {
    current_user_url: 'https://api.github.com/user',
    current_user_authorizations_html_url: 'https://github.com/settings/applications',
    authorizations_url: 'https://api.github.com/authorizations',
    code_search_url: 'https://api.github.com/search/code?q={query}{&page,per_page,sort,order}',
    commit_search_url: 'https://api.github.com/search/commits?q={query}{&page,per_page,sort,order}',
    emails_url: 'https://api.github.com/user/emails',
    emojis_url: 'https://api.github.com/emojis',
    events_url: 'https://api.github.com/events',
    feeds_url: 'https://api.github.com/feeds',
    followers_url: 'https://api.github.com/users/{user}/followers',
    following_url: 'https://api.github.com/users/{user}/following{/target}',
    gists_url: 'https://api.github.com/gists{/gist_id}',
    hub_url: 'https://api.github.com/hub',
    issue_search_url: 'https://api.github.com/search/issues?q={query}{&page,per_page,sort,order}',
    issues_url: 'https://api.github.com/issues',
    keys_url: 'https://api.github.com/user/keys',
    label_search_url: 'https://api.github.com/search/labels?repository_id={repository_id}&q={query}',
    notifications_url: 'https://api.github.com/notifications',
    organization_url: 'https://api.github.com/orgs/{org}',
    public_gists_url: 'https://api.github.com/gists/public',
    rate_limit_url: 'https://api.github.com/rate_limit',
    repository_url: 'https://api.github.com/repos/{owner}/{repo}',
    repository_search_url: 'https://api.github.com/search/repositories?q={query}{&page,per_page,sort,order}',
    current_user_repositories_url: 'https://api.github.com/user/repos{?type,page,per_page,sort}',
    starred_url: 'https://api.github.com/user/starred{/owner}{/repo}',
    starred_gists_url: 'https://api.github.com/gists/starred',
    topic_search_url: 'https://api.github.com/search/topics?q={query}{&page,per_page}',
    user_url: 'https://api.github.com/users/{user}',
    user_organizations_url: 'https://api.github.com/user/orgs',
    user_repositories_url: 'https://api.github.com/users/{user}/repos{?type,page,per_page,sort}',
    user_search_url: 'https://api.github.com/search/users?q={query}{&page,per_page,sort,order}',
  }, { 'X-OAuth-Scopes': 'repo, user, read:org' });
}

function handleMeta(): RestResponse {
  return json(200, {
    verifiable_password_authentication: true,
    ssh_key_fingerprints: {},
    ssh_keys: [],
    hooks: [],
    github_enterprise_importer: [],
    installed_version: '1.0.0',
    domains: { website: ['github.com'], codespaces: [], copilot: [], packages: [] },
  });
}

function handleCreateRepo(forge: Forge, request: RestRequest): RestResponse {
  const parsed = parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const name = asString(body.name);
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return error(422, 'Validation Failed: name is invalid');
  const repo = forge.createRepo(name, asString(body.description) ?? '', asBoolean(body.private) ?? false);
  if (!repo) return error(422, 'Validation Failed: name already exists on this account');
  return json(201, repoShape(repo));
}

function paginateLinkHeader(request: RestRequest, page: number, perPage: number, total: number): string {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const base = request.url.split('?')[0] as string;
  const link = (p: number, rel: string): string => `<${base}?per_page=${perPage}&page=${p}>; rel="${rel}"`;
  const parts: string[] = [];
  if (page < lastPage) parts.push(link(page + 1, 'next'), link(lastPage, 'last'));
  if (page > 1) parts.push(link(1, 'first'), link(page - 1, 'prev'));
  return parts.join(', ');
}

function handleListUserRepos(forge: Forge, request: RestRequest): RestResponse {
  const perPage = Math.max(1, Math.min(100, Number(request.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(request.query.get('page') ?? '1') || 1);
  const repos = forge.listRepos();
  const slice = repos.slice((page - 1) * perPage, page * perPage);
  const link = paginateLinkHeader(request, page, perPage, repos.length);
  return json(200, slice.map((repo) => repoShape(repo)), link ? { Link: link } : {});
}

function handlePatchRepo(forge: Forge, owner: string, name: string, request: RestRequest): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const parsed = parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const repo = resolved.repo;
  const description = asString(parsed.value.description);
  if (description !== undefined) repo.description = description;
  const isPrivate = asBoolean(parsed.value.private);
  if (isPrivate !== undefined) repo.private = isPrivate;
  return json(200, repoShape(repo));
}

function handleDeleteRepo(forge: Forge, owner: string, name: string): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  forge.deleteRepo(name);
  return { status: 204, headers: { 'X-GitHub-Request-Id': nextRequestId() }, body: null };
}

function handleListBranches(forge: Forge, owner: string, name: string): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const repo = resolved.repo;
  const branches: Record<string, unknown>[] = [];
  for (const refName of [...repo.refs.keys()].sort()) {
    if (!refName.startsWith('refs/heads/')) continue;
    const short = refName.slice('refs/heads/'.length);
    branches.push(branchShape(repo, short, repo.refs.get(refName) as string));
  }
  return json(200, branches);
}

function handleGetBranch(forge: Forge, owner: string, name: string, branch: string): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const repo = resolved.repo;
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (!sha) return error(404, 'Branch not found');
  return json(200, branchShape(repo, branch, sha));
}

function handleListCommits(forge: Forge, owner: string, name: string, request: RestRequest): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const repo = resolved.repo;
  const ref = request.query.get('sha') ?? repo.defaultBranch;
  const tip = resolveRefToCommit(repo, ref);
  if (!tip) return json(200, []);
  const commits = commitsFromTip(repo, tip);
  const shapes: unknown[] = [];
  for (const sha of commits) {
    const shape = commitShape(repo, sha);
    if (shape) shapes.push(shape);
  }
  return json(200, shapes);
}

function handleGetCommit(forge: Forge, owner: string, name: string, sha: string): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const shape = commitShape(resolved.repo, sha);
  if (!shape) return error(404, 'Not Found');
  return json(200, shape);
}

function handleCreateRef(forge: Forge, owner: string, name: string, request: RestRequest): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const parsed = parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const repo = resolved.repo;
  const ref = asString(parsed.value.ref);
  const sha = asString(parsed.value.sha);
  if (!ref || !ref.startsWith('refs/') || !sha || !/^[0-9a-f]{40}$/.test(sha)) {
    return error(422, 'Validation Failed: ref and sha are required');
  }
  if (!repo.objects.has(sha)) return error(422, 'Validation Failed: object does not exist');
  if (repo.refs.has(ref)) return error(422, 'Validation Failed: reference already exists');
  repo.refs.set(ref, sha);
  return json(201, {
    ref,
    node_id: `REF_${ref}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/refs/${encodeURIComponent(ref)}`,
    object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/${repo.objects.get(sha)?.type}s/${sha}` },
  });
}

function handleGetRef(forge: Forge, owner: string, name: string, refPath: string): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const repo = resolved.repo;
  const ref = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
  const sha = repo.refs.get(ref);
  if (!sha) return error(404, 'Not Found');
  return json(200, {
    ref,
    node_id: `REF_${ref}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/refs/${encodeURIComponent(ref)}`,
    object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/${repo.objects.get(sha)?.type}s/${sha}` },
  });
}

// ---------------------------------------------------------------- contents

/** The tree oid at a directory path inside a commit, or null. */
function treeAtPath(repo: Repo, commitOid: string, path: string): string | null {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.data).tree;
  if (path === '' || path === '/') return treeOid;
  for (const segment of path.split('/').filter((part) => part !== '')) {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((item) => item.name === segment && item.mode === '40000');
    if (!entry) return null;
    treeOid = entry.oid;
  }
  return treeOid;
}

function handleGetContents(forge: Forge, owner: string, name: string, filePath: string, request: RestRequest): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const repo = resolved.repo;
  const ref = request.query.get('ref') ?? repo.defaultBranch;
  const tip = resolveRefToCommit(repo, ref);
  if (!tip) return error(404, 'Not Found');
  const cleanPath = filePath.replace(/^\/+|\/+$/g, '');
  // A file wins over a directory of the same name (git has no such collision).
  const blob = forge.fileAt(repo, tip, cleanPath);
  if (blob) {
    const files = forge.treeFiles(repo, tip);
    const entry = files.get(cleanPath) as { oid: string; mode: string };
    return json(200, {
      type: 'file',
      encoding: 'base64',
      size: blob.length,
      name: cleanPath.split('/').pop() ?? cleanPath,
      path: cleanPath,
      content: blob.toString('base64'),
      sha: entry.oid,
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${cleanPath}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${ref}/${cleanPath}`,
      git_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/blobs/${entry.oid}`,
      download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${ref}/${cleanPath}`,
    });
  }
  const treeOid = treeAtPath(repo, tip, cleanPath);
  if (!treeOid) return error(404, 'Not Found');
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return error(404, 'Not Found');
  const entries: Record<string, unknown>[] = [];
  for (const item of parseTree(tree.data)) {
    const childPath = cleanPath === '' ? item.name : `${cleanPath}/${item.name}`;
    const isDir = item.mode === '40000';
    const blobObject = !isDir ? repo.objects.get(item.oid) : undefined;
    entries.push({
      type: isDir ? 'dir' : 'file',
      size: blobObject ? blobObject.data.length : 0,
      name: item.name,
      path: childPath,
      sha: item.oid,
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${childPath}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${ref}/${childPath}`,
      git_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${item.oid}`,
      download_url: isDir ? null : `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${ref}/${childPath}`,
    });
  }
  return json(200, entries);
}

function handlePutContents(forge: Forge, owner: string, name: string, filePath: string, request: RestRequest): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const parsed = parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const repo = resolved.repo;
  const body = parsed.value;
  const message = asString(body.message);
  const content = asString(body.content);
  if (!message || content === undefined) return error(422, 'Validation Failed: message and content are required');
  const branch = asString(body.branch) ?? repo.defaultBranch;
  const expectedSha = asString(body.sha);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(content.replace(/\s/g, ''), 'base64');
  } catch {
    return error(422, 'Validation Failed: content is not valid base64');
  }
  const cleanPath = filePath.replace(/^\/+|\/+$/g, '');
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const isUpdate = tip ? forge.fileAt(repo, tip, cleanPath) !== null : false;
  if (isUpdate && tip) {
    const files = forge.treeFiles(repo, tip);
    const current = files.get(cleanPath);
    if (expectedSha && current && expectedSha !== current.oid) {
      return error(409, 'Conflict: the file has changed since the given sha');
    }
  }
  const blobOid = forge.putObject(repo, 'blob', bytes);
  const files = tip ? forge.treeFiles(repo, tip) : new Map<string, { oid: string; mode: string }>();
  files.set(cleanPath, { oid: blobOid, mode: '100644' });
  const treeOid = forge.buildTreeFromFiles(repo, files);
  const parents = tip ? [tip] : [];
  const commitOid = forge.putObject(repo, 'commit', buildCommit({ tree: treeOid, parents, message }));
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return json(isUpdate ? 200 : 201, {
    content: {
      name: cleanPath.split('/').pop() ?? cleanPath,
      path: cleanPath,
      sha: blobOid,
      size: bytes.length,
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${cleanPath}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${branch}/${cleanPath}`,
      git_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
      download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${branch}/${cleanPath}`,
      type: 'file',
      encoding: 'base64',
      content: bytes.toString('base64'),
    },
    commit: { sha: commitOid, message },
  });
}

function handleDeleteContents(forge: Forge, owner: string, name: string, filePath: string, request: RestRequest): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const parsed = parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const repo = resolved.repo;
  const body = parsed.value;
  const message = asString(body.message);
  if (!message) return error(422, 'Validation Failed: message is required');
  const branch = asString(body.branch) ?? repo.defaultBranch;
  const expectedSha = asString(body.sha);
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return error(404, 'Not Found');
  const cleanPath = filePath.replace(/^\/+|\/+$/g, '');
  const files = forge.treeFiles(repo, tip);
  const current = files.get(cleanPath);
  if (!current) return error(404, 'Not Found');
  if (expectedSha && expectedSha !== current.oid) {
    return error(409, 'Conflict: the file has changed since the given sha');
  }
  files.delete(cleanPath);
  const treeOid = forge.buildTreeFromFiles(repo, files);
  const commitOid = forge.putObject(repo, 'commit', buildCommit({ tree: treeOid, parents: [tip], message }));
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return json(200, { commit: { sha: commitOid, message } });
}

// ---------------------------------------------------------------- labels / issues / comments / pulls

function handleListLabels(forge: Forge, owner: string, name: string): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  return json(200, [...resolved.repo.labels.values()].map((label) => labelShape(label.name, label.color)));
}

function handleCreateLabel(forge: Forge, owner: string, name: string, request: RestRequest): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const parsed = parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const repo = resolved.repo;
  const labelName = asString(parsed.value.name);
  const color = asString(parsed.value.color) ?? 'ededed';
  if (!labelName) return error(422, 'Validation Failed: name is required');
  if (repo.labels.has(labelName)) return error(422, 'Validation Failed: label already exists');
  repo.labels.set(labelName, { name: labelName, color });
  return json(201, labelShape(labelName, color));
}

function handleListIssues(forge: Forge, owner: string, name: string, request: RestRequest): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const repo = resolved.repo;
  const state = request.query.get('state') ?? 'open';
  const direction = request.query.get('direction') ?? 'desc';
  let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  issues = [...issues].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  return json(200, issues.map((issue) => issueShape(repo, issue)));
}

function handleCreateIssue(forge: Forge, owner: string, name: string, request: RestRequest): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const parsed = parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const repo = resolved.repo;
  const title = asString(parsed.value.title);
  if (!title) return error(422, 'Validation Failed: title is required');
  const labels = asStringArray(parsed.value.labels) ?? [];
  for (const label of labels) {
    if (!repo.labels.has(label)) return error(422, `Validation Failed: label "${label}" does not exist`);
  }
  const issue: Issue = {
    id: forge.nextGlobalId(),
    number: repo.issueSeq++,
    title,
    body: asString(parsed.value.body) ?? '',
    state: 'open',
    labels,
    seq: repo.issueSeq,
  };
  repo.issues.push(issue);
  repo.comments.set(issue.number, []);
  return json(201, issueShape(repo, issue));
}

function findIssue(repo: Repo, number: number): Issue | undefined {
  return repo.issues.find((issue) => issue.number === number);
}

function handleGetIssue(forge: Forge, owner: string, name: string, number: number): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const issue = findIssue(resolved.repo, number);
  if (!issue) return error(404, 'Not Found');
  return json(200, issueShape(resolved.repo, issue));
}

function handlePatchIssue(forge: Forge, owner: string, name: string, number: number, request: RestRequest): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const repo = resolved.repo;
  const issue = findIssue(repo, number);
  if (!issue) return error(404, 'Not Found');
  const parsed = parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const title = asString(parsed.value.title);
  if (title !== undefined) issue.title = title;
  const body = asString(parsed.value.body);
  if (body !== undefined) issue.body = body;
  const state = asString(parsed.value.state);
  if (state === 'open' || state === 'closed') issue.state = state;
  const labels = asStringArray(parsed.value.labels);
  if (labels !== undefined) {
    for (const label of labels) {
      if (!repo.labels.has(label)) return error(422, `Validation Failed: label "${label}" does not exist`);
    }
    issue.labels = labels;
  }
  return json(200, issueShape(repo, issue));
}

function handleListComments(forge: Forge, owner: string, name: string, number: number): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const repo = resolved.repo;
  if (!findIssue(repo, number)) return error(404, 'Not Found');
  const comments = repo.comments.get(number) ?? [];
  return json(200, comments.map((comment) => commentShape(repo, number, comment)));
}

function handleCreateComment(forge: Forge, owner: string, name: string, number: number, request: RestRequest): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const parsed = parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const repo = resolved.repo;
  if (!findIssue(repo, number)) return error(404, 'Not Found');
  const body = asString(parsed.value.body);
  if (!body) return error(422, 'Validation Failed: body is required');
  const comment = { id: repo.commentSeq++, body, seq: repo.commentSeq };
  const list = repo.comments.get(number) ?? [];
  list.push(comment);
  repo.comments.set(number, list);
  return json(201, commentShape(repo, number, comment));
}

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

function handleListPulls(forge: Forge, owner: string, name: string, request: RestRequest): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const repo = resolved.repo;
  const state = request.query.get('state') ?? 'open';
  const pulls = repo.pulls
    .filter((pull) => state === 'all' || pull.state === state)
    .sort((a, b) => b.seq - a.seq);
  return json(200, pulls.map((pull) => pullShape(repo, pull)));
}

function handleCreatePull(forge: Forge, owner: string, name: string, request: RestRequest): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const parsed = parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const repo = resolved.repo;
  const headRef = stripOwnerPrefix(asString(parsed.value.head) ?? '');
  const baseRef = stripOwnerPrefix(asString(parsed.value.base) ?? '');
  const title = asString(parsed.value.title);
  if (!headRef || !baseRef || !title) return error(422, 'Validation Failed: head, base and title are required');
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (!headSha) return error(422, `Validation Failed: head branch "${headRef}" does not exist`);
  if (!baseSha) return error(422, `Validation Failed: base branch "${baseRef}" does not exist`);
  const pull: PullRequest = {
    id: forge.nextGlobalId(),
    number: repo.pullSeq++,
    title,
    body: asString(parsed.value.body) ?? '',
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: repo.pullSeq,
  };
  repo.pulls.push(pull);
  return json(201, pullShape(repo, pull));
}

function findPull(repo: Repo, number: number): PullRequest | undefined {
  return repo.pulls.find((pull) => pull.number === number);
}

function handleGetPull(forge: Forge, owner: string, name: string, number: number): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const pull = findPull(resolved.repo, number);
  if (!pull) return error(404, 'Not Found');
  return json(200, pullShape(resolved.repo, pull));
}

function handleListPullFiles(forge: Forge, owner: string, name: string, number: number): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const repo = resolved.repo;
  const pull = findPull(repo, number);
  if (!pull) return error(404, 'Not Found');
  const base = forge.mergeBase(repo, pull.headSha, pull.baseSha) ?? pull.baseSha;
  const baseFiles = forge.treeFiles(repo, base);
  const headFiles = forge.treeFiles(repo, pull.headSha);
  const changes = forge.diffFileMaps(repo, baseFiles, headFiles);
  return json(200, changes.map((change) => ({
    sha: change.newOid ?? change.oldOid,
    filename: change.path,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.changes,
    blob_url: `https://github.com/${repo.owner}/${repo.name}/blob/${pull.headSha}/${change.path}`,
    raw_url: `https://github.com/${repo.owner}/${repo.name}/raw/${pull.headSha}/${change.path}`,
    contents_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${change.path}?ref=${pull.headSha}`,
  })));
}

function handleMergePull(forge: Forge, owner: string, name: string, number: number, request: RestRequest): RestResponse {
  const resolved = resolveRepo(forge, owner, name);
  if (!resolved.ok) return resolved.response;
  const parsed = parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const repo = resolved.repo;
  const pull = findPull(repo, number);
  if (!pull) return error(404, 'Not Found');
  if (pull.state !== 'open' || pull.merged) return error(405, 'Pull request is already closed');
  const merged = forge.squashMerge(repo, pull);
  if (!merged.ok) {
    return merged.reason === 'Merge conflict' ? error(405, 'Merge conflict') : error(422, `Validation Failed: ${merged.reason}`);
  }
  return json(200, { sha: merged.mergeSha, merged: true, message: 'Pull request successfully merged' });
}

// ---------------------------------------------------------------- dispatcher

function bearerToken(request: RestRequest): string | null {
  const header = request.headers.get('authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice('bearer '.length).trim();
  return token === '' ? null : token;
}

/**
 * Route one REST v3 request. Returns null when the path is not under
 * /api/v3 at all (the HTTP layer then tries the other surfaces).
 */
export function handleRest(forge: Forge, request: RestRequest): RestResponse | null {
  if (!request.path.startsWith('/api/v3')) return null;
  if (!bearerToken(request)) return error(401, 'Requires authentication');
  const path = request.path;
  const method = request.method;

  if (path === '/api/v3' || path === '/api/v3/') {
    return method === 'GET' ? handleRoot() : error(404, 'Not Found');
  }
  if (path === '/api/v3/meta') {
    return method === 'GET' ? handleMeta() : error(404, 'Not Found');
  }
  if (path === '/api/v3/user') {
    return method === 'GET' ? json(200, userShape()) : error(404, 'Not Found');
  }
  if (path === '/api/v3/user/repos') {
    if (method === 'GET') return handleListUserRepos(forge, request);
    if (method === 'POST') return handleCreateRepo(forge, request);
    return error(404, 'Not Found');
  }

  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!repoMatch) return error(404, 'Not Found');
  const owner = decodeURIComponent(repoMatch[1] as string);
  const repoName = decodeURIComponent(repoMatch[2] as string);
  const rest = repoMatch[3] ?? '';

  if (rest === '') {
    if (method === 'GET') {
      const resolved = resolveRepo(forge, owner, repoName);
      return resolved.ok ? json(200, repoShape(resolved.repo)) : resolved.response;
    }
    if (method === 'PATCH') return handlePatchRepo(forge, owner, repoName, request);
    if (method === 'DELETE') return handleDeleteRepo(forge, owner, repoName);
    return error(404, 'Not Found');
  }
  if (rest === 'branches') {
    return method === 'GET' ? handleListBranches(forge, owner, repoName) : error(404, 'Not Found');
  }
  const branchMatch = /^branches\/(.+)$/.exec(rest);
  if (branchMatch) {
    return method === 'GET' ? handleGetBranch(forge, owner, repoName, decodeURIComponent(branchMatch[1] as string)) : error(404, 'Not Found');
  }
  if (rest === 'commits') {
    return method === 'GET' ? handleListCommits(forge, owner, repoName, request) : error(404, 'Not Found');
  }
  const commitMatch = /^commits\/([0-9a-f]{40})$/.exec(rest);
  if (commitMatch) {
    return method === 'GET' ? handleGetCommit(forge, owner, repoName, commitMatch[1] as string) : error(404, 'Not Found');
  }
  if (rest === 'git/refs') {
    return method === 'POST' ? handleCreateRef(forge, owner, repoName, request) : error(404, 'Not Found');
  }
  const refMatch = /^git\/refs\/(.+)$/.exec(rest);
  if (refMatch) {
    return method === 'GET' ? handleGetRef(forge, owner, repoName, decodeURIComponent(refMatch[1] as string)) : error(404, 'Not Found');
  }
  const contentsMatch = /^contents\/(.+)$/.exec(rest);
  if (contentsMatch) {
    const filePath = decodeURIComponent(contentsMatch[1] as string);
    if (method === 'GET') return handleGetContents(forge, owner, repoName, filePath, request);
    if (method === 'PUT') return handlePutContents(forge, owner, repoName, filePath, request);
    if (method === 'DELETE') return handleDeleteContents(forge, owner, repoName, filePath, request);
    return error(404, 'Not Found');
  }
  if (rest === 'contents' || rest === 'contents/') {
    return method === 'GET' ? handleGetContents(forge, owner, repoName, '', request) : error(404, 'Not Found');
  }
  if (rest === 'labels') {
    if (method === 'GET') return handleListLabels(forge, owner, repoName);
    if (method === 'POST') return handleCreateLabel(forge, owner, repoName, request);
    return error(404, 'Not Found');
  }
  if (rest === 'issues') {
    if (method === 'GET') return handleListIssues(forge, owner, repoName, request);
    if (method === 'POST') return handleCreateIssue(forge, owner, repoName, request);
    return error(404, 'Not Found');
  }
  const issueMatch = /^issues\/(\d+)$/.exec(rest);
  if (issueMatch) {
    const number = Number(issueMatch[1]);
    if (method === 'GET') return handleGetIssue(forge, owner, repoName, number);
    if (method === 'PATCH') return handlePatchIssue(forge, owner, repoName, number, request);
    return error(404, 'Not Found');
  }
  const commentsMatch = /^issues\/(\d+)\/comments$/.exec(rest);
  if (commentsMatch) {
    const number = Number(commentsMatch[1]);
    if (method === 'GET') return handleListComments(forge, owner, repoName, number);
    if (method === 'POST') return handleCreateComment(forge, owner, repoName, number, request);
    return error(404, 'Not Found');
  }
  if (rest === 'pulls') {
    if (method === 'GET') return handleListPulls(forge, owner, repoName, request);
    if (method === 'POST') return handleCreatePull(forge, owner, repoName, request);
    return error(404, 'Not Found');
  }
  const pullMatch = /^pulls\/(\d+)$/.exec(rest);
  if (pullMatch) {
    return method === 'GET' ? handleGetPull(forge, owner, repoName, Number(pullMatch[1])) : error(404, 'Not Found');
  }
  const pullFilesMatch = /^pulls\/(\d+)\/files$/.exec(rest);
  if (pullFilesMatch) {
    return method === 'GET' ? handleListPullFiles(forge, owner, repoName, Number(pullFilesMatch[1])) : error(404, 'Not Found');
  }
  const pullMergeMatch = /^pulls\/(\d+)\/merge$/.exec(rest);
  if (pullMergeMatch) {
    return method === 'PUT' ? handleMergePull(forge, owner, repoName, Number(pullMergeMatch[1]), request) : error(404, 'Not Found');
  }
  return error(404, 'Not Found');
}
