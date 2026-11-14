// The GraphQL v4 surface: a small parser for the documents gh and
// github-mcp-server actually send, an executor over the forge's store, and
// the introspection those clients use for feature detection. No library:
// the wire is POST /api/graphql with a JSON {query, variables} body (or a
// JSON array of operations for batching), answered {data, errors} at HTTP 200
// — a GraphQL-level failure is never an HTTP error. Unauthenticated is a 401.

import { Forge, buildCommit, parseCommit, type Issue, type PullRequest, type Repo } from './store.ts';
import { FIXED_ISO_TIME, VIEWER } from './scenario.ts';

// ---------------------------------------------------------------- the parser

export type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'String'; value: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: { name: string; value: ValueNode }[] };

export interface DirectiveNode {
  name: string;
  args: { name: string; value: ValueNode }[];
}

export interface FieldNode {
  kind: 'Field';
  alias?: string;
  name: string;
  args: { name: string; value: ValueNode }[];
  directives: DirectiveNode[];
  selection?: SelectionNode[];
}

export type SelectionNode =
  | FieldNode
  | { kind: 'FragmentSpread'; name: string; directives: DirectiveNode[] }
  | { kind: 'InlineFragment'; typeCondition?: string; directives: DirectiveNode[]; selection: SelectionNode[] };

export interface OperationNode {
  kind: 'query' | 'mutation';
  name?: string;
  variables: { name: string; defaultValue?: ValueNode }[];
  selection: SelectionNode[];
}

