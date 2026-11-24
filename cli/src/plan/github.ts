/**
 * The gh adapter of `docks-kit plan`: gh processes, the GraphQL transport with pagination, the plan issue snapshot,
 * the guarded issue write, and the pull request read. The argv shapes and queries match plan.mjs byte for byte. Each
 * response is decoded with a Schema; a decode failure gives the plan.mjs message of that check.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";

import { Effect, Predicate, Schema } from "effect";

import { PLAN_LABELS, isPhaseLabel, token } from "./records";
import { stateDirectory } from "./repository";
import {
  MAX_OUTPUT_MIB,
  PlanFiles,
  PlanProcess,
  PlanRepository,
  type ProcessResult,
} from "./services";
import {
  field,
  GhError,
  GraphqlError,
  PlanRefusal,
  type Closer,
  type FileError,
  type IssueComment,
  type IssueSummary,
  type LabelNode,
  type ParentLink,
  type PlanIssue,
  type PullRequestNode,
  type RepositoryInfo,
  type SpawnError,
} from "./types";

const ACTING_LOGIN_ERROR =
  "cannot resolve the acting GitHub login (the GraphQL viewer.login lookup returned nothing)";
const PAGE_INFO = "pageInfo{hasNextPage endCursor}";
const PULL_REQUEST_FIELDS = "number url state mergedAt baseRefName repository{nameWithOwner}";
const PULL_REQUEST_CONNECTION = `nodes{${PULL_REQUEST_FIELDS}} ${PAGE_INFO}`;
const REPOSITORY_LABELS = PLAN_LABELS.map(
  (name) => `${name.split(":").at(-1)}:label(name:"${name}"){name id}`,
).join(" ");
// The plan labels by name only, for `new`, which creates the issue with label names.
const REPOSITORY_LABEL_NAMES = PLAN_LABELS.map(
  (name) => `${name.split(":").at(-1)}:label(name:"${name}"){name}`,
).join(" ");
// The pre-write read returns the facts that a write compares with the snapshot and the node ids that the write needs.
const PRE_WRITE_FIELDS = "id,body,state,stateReason,labels,updatedAt,assignees";
// The last field of a write mutation returns the stored state that the post-write checks read.
const STORED_ISSUE_FIELDS = `body labels(first:100){nodes{name} ${PAGE_INFO}} assignees(first:100){nodes{id}}`;
// A plan list row and a sub-issue row: enough to derive the status of each issue.
export const ISSUE_SUMMARY_FIELDS = `number title state stateReason labels(first:100){nodes{name} ${PAGE_INFO}}`;
// The snapshot pages every issue label with its node id, so a write removes labels from the complete list.
const ISSUE_LABEL_FIELDS = "name id";
const ASSIGNEE_FIELDS = "... on Actor{login}";
// `fullDatabaseId` is the number after `#issuecomment-` in the comment URL, the id that an authority event names.
const COMMENT_FIELDS = "fullDatabaseId body createdAt author{login}";
const LABELED_EVENT_FIELDS = "... on LabeledEvent{label{name}}";
const CLOSED_EVENT_FIELDS = `... on ClosedEvent{createdAt closer{__typename ... on PullRequest{${PULL_REQUEST_FIELDS}} ... on Commit{oid associatedPullRequests(first:100){${PULL_REQUEST_CONNECTION}}}}}`;

export type GhServices = PlanProcess | PlanRepository;
/** The failures of a gh read. */
export type GhFailure = GhError | GraphqlError | SpawnError;

// Schemas of the response fields that the checks of plan.mjs read. A Struct ignores the fields it does not name.
// `Date.parse` decides a valid time, as in plan.mjs: `DateTime.make` reads a time without a zone as UTC.
const ParsableTime = Schema.String.check(
  Schema.makeFilter((text: string) => Number.isFinite(Date.parse(text))),
);
const NonBlankString = Schema.String.check(Schema.makeFilter((text: string) => !!text.trim()));
const PageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});
const Connection = Schema.Struct({ nodes: Schema.Array(Schema.ObjectKeyword), pageInfo: PageInfo });
const RepositoryName = Schema.Struct({ nameWithOwner: Schema.String });
const PullRequestFields = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  url: Schema.String,
  state: Schema.String,
  mergedAt: Schema.NullOr(Schema.String),
  baseRefName: Schema.String,
  repository: RepositoryName,
});
const CommitFields = Schema.Struct({
  oid: Schema.NonEmptyString,
  associatedPullRequests: Schema.optionalKey(Schema.Unknown),
});
const ClosedEvent = Schema.Struct({
  createdAt: ParsableTime,
  closer: Schema.NullOr(Schema.Struct({ __typename: Schema.NonEmptyString })),
});
const LabelName = Schema.Struct({ name: Schema.String });
const LabelWithId = Schema.Struct({ name: Schema.String, id: Schema.NonEmptyString });
const OptionalLabel = Schema.NullOr(LabelWithId);
const Assignee = Schema.Struct({ login: Schema.NonEmptyString });
const CommentFields = Schema.Struct({
  fullDatabaseId: Schema.String.check(Schema.isPattern(/^[1-9]\d*$/)),
  body: Schema.String,
  createdAt: ParsableTime,
  author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
});
const LabeledEvent = Schema.Struct({ label: LabelName });
const SummaryFields = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  state: Schema.String,
  stateReason: Schema.NullOr(Schema.String),
  labels: Schema.optionalKey(Schema.Unknown),
});
const ParentFields = Schema.NullOr(
  Schema.Struct({ number: Schema.Int, repository: RepositoryName }),
);
const IssueFields = Schema.Struct({
  number: Schema.Finite,
  title: Schema.String,
  body: Schema.String,
  state: Schema.String,
  stateReason: Schema.NullOr(Schema.String),
  url: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const RepositoryFields = Schema.Struct({
  nameWithOwner: Schema.String.check(Schema.isPattern(/^[^/]+\/[^/]+$/)),
  visibility: Schema.String,
});
const DefaultBranch = Schema.Struct({ name: Schema.String });
const PreWriteFields = Schema.Struct({
  id: Schema.NonEmptyString,
  body: Schema.String,
  state: Schema.String,
  stateReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  assignees: Schema.Array(
    Schema.Struct({ id: Schema.NonEmptyString, login: Schema.optionalKey(Schema.Unknown) }),
  ),
});
const StoredIssue = Schema.Struct({
  body: Schema.String,
  labels: Schema.Struct({ nodes: Schema.Array(Schema.Unknown) }),
  assignees: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })) }),
});
const PullRequestFieldsRead = Schema.Struct({
  url: Schema.String,
  merged: Schema.Boolean,
  mergedAt: Schema.optionalKey(Schema.Unknown),
  baseRefName: Schema.String,
  body: Schema.NullOr(Schema.String),
});
const ClosingReference = Schema.Struct({ number: Schema.Int, repository: RepositoryName });
const RestIssue = Schema.Struct({ id: Schema.Int });

/** Decode `input` with `schema`; a failure becomes the error that `onError` makes. */
const decodeWith = <T, E>(
  schema: Schema.ConstraintDecoder<T>,
  onError: () => E,
): ((input: unknown) => Effect.Effect<T, E>) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (input) => decode(input).pipe(Effect.mapError(onError));
};

const malformed = <T>(
  schema: Schema.ConstraintDecoder<T>,
  name: string,
): ((input: unknown) => Effect.Effect<T, GraphqlError>) =>
  decodeWith(
    schema,
    () => new GraphqlError({ message: `gh api graphql returned malformed ${name}` }),
  );

const ghCommand = (argv: ReadonlyArray<string>): string => argv.slice(0, 2).join(" ");

/** Start gh and refuse only when it cannot run, so that a caller can read a failed exit. */
export const ghResult = Effect.fn("plan.ghResult")(function* (argv: ReadonlyArray<string>) {
  const processes = yield* PlanProcess;
  const result = yield* processes.run("gh", argv);
  if (result.error?.code === "ENOENT")
    return yield* new GhError({ message: "gh is not installed or not on PATH" });
  if (result.error?.code === "ENOBUFS")
    return yield* new GhError({
      message: `gh ${ghCommand(argv)} output exceeded ${MAX_OUTPUT_MIB} MiB`,
    });
  if (result.error)
    return yield* new GhError({ message: `gh ${ghCommand(argv)} failed: ${result.error.message}` });
  return result;
});

export const ghOutput = Effect.fn("plan.ghOutput")(function* (
  argv: ReadonlyArray<string>,
  result: ProcessResult,
) {
  if (result.status === 0) return result.stdout;
  const detail = result.stderr.trim() || `exit ${result.status}`;
  return yield* new GhError({ message: `gh ${ghCommand(argv)} failed: ${detail}` });
});

export const runGh = Effect.fn("plan.runGh")(function* (argv: ReadonlyArray<string>) {
  return yield* ghOutput(argv, yield* ghResult(argv));
});

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const parseJson = Effect.fn("plan.parseJson")(function* (output: string, command: string) {
  return yield* decodeJson(output).pipe(
    Effect.mapError(() => new GhError({ message: `${command} returned invalid JSON` })),
  );
});

/** Run `gh api graphql` with the given fields and return the response data. */
export const graphqlData = Effect.fn("plan.graphqlData")(function* (fields: ReadonlyArray<string>) {
  const response = yield* parseJson(yield* runGh(["api", "graphql", ...fields]), "gh api graphql");
  const errors = field(response, "errors");
  if (!response || (errors !== undefined && (!Array.isArray(errors) || errors.length))) {
    const message = field(field(errors, "0"), "message") ?? "malformed errors";
    return yield* new GraphqlError({
      message: `gh api graphql returned errors: ${String(message)}`,
    });
  }
  const data = field(response, "data");
  if (!Predicate.isObjectOrArray(data))
    return yield* new GraphqlError({ message: "gh api graphql returned missing data" });
  return data;
});

export const graphql = Effect.fn("plan.graphql")(function* (
  query: string,
  variables: Readonly<Record<string, string | number>> = {},
) {
  const fields = ["-f", `query=${query}`, "-F", "owner={owner}", "-F", "name={repo}"];
  for (const [key, value] of Object.entries(variables)) fields.push("-F", `${key}=${value}`);
  return yield* graphqlData(fields);
});