export interface FragmentNode {
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

interface Token {
  kind: 'Name' | 'Int' | 'Float' | 'String' | 'Punct' | 'EOF';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'Punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'Punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const escaped = source[i + 1] as string;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' };
          if (escaped === 'u' && i + 5 < source.length) {
            value += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            value += map[escaped] ?? escaped;
            i += 2;
          }
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'String', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'Float' : 'Int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'Name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'EOF', value: '' });
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'Punct' || token.value !== value) {
      throw new Error(`Expected "${value}" in GraphQL document, got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'Name' || (value !== undefined && token.value !== value)) {
      throw new Error(`Expected name ${value ?? ''} in GraphQL document, got ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'EOF') {
      if (this.peek().kind === 'Punct' && this.peek().value === '{') {
        operations.push({ kind: 'query', variables: [], selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation') {
        let name: string | undefined;
        if (this.peek().kind === 'Name') name = this.next().value;
        const variables = this.parseVariableDefinitions();
        operations.push({ kind: keyword, name, variables, selection: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        fragments.set(name, { name, typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`Unexpected definition ${JSON.stringify(keyword)} in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): { name: string; defaultValue?: ValueNode }[] {
    const variables: { name: string; defaultValue?: ValueNode }[] = [];
    if (this.peek().kind === 'Punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'Punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.peek().kind === 'Punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name, defaultValue });
      }
      this.next();
    }
    return variables;
  }

  private parseType(): void {
    if (this.peek().kind === 'Punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'Punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'Punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.next();
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'Punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'Name') {
        const keyword = this.peek().value;
        if (keyword === 'on') {
          this.next();
          const typeCondition = this.expectName();
          const directives = this.parseDirectives();
          return { kind: 'InlineFragment', typeCondition, directives, selection: this.parseSelectionSet() };
        }
        const name = this.next().value;
        return { kind: 'FragmentSpread', name, directives: this.parseDirectives() };
      }
      const directives = this.parseDirectives();
      return { kind: 'InlineFragment', directives, selection: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'Punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    let selection: SelectionNode[] | undefined;
    if (this.peek().kind === 'Punct' && this.peek().value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'Field', alias, name, args, directives, selection };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    if (this.peek().kind === 'Punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'Punct' && this.peek().value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args.push({ name, value: this.parseValue() });
      }
      this.next();
    }
    return args;
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.peek().kind === 'Punct' && this.peek().value === '@') {
      this.next();
      const name = this.expectName();
      directives.push({ name, args: this.parseArguments() });
    }
    return directives;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'Punct' && token.value === '$') return { kind: 'Variable', name: this.expectName() };
    if (token.kind === 'String') return { kind: 'String', value: token.value };
    if (token.kind === 'Int') return { kind: 'Int', value: Number(token.value) };
    if (token.kind === 'Float') return { kind: 'Float', value: Number(token.value) };
    if (token.kind === 'Name') {
      if (token.value === 'true') return { kind: 'Boolean', value: true };
      if (token.value === 'false') return { kind: 'Boolean', value: false };
      if (token.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: token.value };
    }
    if (token.kind === 'Punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'Punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'List', values };
    }
    if (token.kind === 'Punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'Punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'Object', fields };
    }
    throw new Error(`Unexpected value ${JSON.stringify(token.value)} in GraphQL document`);
  }
}

/** Parse a GraphQL document string into an AST. Throws on syntax errors. */
export function parseGraphQL(source: string): DocumentNode {
  return new Parser(source).parseDocument();
}

// ---------------------------------------------------------------- schema

/** The field names each object type holds (for validation and introspection). */
const SCHEMA_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', '__type', '__schema', '__typename'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', '__typename'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'avatarUrl', 'url', '__typename'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'private', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'createdAt', 'updatedAt', '__typename'],
  Ref: ['name', 'target', '__typename'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'repository', 'author', 'createdAt', 'updatedAt', 'closedAt', 'comments', '__typename'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'repository', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommitSha', '__typename'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  IssueEdge: ['node', 'cursor', '__typename'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestEdge: ['node', 'cursor', '__typename'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestChangedFileEdge: ['node', 'cursor', '__typename'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes', '__typename'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'url', '__typename'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  IssueCommentEdge: ['node', 'cursor', '__typename'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor', '__typename'],
  SearchResultItemConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  SearchResultItemEdge: ['node', 'cursor', '__typename'],
  CreateIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CloseIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId', '__typename'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes', 'ofType', 'specifiedByURL', '__typename'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason', '__typename'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason', '__typename'],
  __InputValue: ['name', 'description', 'type', 'defaultValue', '__typename'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives', '__typename'],
  Commit: ['oid', 'message', '__typename'],
};

const SCHEMA_ENUMS: Record<string, readonly string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  OrderDirection: ['ASC', 'DESC'],
};

const SCHEMA_INPUTS: Record<string, readonly string[]> = {
  CreateIssueInput: ['repositoryId', 'title', 'body', 'clientMutationId'],
  CloseIssueInput: ['issueId', 'clientMutationId'],
  CreatePullRequestInput: ['repositoryId', 'baseRefName', 'headRefName', 'title', 'body', 'draft', 'clientMutationId'],
  MergePullRequestInput: ['pullRequestId', 'mergeMethod', 'commitHeadline', 'commitBody', 'expectedHeadOid', 'clientMutationId'],
  AddCommentInput: ['subjectId', 'body', 'clientMutationId'],
  IssueOrder: ['field', 'direction'],
  PullRequestOrder: ['field', 'direction'],
};

// ---------------------------------------------------------------- global ids

/** Global ids are opaque base64 of a typed tag: never a bare database id. */
export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2 || parts.some((part) => part === '')) return null;
    return { kind: parts[0] as string, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- node builders

export interface GraphQLContext {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: { message: string; path?: (string | number)[] }[];
}

type Resolver = (args: Record<string, unknown>, context: GraphQLContext) => unknown;

function userNode(): Record<string, unknown> {
  return {
    __typename: 'User',
    id: globalId('User', VIEWER.id),
    databaseId: VIEWER.id,
    login: VIEWER.login,
    name: VIEWER.name,
    email: VIEWER.email,
    avatarUrl: `https://avatars.githubusercontent.com/u/${VIEWER.id}`,
    url: `https://api.github.com/users/${VIEWER.login}`,
  };
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function cursorIndex(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const index = Number(text.slice('cursor:'.length));
    return Number.isSafeInteger(index) && index >= 0 ? index : null;
  } catch {
    return null;
  }
}

interface ConnectionArgs {
  first?: number;
  after?: string;
}

function makeConnection<T>(items: readonly T[], args: ConnectionArgs, connectionType: string, edgeType: string): Record<string, unknown> {
  const afterIndex = args.after ? cursorIndex(args.after) : null;
  const start = afterIndex === null ? 0 : afterIndex + 1;
  const first = args.first ?? items.length;
  const slice = items.slice(start, start + Math.max(0, first));
  const edges = slice.map((node, i) => ({ __typename: edgeType, node, cursor: cursorFor(start + i) }));
  return {
    __typename: connectionType,
    nodes: slice,
    edges,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges.length ? (edges[0] as { cursor: string }).cursor : null,
      endCursor: edges.length ? (edges[edges.length - 1] as { cursor: string }).cursor : null,
    },
    totalCount: items.length,
  };
}

function repoNode(forge: Forge, repo: Repo): Record<string, unknown> {
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const node: Record<string, unknown> = {
    __typename: 'Repository',
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userNode(),
    description: repo.description,
    private: repo.private,
    defaultBranchRef: mainTip
      ? { __typename: 'Ref', name: repo.defaultBranch, target: { __typename: 'Commit', oid: mainTip, message: '' } }
      : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    createdAt: FIXED_ISO_TIME,
    updatedAt: FIXED_ISO_TIME,
  };
  node.issue = ((args: Record<string, unknown>): unknown => {
    const issue = repo.issues.find((item) => item.number === (args.number as number));
    return issue ? issueNode(forge, repo, issue) : null;
  }) as Resolver;
  node.issues = ((args: Record<string, unknown>): unknown => {
    let issues = [...repo.issues];
    const states = (args.states as string[] | undefined) ?? ['OPEN'];
    issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
    const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
    const direction = orderBy?.direction ?? 'DESC';
    issues.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
    return makeConnection(issues.map((issue) => issueNode(forge, repo, issue)), args as ConnectionArgs, 'IssueConnection', 'IssueEdge');
  }) as Resolver;
  node.pullRequest = ((args: Record<string, unknown>): unknown => {
    const pull = repo.pulls.find((item) => item.number === (args.number as number));
    return pull ? pullNode(forge, repo, pull) : null;
  }) as Resolver;
  node.pullRequests = ((args: Record<string, unknown>): unknown => {
    let pulls = [...repo.pulls];
    const states = args.states as string[] | undefined;
    if (states) {
      pulls = pulls.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
    } else {
      pulls = pulls.filter((pull) => pull.state === 'open');
    }
    const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
    const direction = orderBy?.direction ?? 'DESC';
    pulls.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
    return makeConnection(pulls.map((pull) => pullNode(forge, repo, pull)), args as ConnectionArgs, 'PullRequestConnection', 'PullRequestEdge');
  }) as Resolver;
  return node;
}

function issueNode(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  const node: Record<string, unknown> = {
    __typename: 'Issue',
    id: globalId('Issue', repo.id, issue.number),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository: repoNode(forge, repo),
    author: userNode(),
    createdAt: FIXED_ISO_TIME,
    updatedAt: FIXED_ISO_TIME,
    closedAt: issue.state === 'closed' ? FIXED_ISO_TIME : null,
  };
  node.comments = ((args: Record<string, unknown>): unknown => {
    const comments = repo.comments.get(issue.number) ?? [];
    return makeConnection(
      comments.map((comment) => ({
        __typename: 'IssueComment',
        id: globalId('IssueComment', repo.id, issue.number, comment.id),
        databaseId: comment.id,
        body: comment.body,
        author: userNode(),
        createdAt: FIXED_ISO_TIME,
        url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
      })),
      args as ConnectionArgs,
      'IssueCommentConnection',
      'IssueCommentEdge',
    );
  }) as Resolver;
  return node;
}

function pullNode(forge: Forge, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const node: Record<string, unknown> = {
    __typename: 'PullRequest',
    id: globalId('PullRequest', repo.id, pull.number),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
    merged: pull.merged,
    mergeable: forge.mergeableState(repo, pull.headSha, pull.baseSha),
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    repository: repoNode(forge, repo),
    author: userNode(),
    createdAt: FIXED_ISO_TIME,
    updatedAt: FIXED_ISO_TIME,
    mergedAt: pull.mergedAt,
    mergeCommitSha: pull.mergeCommitSha,
  };
  node.files = ((args: Record<string, unknown>): unknown => {
    const base = forge.mergeBase(repo, pull.headSha, pull.baseSha) ?? pull.baseSha;
    const changes = forge.diffFileMaps(repo, forge.treeFiles(repo, base), forge.treeFiles(repo, pull.headSha));
    return makeConnection(
      changes.map((change) => ({
        __typename: 'PullRequestChangedFile',
        path: change.path,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.changes,
      })),
      args as ConnectionArgs,
      'PullRequestChangedFileConnection',
      'PullRequestChangedFileEdge',
    );
  }) as Resolver;
  return node;
}

function commentNode(forge: Forge, repo: Repo, issueNumber: number, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    __typename: 'IssueComment',
    id: globalId('IssueComment', repo.id, issueNumber, comment.id),
    databaseId: comment.id,
    body: comment.body,
    author: userNode(),
    createdAt: FIXED_ISO_TIME,
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
  };
}

// ---------------------------------------------------------------- introspection

function typeField(name: string): Record<string, unknown> {
  return {
    __typename: '__Field',
    name,
    description: null,
    args: [],
    type: { __typename: '__Type', name: 'String', kind: 'SCALAR' },
    isDeprecated: false,
    deprecationReason: null,
  };
}

function enumValue(name: string): Record<string, unknown> {
  return { __typename: '__EnumValue', name, description: null, isDeprecated: false, deprecationReason: null };
}

function typeNode(name: string): Record<string, unknown> | null {
  if (SCHEMA_FIELDS[name]) {
    const node: Record<string, unknown> = {
      __typename: '__Type',
      name,
      kind: 'OBJECT',
      description: null,
      interfaces: [],
      possibleTypes: null,
      ofType: null,
      specifiedByURL: null,
    };
    node.fields = (() => SCHEMA_FIELDS[name]?.map((field) => typeField(field)) ?? []) as Resolver;
    node.enumValues = (() => null) as Resolver;
    node.inputFields = (() => null) as Resolver;
    return node;
  }
  if (SCHEMA_ENUMS[name]) {
    const node: Record<string, unknown> = {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      description: null,
      interfaces: [],
      possibleTypes: null,
      ofType: null,
      specifiedByURL: null,
    };
    node.fields = (() => null) as Resolver;
    node.enumValues = (() => SCHEMA_ENUMS[name]?.map((value) => enumValue(value)) ?? []) as Resolver;
    node.inputFields = (() => null) as Resolver;
    return node;
  }
  if (SCHEMA_INPUTS[name]) {
    const node: Record<string, unknown> = {
      __typename: '__Type',
      name,
      kind: 'INPUT_OBJECT',
      description: null,
      interfaces: [],
      possibleTypes: null,
      ofType: null,
      specifiedByURL: null,
    };
    node.fields = (() => null) as Resolver;
    node.enumValues = (() => null) as Resolver;
    node.inputFields = (() =>
      SCHEMA_INPUTS[name]?.map((field) => ({
        __typename: '__InputValue',
        name: field,
        description: null,
        type: { __typename: '__Type', name: 'String', kind: 'SCALAR' },
        defaultValue: null,
      })) ?? []) as Resolver;
    return node;
  }
  return null;
}

function schemaNode(): Record<string, unknown> {
  const types = [
    ...Object.keys(SCHEMA_FIELDS).map((name) => ({ __typename: '__Type', name, kind: 'OBJECT' })),
    ...Object.keys(SCHEMA_ENUMS).map((name) => ({ __typename: '__Type', name, kind: 'ENUM' })),
    ...Object.keys(SCHEMA_INPUTS).map((name) => ({ __typename: '__Type', name, kind: 'INPUT_OBJECT' })),
  ];
  return {
    __typename: '__Schema',
    types,
    queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT' },
    mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT' },
    subscriptionType: null,
    directives: [],
  };
}

// ---------------------------------------------------------------- executor

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'String':
    case 'Int':
    case 'Float':
    case 'Boolean':
      return node.value;
    case 'Null':
      return null;
    case 'Enum':
      return node.value;
    case 'List':
      return node.values.map((item) => valueOf(item, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = valueOf(arg.value, variables);
  return args;
}

function directivesSkip(directives: DirectiveNode[], variables: Record<string, unknown>): boolean {
  for (const directive of directives) {
    const args: Record<string, unknown> = {};
    for (const arg of directive.args) args[arg.name] = valueOf(arg.value, variables);
    if (directive.name === 'skip' && args.if === true) return true;
    if (directive.name === 'include' && args.if !== true) return true;
  }
  return false;
}

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      mergeInto(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}

function executeSelection(
  parent: unknown,
  parentType: string,
  selections: SelectionNode[],
  context: GraphQLContext,
  doc: DocumentNode,
  path: (string | number)[],
): Record<string, unknown> | null {
  if (parent === null || parent === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'FragmentSpread') {
      const fragment = doc.fragments.get(selection.name);
      if (!fragment) {
        context.errors.push({ message: `Unknown fragment "${selection.name}".`, path });
        continue;
      }
      if (directivesSkip(selection.directives, context.variables)) continue;
      const sub = executeSelection(parent, parentType, fragment.selection, context, doc, path);
      if (sub) mergeInto(out, sub);
      continue;
    }
    if (selection.kind === 'InlineFragment') {
      if (directivesSkip(selection.directives, context.variables)) continue;
      const typeName = (parent as Record<string, unknown>).__typename as string | undefined;
      if (selection.typeCondition && selection.typeCondition !== typeName && selection.typeCondition !== parentType) continue;
      const sub = executeSelection(parent, parentType, selection.selection, context, doc, path);
      if (sub) mergeInto(out, sub);
      continue;
    }
    if (directivesSkip(selection.directives, context.variables)) continue;
    const responseKey = selection.alias ?? selection.name;
    const fieldPath = [...path, responseKey];
    if (selection.name === '__typename') {
      out[responseKey] = parentType;
      continue;
    }
    const fields = SCHEMA_FIELDS[parentType];
    if (!fields || !fields.includes(selection.name)) {
      context.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".`, path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    const raw = (parent as Record<string, unknown>)[selection.name];
    let value: unknown;
    if (typeof raw === 'function') {
      try {
        value = (raw as Resolver)(argsOf(selection, context.variables), context);
      } catch (error) {
        context.errors.push({ message: error instanceof Error ? error.message : String(error), path: fieldPath });
        out[responseKey] = null;
        continue;
      }
    } else {
      value = raw;
    }
    if (selection.selection) {
      if (value === null || value === undefined) {
        out[responseKey] = null;
      } else if (Array.isArray(value)) {
        out[responseKey] = value.map((item) => {
          if (item === null || typeof item !== 'object') return item;
          const childType = (item as Record<string, unknown>).__typename as string | undefined;
          return executeSelection(item, childType ?? parentType, selection.selection as SelectionNode[], context, doc, fieldPath);
        });
      } else if (typeof value === 'object') {
        const childType = (value as Record<string, unknown>).__typename as string | undefined;
        out[responseKey] = executeSelection(value, childType ?? parentType, selection.selection, context, doc, fieldPath);
      } else {
        out[responseKey] = value;
      }
    } else {
      out[responseKey] = value;
    }
  }
  return out;
}

function findRepoById(forge: Forge, id: number): Repo | undefined {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function queryRoot(forge: Forge): Record<string, unknown> {
  const root: Record<string, unknown> = {
    __typename: 'Query',
    viewer: userNode(),
  };
  root.repository = ((args: Record<string, unknown>): unknown => {
    if (args.owner !== forge.viewerLogin) return null;
    const repo = forge.getRepo(args.name as string);
    return repo ? repoNode(forge, repo) : null;
  }) as Resolver;
  root.node = ((args: Record<string, unknown>): unknown => {
    const parsed = parseGlobalId(args.id as string);
    if (!parsed) return null;
    if (parsed.kind === 'Repository') {
      const repo = findRepoById(forge, Number(parsed.parts[0]));
      return repo ? repoNode(forge, repo) : null;
    }
    if (parsed.kind === 'User' && Number(parsed.parts[0]) === VIEWER.id) return userNode();
    if (parsed.kind === 'Issue') {
      const repo = findRepoById(forge, Number(parsed.parts[0]));
      const issue = repo?.issues.find((item) => item.number === Number(parsed.parts[1]));
      return repo && issue ? issueNode(forge, repo, issue) : null;
    }
    if (parsed.kind === 'PullRequest') {
      const repo = findRepoById(forge, Number(parsed.parts[0]));
      const pull = repo?.pulls.find((item) => item.number === Number(parsed.parts[1]));
      return repo && pull ? pullNode(forge, repo, pull) : null;
    }
    if (parsed.kind === 'IssueComment') {
      const repo = findRepoById(forge, Number(parsed.parts[0]));
      const comments = repo?.comments.get(Number(parsed.parts[1])) ?? [];
      const comment = comments.find((item) => item.id === Number(parsed.parts[2]));
      return repo && comment ? commentNode(forge, repo, Number(parsed.parts[1]), comment) : null;
    }
    return null;
  }) as Resolver;
  root.search = ((args: Record<string, unknown>): unknown => {
    const query = String(args.query ?? '').toLowerCase();
    const type = args.type as string | undefined;
    const nodes: unknown[] = [];
    if (!type || type === 'ISSUE') {
      for (const repo of forge.listRepos()) {
        for (const issue of repo.issues) {
          if (query === '' || issue.title.toLowerCase().includes(query) || issue.body.toLowerCase().includes(query)) {
            nodes.push(issueNode(forge, repo, issue));
          }
        }
      }
    }
    return makeConnection(nodes, args as ConnectionArgs, 'SearchResultItemConnection', 'SearchResultItemEdge');
  }) as Resolver;
  root.__type = ((args: Record<string, unknown>): unknown => typeNode(args.name as string)) as Resolver;
  root.__schema = (() => schemaNode()) as Resolver;
  return root;
}

function mutationRoot(forge: Forge): Record<string, unknown> {
  const root: Record<string, unknown> = { __typename: 'Mutation' };
  root.createIssue = ((args: Record<string, unknown>): unknown => {
    const input = args.input as Record<string, unknown>;
    const parsed = parseGlobalId(input.repositoryId as string);
    if (!parsed || parsed.kind !== 'Repository') throw new Error(`Could not resolve to a Repository with the id of '${String(input.repositoryId)}'.`);
    const repo = findRepoById(forge, Number(parsed.parts[0]));
    if (!repo) throw new Error(`Could not resolve to a Repository with the id of '${String(input.repositoryId)}'.`);
    const title = input.title as string | undefined;
    if (!title) throw new Error('title is required');
    const issue: Issue = {
      id: forge.nextGlobalId(),
      number: repo.issueSeq++,
      title,
      body: (input.body as string | undefined) ?? '',
      state: 'open',
      labels: [],
      seq: repo.issueSeq,
    };
    repo.issues.push(issue);
    repo.comments.set(issue.number, []);
    return { __typename: 'CreateIssuePayload', issue: issueNode(forge, repo, issue), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
  }) as Resolver;
  root.closeIssue = ((args: Record<string, unknown>): unknown => {
    const input = args.input as Record<string, unknown>;
    const parsed = parseGlobalId(input.issueId as string);
    if (!parsed || parsed.kind !== 'Issue') throw new Error(`Could not resolve to an Issue with the id of '${String(input.issueId)}'.`);
    const repo = findRepoById(forge, Number(parsed.parts[0]));
    const issue = repo?.issues.find((item) => item.number === Number(parsed.parts[1]));
    if (!repo || !issue) throw new Error(`Could not resolve to an Issue with the id of '${String(input.issueId)}'.`);
    issue.state = 'closed';
    return { __typename: 'CloseIssuePayload', issue: issueNode(forge, repo, issue), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
  }) as Resolver;
  root.createPullRequest = ((args: Record<string, unknown>): unknown => {
    const input = args.input as Record<string, unknown>;
    const parsed = parseGlobalId(input.repositoryId as string);
    if (!parsed || parsed.kind !== 'Repository') throw new Error(`Could not resolve to a Repository with the id of '${String(input.repositoryId)}'.`);
    const repo = findRepoById(forge, Number(parsed.parts[0]));
    if (!repo) throw new Error(`Could not resolve to a Repository with the id of '${String(input.repositoryId)}'.`);
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    const title = input.title as string | undefined;
    if (!headRef || !baseRef || !title) throw new Error('headRefName, baseRefName and title are required');
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha) throw new Error(`Head branch "${headRef}" does not exist`);
    if (!baseSha) throw new Error(`Base branch "${baseRef}" does not exist`);
    const pull: PullRequest = {
      id: forge.nextGlobalId(),
      number: repo.pullSeq++,
      title,
      body: (input.body as string | undefined) ?? '',
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
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(forge, repo, pull), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
  }) as Resolver;
  root.mergePullRequest = ((args: Record<string, unknown>): unknown => {
    const input = args.input as Record<string, unknown>;
    const parsed = parseGlobalId(input.pullRequestId as string);
    if (!parsed || parsed.kind !== 'PullRequest') throw new Error(`Could not resolve to a PullRequest with the id of '${String(input.pullRequestId)}'.`);
    const repo = findRepoById(forge, Number(parsed.parts[0]));
    const pull = repo?.pulls.find((item) => item.number === Number(parsed.parts[1]));
    if (!repo || !pull) throw new Error(`Could not resolve to a PullRequest with the id of '${String(input.pullRequestId)}'.`);
    if (pull.merged) {
      return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(forge, repo, pull), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
    }
    const merged = forge.squashMerge(repo, pull);
    if (!merged.ok) throw new Error(merged.reason);
    return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(forge, repo, pull), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
  }) as Resolver;
  root.addComment = ((args: Record<string, unknown>): unknown => {
    const input = args.input as Record<string, unknown>;
    const parsed = parseGlobalId(input.subjectId as string);
    if (!parsed || parsed.kind !== 'Issue') throw new Error(`Could not resolve to an Issue with the id of '${String(input.subjectId)}'.`);
    const repo = findRepoById(forge, Number(parsed.parts[0]));
    const issue = repo?.issues.find((item) => item.number === Number(parsed.parts[1]));
    if (!repo || !issue) throw new Error(`Could not resolve to an Issue with the id of '${String(input.subjectId)}'.`);
    const body = input.body as string | undefined;
    if (!body) throw new Error('body is required');
    const comment = { id: repo.commentSeq++, body, seq: repo.commentSeq };
    const list = repo.comments.get(issue.number) ?? [];
    list.push(comment);
    repo.comments.set(issue.number, list);
    const node = commentNode(forge, repo, issue.number, comment);
    return {
      __typename: 'AddCommentPayload',
      commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorFor(list.length - 1) },
      subject: issueNode(forge, repo, issue),
      clientMutationId: (input.clientMutationId as string | undefined) ?? null,
    };
  }) as Resolver;
  return root;
}

export interface GraphQLOperation {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: { message: string; path?: (string | number)[] }[];
}

function executeOperation(forge: Forge, operation: GraphQLOperation): GraphQLResult {
  let doc: DocumentNode;
  try {
    doc = parseGraphQL(operation.query);
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const variables: Record<string, unknown> = { ...(operation.variables ?? {}) };
  let selected: OperationNode | undefined;
  if (doc.operations.length === 1) {
    selected = doc.operations[0];
  } else if (operation.operationName) {
    selected = doc.operations.find((item) => item.name === operation.operationName);
    if (!selected) {
      return { data: null, errors: [{ message: `Unknown operation named "${operation.operationName}".` }] };
    }
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  for (const variable of selected.variables) {
    if (variables[variable.name] === undefined && variable.defaultValue !== undefined) {
      variables[variable.name] = valueOf(variable.defaultValue, variables);
    }
  }
  const context: GraphQLContext = { forge, variables, errors: [] };
  const root = selected.kind === 'mutation' ? mutationRoot(forge) : queryRoot(forge);
  const rootType = selected.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(root, rootType, selected.selection, context, doc, []);
  const result: GraphQLResult = { data };
  if (context.errors.length) result.errors = context.errors;
  return result;
}

// ---------------------------------------------------------------- dispatcher

export interface GraphQLRequest {
  headers: Map<string, string>;
  bodyText: string;
}

export interface GraphQLResponse {
  status: number;
  body: unknown;
}

/** Route one GraphQL request: a single operation or a batched array of them. */
export function handleGraphQL(forge: Forge, request: GraphQLRequest): GraphQLResponse {
  const header = request.headers.get('authorization');
  const token = header && header.toLowerCase().startsWith('bearer ') ? header.slice('bearer '.length).trim() : '';
  if (!token) return { status: 401, body: { message: 'Requires authentication' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.bodyText);
  } catch {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((item) => {
      if (item === null || typeof item !== 'object' || typeof (item as { query?: unknown }).query !== 'string') {
        return { data: null, errors: [{ message: 'Each batched operation needs a query string.' }] } as GraphQLResult;
      }
      return executeOperation(forge, item as GraphQLOperation);
    });
    return { status: 200, body: results };
  }
  if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { query?: unknown }).query !== 'string') {
    return { status: 400, body: { errors: [{ message: 'No query provided.' }] } };
  }
  return { status: 200, body: executeOperation(forge, parsed as GraphQLOperation) };
}