export function issueConnectionSelection(
  connection: string,
  nodeFields: string,
  extraArgs = "",
  after = false,
): string {
  return `${connection}(first:100${after ? ",after:$after" : ""}${extraArgs}){nodes{${nodeFields}} ${PAGE_INFO}}`;
}

/** Read every page of a connection, up to `limit` nodes. */
export const connectionNodes = Effect.fn("plan.connectionNodes")(function* (
  initial: unknown,
  name: string,
  nextPage: (cursor: string) => Effect.Effect<unknown, GhFailure, PlanProcess>,
  limit = Number.POSITIVE_INFINITY,
) {
  const decodePage = malformed(Connection, name);
  const nodes: Array<object> = [];
  const seen = new Set<string>();
  let connection = initial;
  for (;;) {
    const page = yield* decodePage(connection);
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage || nodes.length >= limit) return nodes;
    const cursor = page.pageInfo.endCursor;
    if (cursor === null || !cursor || seen.has(cursor))
      return yield* new GraphqlError({
        message: `gh api graphql returned malformed ${name} cursor`,
      });
    seen.add(cursor);
    connection = yield* nextPage(cursor);
  }
});

const decodePullRequests = malformed(Schema.Array(PullRequestFields), "closing pull requests");

export const pullRequestNodes = (
  nodes: ReadonlyArray<unknown>,
): Effect.Effect<ReadonlyArray<PullRequestNode>, GraphqlError> => decodePullRequests(nodes);

/** Every node of an issue connection, from the first page in `initial` on. */
export const issueNodes = Effect.fn("plan.issueNodes")(function* (
  issueNumber: number,
  initial: unknown,
  connection: string,
  nodeFields: string,
  extraArgs = "",
) {
  const name = connection.includes(":") ? connection.split(":")[0] : connection;
  const selection = issueConnectionSelection(connection, nodeFields, extraArgs, true);
  const query = `query($owner:String!,$name:String!,$number:Int!,$after:String!){repository(owner:$owner,name:$name){issue(number:$number){${selection}}}}`;
  return yield* connectionNodes(initial, name, (after) =>
    graphql(query, { number: issueNumber, after }).pipe(
      Effect.map((data) => field(field(field(data, "repository"), "issue"), name)),
    ),
  );
});

/** Every pull request associated with the commit that closed a plan. */
export const associatedNodes = Effect.fn("plan.associatedNodes")(function* (
  commit: Extract<Closer, { readonly __typename: "Commit" }>,
) {
  const query = `query($owner:String!,$name:String!,$oid:String!,$after:String!){repository(owner:$owner,name:$name){commit:object(expression:$oid){... on Commit{associatedPullRequests(first:100,after:$after){${PULL_REQUEST_CONNECTION}}}}}}`;
  return yield* connectionNodes(
    commit.associatedPullRequests,
    "associated pull requests",
    (after) =>
      graphql(query, { oid: commit.oid, after }).pipe(
        Effect.map((data) =>
          field(field(field(data, "repository"), "commit"), "associatedPullRequests"),
        ),
      ),
  );
});

/** Issue rows read through ISSUE_SUMMARY_FIELDS, with every label page as a plain list. */
export const issueSummaries = Effect.fn("plan.issueSummaries")(function* (
  nodes: ReadonlyArray<object>,
  name: string,
) {
  const rows = yield* malformed(Schema.Array(SummaryFields), name)(nodes);
  const decodeLabels = malformed(Schema.Array(LabelName), name);
  const summaries: Array<IssueSummary> = [];
  for (const row of rows) {
    const labels = yield* decodeLabels(yield* issueNodes(row.number, row.labels, "labels", "name"));
    summaries.push({
      number: row.number,
      title: row.title,
      state: row.state,
      stateReason: row.stateReason,
      labels,
    });
  }
  return summaries;
});

export interface SnapshotOptions {
  readonly acting?: boolean;
  readonly labelLookup?: boolean;
  /** Read the acting login and the plan label names without their node ids, for `new`, which writes by name. */
  readonly namesOnly?: boolean;
  readonly comments?: boolean;
  readonly history?: boolean;
  readonly defaultBranch?: boolean;
  readonly closure?: boolean;
  readonly children?: boolean;
  readonly parent?: boolean;
}

export interface RepositorySnapshot {
  readonly login: string | undefined;
  readonly viewerId: string | undefined;
  /** Each plan label name maps to its node id, or to null when the repository lacks the label. */
  readonly labelIds: ReadonlyMap<string, string | null> | undefined;
  /** The plan labels that the repository lacks, when the read looked labels up. */
  readonly missingLabels: ReadonlyArray<string>;
}

export interface IssueSnapshot extends RepositorySnapshot {
  readonly issue: PlanIssue;
}

const decodeClosure = malformed(
  Schema.Struct({ nodes: Schema.Array(Schema.Unknown) }),
  "latest closure",
);
const decodeClosedEvent = malformed(ClosedEvent, "latest closure");
const decodeCommit = malformed(CommitFields, "closing commit");

/** The closer and the time of the latest close event in `latestClosure`. */
const latestCloser = Effect.fn("plan.latestCloser")(function* (latestClosure: unknown) {
  const { nodes } = yield* decodeClosure(latestClosure);
  if (nodes.length > 1)
    return yield* new GraphqlError({ message: "gh api graphql returned malformed latest closure" });
  if (nodes.length === 0) return { closer: undefined, closedEventAt: undefined };
  const event = yield* decodeClosedEvent(nodes[0]);
  const rawCloser = field(nodes[0], "closer");
  let closer: Closer | null = null;
  if (event.closer?.__typename === "PullRequest")
    closer = { __typename: "PullRequest", ...(yield* pullRequestNodes([rawCloser]))[0] };
  else if (event.closer?.__typename === "Commit")
    closer = { __typename: "Commit", ...(yield* decodeCommit(rawCloser)) };
  else if (event.closer) closer = { __typename: "Other" };
  return { closer, closedEventAt: event.createdAt };
});

function snapshotQuery(number: number | undefined, options: SnapshotOptions): string {
  const issueFields =
    number === undefined
      ? ""
      : [
          "number title body state stateReason url createdAt updatedAt",
          issueConnectionSelection("labels", ISSUE_LABEL_FIELDS),
          issueConnectionSelection("assignedActors", ASSIGNEE_FIELDS),
          options.comments ? issueConnectionSelection("comments", COMMENT_FIELDS) : "",
          options.history
            ? issueConnectionSelection(
                "history:timelineItems",
                LABELED_EVENT_FIELDS,
                ",itemTypes:[LABELED_EVENT]",
              )
            : "",
          options.closure
            ? `latestClosure:timelineItems(last:1,itemTypes:[CLOSED_EVENT]){nodes{${CLOSED_EVENT_FIELDS}}}`
            : "",
          options.children ? issueConnectionSelection("subIssues", ISSUE_SUMMARY_FIELDS) : "",
          options.parent ? "parent{number repository{nameWithOwner}}" : "",
        ].join(" ");
  const viewerFields = options.namesOnly ? "login" : "login id";
  const labels = options.namesOnly ? REPOSITORY_LABEL_NAMES : REPOSITORY_LABELS;
  return `query($owner:String!,$name:String!${number === undefined ? "" : ",$number:Int!"}){${options.acting ? `viewer{${viewerFields}}` : ""} repository(owner:$owner,name:$name){nameWithOwner visibility ${options.defaultBranch ? "defaultBranchRef{name}" : ""} ${options.labelLookup ? labels : ""} ${number === undefined ? "" : `issue(number:$number){${issueFields}}`}}}`;
}

const decodeRepository = malformed(RepositoryFields, "repository");
const decodeDefaultBranch = malformed(DefaultBranch, "default branch");
const decodeLogin = decodeWith(
  NonBlankString,
  () => new GraphqlError({ message: ACTING_LOGIN_ERROR }),
);
const decodeViewerId = malformed(Schema.NonEmptyString, "viewer");
const decodeOptionalLabel = malformed(OptionalLabel, "repository labels");
const decodeOptionalLabelName = malformed(Schema.NullOr(LabelName), "repository labels");

/** The repository part of a snapshot. It records the repository for the later writes of the command. */
const readRepository = Effect.fn("plan.readRepository")(function* (
  number: number | undefined,
  options: SnapshotOptions,
) {
  const data = yield* graphql(
    snapshotQuery(number, options),
    number === undefined ? {} : { number },
  );
  const repo = field(data, "repository");
  const { nameWithOwner, visibility } = yield* decodeRepository(repo);
  const defaultBranch = options.defaultBranch
    ? (yield* decodeDefaultBranch(field(repo, "defaultBranchRef"))).name
    : undefined;
  const repository = yield* PlanRepository;
  repository.current = { nameWithOwner, visibility, defaultBranch } satisfies RepositoryInfo;
  const viewer = field(data, "viewer");
  const login = options.acting ? yield* decodeLogin(field(viewer, "login")) : undefined;
  const viewerId =
    options.acting && !options.namesOnly ? yield* decodeViewerId(field(viewer, "id")) : undefined;
  let labelIds: Map<string, string | null> | undefined;
  const missingLabels: Array<string> = [];
  if (options.labelLookup) {
    if (!options.namesOnly) labelIds = new Map();
    for (const name of PLAN_LABELS) {
      const raw = field(repo, name.split(":").at(-1) ?? name);
      const label = options.namesOnly ? null : yield* decodeOptionalLabel(raw);
      const labelName = options.namesOnly
        ? (yield* decodeOptionalLabelName(raw))?.name
        : label?.name;
      if (labelName !== undefined && token(labelName) !== name)
        return yield* new GraphqlError({
          message: "gh api graphql returned malformed repository labels",
        });
      if (labelName === undefined) missingLabels.push(name);
      labelIds?.set(name, label?.id ?? null);
    }
  }
  const snapshot: RepositorySnapshot = { login, viewerId, labelIds, missingLabels };
  return { repo, snapshot };
});

/** The repository read of a command without an issue: the acting login and the plan label ids. */
export const readRepositorySnapshot = Effect.fn("plan.readRepositorySnapshot")(function* (
  options: SnapshotOptions,
) {
  return (yield* readRepository(undefined, options)).snapshot;
});

const decodeIssue = malformed(IssueFields, "plan issue");
const ownersMessage = "plan issue labels or assignees";
const decodeIssueLabels = malformed(Schema.Array(LabelWithId), ownersMessage);
const decodeAssignees = malformed(Schema.Array(Assignee), ownersMessage);
const decodeComments = malformed(Schema.Array(CommentFields), "issue comments");
const decodeHistory = malformed(Schema.Array(LabeledEvent), "label history");
const decodeParent = malformed(ParentFields, "parent issue");

/** One GraphQL read of the repository and the plan issue, with the connections that `options` select. */
export const readSnapshot = Effect.fn("plan.readSnapshot")(function* (
  number: number,
  options: SnapshotOptions = {},
) {
  const { repo, snapshot } = yield* readRepository(number, options);
  const rawIssue = field(repo, "issue");
  const issue = yield* decodeIssue(rawIssue);
  if (issue.number !== number)
    return yield* new GraphqlError({ message: "gh api graphql returned malformed plan issue" });
  const labelPages = yield* issueNodes(
    number,
    field(rawIssue, "labels"),
    "labels",
    ISSUE_LABEL_FIELDS,
  );
  const assigneePages = yield* issueNodes(
    number,
    field(rawIssue, "assignedActors"),
    "assignedActors",
    ASSIGNEE_FIELDS,
  );
  const labels: ReadonlyArray<LabelNode> = yield* decodeIssueLabels(labelPages);
  const assignees = yield* decodeAssignees(assigneePages);
  const comments: ReadonlyArray<IssueComment> = options.comments
    ? yield* decodeComments(
        yield* issueNodes(number, field(rawIssue, "comments"), "comments", COMMENT_FIELDS),
      )
    : [];
  const history = options.history
    ? (yield* decodeHistory(
        yield* issueNodes(
          number,
          field(rawIssue, "history"),
          "history:timelineItems",
          LABELED_EVENT_FIELDS,
          ",itemTypes:[LABELED_EVENT]",
        ),
      )).map((event) => event.label)
    : [];
  const closure = options.closure
    ? yield* latestCloser(field(rawIssue, "latestClosure"))
    : { closer: undefined, closedEventAt: undefined };
  const children = options.children
    ? yield* issueSummaries(
        yield* issueNodes(number, field(rawIssue, "subIssues"), "subIssues", ISSUE_SUMMARY_FIELDS),
        "sub-issues",
      )
    : [];
  const parent: ParentLink | null | undefined = options.parent
    ? yield* decodeParent(field(rawIssue, "parent"))
    : undefined;
  const planIssue: PlanIssue = {
    number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    stateReason: issue.stateReason,
    url: issue.url,
    labels,
    assignees,
    comments,
    history,
    closer: closure.closer,
    closedEventAt: closure.closedEventAt,
    children,
    parent,
    claimantId: undefined,
  };
  const result: IssueSnapshot = { ...snapshot, issue: planIssue };
  return result;
});

/** The repository that the latest snapshot named. Every caller reads a snapshot first. */
export const currentRepository = Effect.fn("plan.currentRepository")(function* () {
  const repository = yield* PlanRepository;
  if (repository.current === undefined)
    return yield* Effect.die(new Error("no repository was read before a write"));
  return repository.current;
});

const decodePreWrite = decodeWith(
  PreWriteFields,
  () => new GhError({ message: "gh issue view returned malformed plan issue" }),
);

/** The pre-write read: the issue as GitHub stores it now, with the node ids that the write mutation needs. */
export const preWriteIssue = Effect.fn("plan.preWriteIssue")(function* (number: number) {
  const { nameWithOwner } = yield* currentRepository();
  const output = yield* runGh([
    "issue",
    "view",
    String(number),
    "--json",
    PRE_WRITE_FIELDS,
    "--repo",
    nameWithOwner,
  ]);
  return yield* decodePreWrite(yield* parseJson(output, "gh issue view"));
});

/** The pre-write read before a state change that a rerun cannot take back: a later owner is refused. */
export const ownedPreWriteIssue = Effect.fn("plan.ownedPreWriteIssue")(function* (
  number: number,
  login: string | undefined,
) {
  const current = yield* preWriteIssue(number);
  if (current.assignees.some((owner) => !Predicate.isString(owner.login) || !owner.login))
    return yield* new GhError({ message: "gh issue view returned malformed plan issue" });
  const foreign = current.assignees.find((owner) => owner.login !== login);
  if (foreign)
    return yield* new PlanRefusal({
      message: `plan #${number} is owned by ${String(foreign.login)}`,
    });
  return current;
});

const decodeCreatedLabel = malformed(LabelWithId, "repository labels");

/** A status write can target a phase label that the repository lacks: create it as `new` does, then read its id. */
export const createdLabelId = Effect.fn("plan.createdLabelId")(function* (name: string) {
  const { nameWithOwner } = yield* currentRepository();
  yield* runGh(["label", "create", name, "--repo", nameWithOwner]);
  const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){label(name:${JSON.stringify(name)}){name id}}}`;
  const label = yield* decodeCreatedLabel(
    field(field(yield* graphql(query), "repository"), "label"),
  );
  if (token(label.name) !== name)
    return yield* new GraphqlError({
      message: "gh api graphql returned malformed repository labels",
    });
  return label.id;
});

/** Write `body` to a new private temporary file, run `use` with its path, and remove the file. */
export const withBodyFile = <A, E, R>(
  body: string,
  use: (file: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | FileError, R | PlanFiles> =>
  Effect.acquireUseRelease(
    stateDirectory().pipe(
      Effect.map((directory) => path.join(directory, `body-${process.pid}-${randomUUID()}.md`)),
    ),
    (file) =>
      PlanFiles.use((files) => files.createExclusive(file, body, 0o600)).pipe(
        Effect.andThen(use(file)),
      ),
    (file) => PlanFiles.use((files) => files.remove(file)),
  );

export interface IssueWrite {
  readonly body?: string;
  readonly add?: string;
  readonly remove?: ReadonlyArray<string>;
  readonly labelIds?: ReadonlyMap<string, string | null>;
  /** The state that the issue holds right before the write: the snapshot state, or `CLOSED` after archive's close. */
  readonly state?: string;
  /** The close reason right before the write: the snapshot's, or `COMPLETED` after archive's close. */
  readonly stateReason?: string | null;
  /** The phase labels that the issue holds right before the write: the snapshot's, or none after retire's removal. */
  readonly phases?: ReadonlyArray<string>;
  /** Run the pre-write read and its checks even when the write sends no field, as right before a close. */
  readonly verify?: boolean;
}

interface MutationField {
  readonly mutation: string;
  readonly input: string;
  readonly payload: "issue" | "labelable";
}

const decodeStored = malformed(StoredIssue, "stored plan issue");
const decodeStoredLabels = malformed(Schema.Array(LabelName), "labels");

const CHANGED_REMOTELY = "plan issue changed remotely; re-read and retry";

const phaseLabels = (labels: ReadonlyArray<{ readonly name: string }>): Array<string> =>
  [...new Set(labels.map((label) => token(label.name)).filter(isPhaseLabel))].sort();

const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((entry, index) => entry === b[index]);

type PreWrite = typeof PreWriteFields.Type;

/** What a write expects the issue to hold right before it: by default, what the snapshot read. */
export interface ExpectedIssue {
  readonly state?: string;
  /** The close reason of a closed issue, such as `COMPLETED` after archive's own close. */
  readonly stateReason?: string | null;
  readonly phases?: ReadonlyArray<string>;
  /** Require the base `plan` label also on a closed issue, as before a reopen. */
  readonly base?: boolean;
}

// gh issue view reads the first 100 labels only (cli/cli api/query_builder.go); a full page may hide more.
const GH_VIEW_LABEL_LIMIT = 100;

const decodeGraphqlPreWrite = malformed(
  Schema.Struct({
    id: Schema.NonEmptyString,
    body: Schema.String,
    state: Schema.String,
    stateReason: Schema.NullOr(Schema.String),
    assignees: Schema.Struct({
      nodes: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString, login: Schema.String })),
    }),
  }),
  "plan issue",
);

/**
 * Every label name of the issue, with the pre-write read to compare. A full label page of `gh issue view` may hide
 * more labels, so the issue is read again with GraphQL: its body, state, close reason, owners, and first label page
 * come from that one read, the later label pages follow it, and that read replaces the `gh issue view` read.
 */
const currentIssue = Effect.fn("plan.currentIssue")(function* (number: number, current: PreWrite) {
  if (current.labels.length < GH_VIEW_LABEL_LIMIT)
    return { names: current.labels.map((label) => label.name), latest: current };
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id body state stateReason assignees(first:100){nodes{id login}} ${issueConnectionSelection("labels", "name")}}}}`;
  const raw = field(field(yield* graphql(query, { number }), "repository"), "issue");
  const read = yield* decodeGraphqlPreWrite(raw);
  const names = (yield* decodeStoredLabels(
    yield* issueNodes(number, field(raw, "labels"), "labels", "name"),
  )).map((label) => label.name);
  const latest: PreWrite = {
    id: read.id,
    body: read.body,
    state: read.state,
    stateReason: read.stateReason,
    labels: names.map((name) => ({ name })),
    assignees: read.assignees.nodes,
  };
  return { names, latest };
});

/**
 * Refuse a write when the pre-write read `read` shows a change that governs the write: the body, the open or closed
 * state and the close reason, the base `plan` label of an open plan, the phase labels, or the owners. `expected` gives
 * the state and the phase labels after the command's own earlier writes; by default they are the snapshot's. An owner
 * other than the snapshot owner, the acting login, and the claim is refused by name; a snapshot owner that is gone is
 * a change. Returns the read to write with.
 */
export const refuseChangedIssue = Effect.fn("plan.refuseChangedIssue")(function* (
  issue: PlanIssue,
  read: PreWrite,
  {
    state = issue.state,
    stateReason = issue.stateReason,
    phases = phaseLabels(issue.labels),
    base = false,
  }: ExpectedIssue = {},
) {
  const { names, latest: current } = yield* currentIssue(issue.number, read);
  const closed = state.toUpperCase() === "CLOSED";
  const reason = (value: string | null | undefined): string => String(value ?? "").toUpperCase();
  if (
    current.body !== issue.body ||
    current.state.toUpperCase() !== state.toUpperCase() ||
    (closed && reason(current.stateReason) !== reason(stateReason)) ||
    ((base || !closed) && !names.some((name) => token(name) === "plan")) ||
    !sameList(phaseLabels(names.map((name) => ({ name }))), [...phases].sort())
  )
    return yield* new PlanRefusal({ message: CHANGED_REMOTELY });
  const owners = new Set(issue.assignees.map((owner) => owner.login));
  const foreign = current.assignees.find(
    (owner) =>
      owner.id !== issue.claimantId &&
      !(
        Predicate.isString(owner.login) &&
        (owners.has(owner.login) || owner.login === issue.actingLogin)
      ),
  );
  if (foreign)
    return yield* new PlanRefusal({
      message: `plan #${issue.number} is owned by ${String(foreign.login)}`,
    });
  if (owners.size > 0 && current.assignees.length === 0)
    return yield* new PlanRefusal({ message: CHANGED_REMOTELY });
  // A claim that an earlier write of the command confirmed must still hold.
  if (
    issue.confirmedOwner !== undefined &&
    !current.assignees.some((owner) => owner.login === issue.confirmedOwner)
  )
    return yield* new PlanRefusal({ message: CHANGED_REMOTELY });
  return current;
});

// A write is the pre-write read plus one GraphQL request (#89). A phase label that the repository lacks is created
// before that read, so the read is the last one before the write. GitHub runs the mutation fields in order: updateIssue
// first, so the body and the claim of an unassigned plan land in one write; then discrete label additions and
// removals, so a non-phase label that someone else adds meanwhile survives. The last field returns the stored state,
// which the post-write checks read: the body, the claim, and exactly the expected phase labels.
export const writeIssueIfUnchanged = Effect.fn("plan.writeIssueIfUnchanged")(function* (
  issue: PlanIssue,
  { body, add, remove = [], labelIds, state, stateReason, phases, verify = false }: IssueWrite = {},
) {
  const claimantId = issue.claimantId;
  const sends = body !== undefined || !!add || remove.length > 0 || claimantId !== undefined;
  if (!sends && !verify) return;
  const addId = add ? (labelIds?.get(add) ?? (yield* createdLabelId(add))) : undefined;
  const current = yield* refuseChangedIssue(issue, yield* preWriteIssue(issue.number), {
    ...(state && { state }),
    ...(stateReason !== undefined && { stateReason }),
    ...(phases && { phases }),
  });
  const removed = new Set(remove.map(token));
  const removeIds = issue.labels
    .filter((label) => removed.has(token(label.name)))
    .map((label) => label.id);
  if (
    body === undefined &&
    addId === undefined &&
    removeIds.length === 0 &&
    claimantId === undefined
  )
    return;
  const idLists: Array<readonly [string, ReadonlyArray<string>]> = [];
  const fields: Array<MutationField> = [];
  if (body !== undefined || claimantId !== undefined) {
    const input = ["id:$issue"];
    if (body !== undefined) input.push("body:$body");
    if (claimantId !== undefined) {
      idLists.push([
        "assignees",
        [...new Set([...current.assignees.map((owner) => owner.id), claimantId])],
      ]);
      input.push("assigneeIds:$assignees");
    }
    fields.push({ mutation: "updateIssue", input: input.join(","), payload: "issue" });
  }
  if (addId !== undefined) {
    idLists.push(["add", [addId]]);
    fields.push({
      mutation: "addLabelsToLabelable",
      input: "labelableId:$issue,labelIds:$add",
      payload: "labelable",
    });
  }
  if (removeIds.length) {
    idLists.push(["remove", removeIds]);
    fields.push({
      mutation: "removeLabelsFromLabelable",
      input: "labelableId:$issue,labelIds:$remove",
      payload: "labelable",
    });
  }
  const declarations = [
    "$issue:ID!",
    ...(body === undefined ? [] : ["$body:String!"]),
    ...idLists.map(([name]) => `$${name}:[ID!]!`),
  ];
  const selections = fields.map(({ mutation, input, payload }, index) => {
    const stored =
      payload === "issue"
        ? `issue{${STORED_ISSUE_FIELDS}}`
        : `labelable{... on Issue{${STORED_ISSUE_FIELDS}}}`;
    return `${mutation}(input:{${input}}){${index === fields.length - 1 ? stored : "clientMutationId"}}`;
  });
  const send = (bodyFile?: string) =>
    graphqlData([
      "-f",
      `query=mutation(${declarations.join(",")}){${selections.join(" ")}}`,
      "-f",
      `issue=${current.id}`,
      // gh passes an @file field byte for byte; any other -F value gets type conversion and placeholder filling.
      ...(bodyFile === undefined ? [] : ["-F", `body=@${bodyFile}`]),
      ...idLists.flatMap(([name, ids]) => ids.flatMap((id) => ["-f", `${name}[]=${id}`])),
    ]);
  const data = body === undefined ? yield* send() : yield* withBodyFile(body, send);
  const last = fields[fields.length - 1];
  const rawStored = field(field(data, last.mutation), last.payload);
  const stored = yield* decodeStored(rawStored);
  if (body !== undefined && stored.body !== body)
    return yield* new PlanRefusal({ message: "plan issue body differs after edit" });
  if (claimantId !== undefined) {
    if (!stored.assignees.nodes.some((owner) => owner.id === claimantId))
      return yield* new PlanRefusal({
        message: "plan issue claim did not land; re-read and retry",
      });
    issue.confirmedOwner = issue.actingLogin;
  }
  const storedLabels = yield* decodeStoredLabels(
    yield* issueNodes(issue.number, field(rawStored, "labels"), "labels", "name"),
  );
  const before = phases ?? phaseLabels(issue.labels);
  const expected = phaseLabels([
    ...before.filter((label) => !removed.has(label)).map((name) => ({ name })),
    ...(add ? [{ name: add }] : []),
  ]);
  if (!sameList(phaseLabels(storedLabels), expected))
    return yield* new PlanRefusal({ message: "plan issue labels differ after edit" });
});

export interface PullRequestRead {
  readonly number: number;
  readonly url: string;
  readonly merged: boolean;
  readonly mergedAt: string | null;
  readonly baseRefName: string;
  readonly body: string | null;
  readonly closesPlan: boolean;
  /**
   * Whether the pull request's own merge made its merge commit: a commit other than its head commit that GitHub
   * associates with this pull request. An indirect merge, through a direct push or another pull request, does not.
   */
  readonly landedByItself: boolean;
}

const MergeFields = Schema.Struct({
  headRefOid: Schema.String,
  mergeCommit: Schema.NullOr(
    Schema.Struct({ oid: Schema.NonEmptyString, associatedPullRequests: Schema.Unknown }),
  ),
});
const decodeMerge = malformed(MergeFields, "pull request");

const decodePullRequest = malformed(
  Schema.Struct({
    nameWithOwner: Schema.String,
    pullRequest: PullRequestFieldsRead,
  }),
  "pull request",
);
const decodeClosingReferences = malformed(
  Schema.Array(ClosingReference),
  "closing issue references",
);

// Pull request `number`: whether, when, and where it merged, its description, and whether GitHub lists plan
// `planNumber` of this repository among the issues that it closes.
export const readPullRequest = Effect.fn("plan.readPullRequest")(function* (
  number: number,
  planNumber: number,
) {
  const references = (after: boolean): string =>
    issueConnectionSelection(
      "closingIssuesReferences",
      "number repository{nameWithOwner}",
      "",
      after,
    );
  const query = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$pr){url merged mergedAt baseRefName body headRefOid mergeCommit{oid associatedPullRequests(first:100){${PULL_REQUEST_CONNECTION}}} ${references(false)}}}}`;
  const rawRepo = field(yield* graphql(query, { pr: number }), "repository");
  const repo = yield* decodePullRequest(rawRepo);
  const { pullRequest } = repo;
  const mergedAt = pullRequest.mergedAt;
  if (
    pullRequest.merged &&
    !(Predicate.isString(mergedAt) && Number.isFinite(Date.parse(mergedAt)))
  )
    return yield* new GraphqlError({ message: "gh api graphql returned malformed pull request" });
  const pageQuery = `query($owner:String!,$name:String!,$pr:Int!,$after:String!){repository(owner:$owner,name:$name){pullRequest(number:$pr){${references(true)}}}}`;
  const closed = yield* decodeClosingReferences(
    yield* connectionNodes(
      field(field(rawRepo, "pullRequest"), "closingIssuesReferences"),
      "closing issue references",
      (after) =>
        graphql(pageQuery, { pr: number, after }).pipe(
          Effect.map((data) =>
            field(field(field(data, "repository"), "pullRequest"), "closingIssuesReferences"),
          ),
        ),
    ),
  );
  const { headRefOid, mergeCommit } = yield* decodeMerge(field(rawRepo, "pullRequest"));
  const isThis = (candidate: PullRequestNode): boolean =>
    candidate.number === number && candidate.repository.nameWithOwner === repo.nameWithOwner;
  const landedByItself =
    pullRequest.merged &&
    mergeCommit !== null &&
    mergeCommit.oid !== headRefOid &&
    (yield* pullRequestNodes(
      yield* associatedNodes({ __typename: "Commit", ...mergeCommit }),
    )).some(isThis);
  const read: PullRequestRead = {
    number,
    url: pullRequest.url,
    merged: pullRequest.merged,
    mergedAt: Predicate.isString(mergedAt) ? mergedAt : null,
    baseRefName: pullRequest.baseRefName,
    body: pullRequest.body,
    closesPlan: closed.some(
      (issue) =>
        issue.number === planNumber && issue.repository.nameWithOwner === repo.nameWithOwner,
    ),
    landedByItself,
  };
  return read;
});

const decodeRestIssue = decodeWith(
  RestIssue,
  () => new GhError({ message: "gh api returned a malformed issue" }),
);

// A gh release without `issue create --parent` gets the REST sub-issues API, which takes the issue's database id.
export const linkSubIssue = Effect.fn("plan.linkSubIssue")(
  function* (parent: number, number: number) {
    const { nameWithOwner } = yield* currentRepository();
    const child = yield* decodeRestIssue(
      yield* parseJson(yield* runGh(["api", `repos/${nameWithOwner}/issues/${number}`]), "gh api"),
    );
    yield* runGh([
      "api",
      `repos/${nameWithOwner}/issues/${parent}/sub_issues`,
      "--method",
      "POST",
      "-F",
      `sub_issue_id=${child.id}`,
    ]);
  },
  (effect, parent, number) =>
    Effect.mapError(
      effect,
      (error) =>
        new GhError({
          message: `plan #${number} was created, but its link to parent #${parent} failed: ${error.message}`,
        }),
    ),
);
