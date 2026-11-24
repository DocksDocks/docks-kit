/**
 * Review comments, trusted comments, archive records, and delegation grants. Pure: no process, file, or GitHub
 * access.
 */
import { liveGoalLines, YOLO_DELEGATION_LINE } from "./records";
import type { IssueComment, ParentLink } from "./types";

export type ReviewKind = "plan" | "code";
export type Verdict = "pass" | "repair" | "fixes-required" | "blocked";

/** The fields of a plan issue that the trust rule reads. */
export interface CommentSource {
  readonly assignees: ReadonlyArray<{ readonly login: string }>;
  readonly comments: ReadonlyArray<IssueComment>;
}

// Reviewers write Markdown: read review keywords through emphasis, code marks, quotes, and list markers (#49). The
// verdict word itself is read on the raw line (`verdictWord`), so this reading may drop every mark.
function reviewText(line: string): string {
  return line
    .replace(/[*_`]/g, "")
    .trim()
    .replace(/^(?:>\s*)+/, "")
    .replace(/^(?:[-+]|\d+[.)])\s+/, "")
    .trim();
}
const REVIEW_HEADING = /^(?:#+\s*)?(plan|code) review/i;
// A verdict line is found on the review text of a line; its word is read on the raw line by one anchored grammar.
// After quote and list markers, the line must start with the label, `plan` or `code`, `-` or a space, `review`, `:`,
// with only `*`, `_`, or backtick runs between those parts and no white space; then white space and the token. The
// token, without closing punctuation, is a word (letters and digits joined by single hyphens), a word inside a run
// on both sides, or a word with a closing run. The runs of the label and of the token must pair up in order, each with
// the next run of the same marks. Any other line has no verdict word and reads as `blocked`: `Code-review:_pass`,
// `Code-review:_ pass`, `** Code-review: pass**`, `pass2`, `pa_ss`, `` `pass_` ``, `` `pass`2 ``, and `_`.
const REVIEW_VERDICT = /^(plan|code)[- ]review:/i;
const LINE_PREFIX = /^\s*(?:>\s*)*(?:(?:[-+*]|\d+[.)])\s+)?/;
const MARKS = "([*_`]*)";
const VERDICT_GRAMMAR = new RegExp(
  String.raw`^${MARKS}(?:plan|code)${MARKS}[- ]${MARKS}review${MARKS}:${MARKS}[ \t]+(\S*)`,
  "i",
);
const CLOSING_PUNCTUATION = /[.,;:!?)\]]+$/;
const WORD = String.raw`[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*`;
// Emphasis runs outside, one backtick pair right around the word: a code span keeps its content, so `` _`pass_` `` has
// no verdict word.
const TOKEN = new RegExp(
  String.raw`^([*_]*)(` + "`?" + String.raw`)(${WORD})(` + "`?" + String.raw`)([*_]*)$`,
  "u",
);
function verdictWord(rawLine: string): string {
  const line = VERDICT_GRAMMAR.exec(rawLine.replace(LINE_PREFIX, ""));
  const token = line ? TOKEN.exec(line[6].replace(CLOSING_PUNCTUATION, "")) : null;
  if (!line || !token || token[2] !== token[4]) return "";
  const runs = [...line.slice(1, 6), token[1], token[5]].filter(Boolean);
  for (let index = 0; index < runs.length; index += 2)
    if (runs[index] !== runs[index + 1]) return "";
  return token[3].toLowerCase();
}
const severeFinding = (text: string): boolean =>
  /\[(?:critical|high)\]/i.test(text) ||
  /^(?:critical|high)\s*:/i.test(text) ||
  /^severity\s*:\s*(?:critical|high)\b/i.test(text);
// One comment can hold several blocks of the same kind, such as the lens blocks of one code-review round (#98).
// A block starts at the first line or at a later Markdown heading line that names the comment's review kind. A
// quoted or list-item heading is prose, so a block that quotes an earlier round cannot open a block of its own. A
// block's verdict is its first verdict line of that kind; later verdict-like lines are prose, such as a quoted
// verdict of an earlier round. The most severe block verdict wins, so no block can hide another's failure.
// A heading line has `#` after at most three spaces, so a `*` list marker is not emphasis here; only the title after
// the `#` markers is read through emphasis and code marks.
function blockHeadingKind(rawLine: string): string | undefined {
  // GFM: one to six `#`, then a space, a tab, or the line end; `[\s\S]` keeps U+2028 and U+2029 in the title.
  const heading = /^ {0,3}#{1,6}(?:[ \t]([\s\S]*))?$/.exec(rawLine);
  if (!heading) return undefined;
  return /^\s*(plan|code) review/i
    .exec((heading[1] ?? "").replace(/[*_`]/g, ""))?.[1]
    .toLowerCase();
}
const VERDICT_SEVERITY: Readonly<Record<Verdict, number>> = {
  pass: 0,
  repair: 1,
  "fixes-required": 1,
  blocked: 2,
};
function verdictFor(kind: ReviewKind, alias: string): Verdict | undefined {
  if (["pass", "ok", "approved"].includes(alias)) return "pass";
  if (["repair", "changes", "fixes-required"].includes(alias))
    return kind === "plan" ? "repair" : "fixes-required";
  return alias === "blocked" ? "blocked" : undefined;
}
// The manager's response to round k follows the review blocks of round k+1 in the same comment (E5). The response
// quotes findings, so the parser reads no block heading, verdict, or severity from its heading line to the end. The
// manager writes the heading at the first column, outside a fence: so only such a line counts, and a heading that a
// block quotes in a quote, in a list item, indented, or in a first-column fence cannot cut off a later block.
const MANAGER_RESPONSE_HEADING = /^#### Manager response to round \d+[ \t]*$/;

// A fence that opens at the first column of a line is top-level, so the GFM rules for it are short: it opens with three
// or more backticks or tildes (a backtick fence has no backtick in its info string), and it closes at a line of at
// least as many of the same character after at most three spaces, with nothing after them. The lines from the opening
// fence to the closing fence are examples. A fence inside a quote or a list item, or indented, is read as text. The
// mask can still misread a fence, for example a fence line inside raw HTML; the reading stays safe because a masked
// verdict that is stricter keeps the stricter verdict, and raw HTML with a fence reads as `blocked`. Lines end at `\n`,
// `\r\n`, or `\r`, as in GFM; the info string is the rest of the line, also with U+2028 or U+2029 in it.
const FENCE_OPEN = /^(`{3,}|~{3,})([\s\S]*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

// A line that can open a raw HTML block in GFM: `<` at the first four columns, then a tag name, `/`, `!`, or `?`.
const RAW_HTML_START = /^ {0,3}<[A-Za-z/!?]/;
function fencedLines(rawLines: ReadonlyArray<string>): Array<boolean> {
  let open: { readonly char: string; readonly length: number } | undefined;
  return rawLines.map((line) => {
    if (open !== undefined) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === open.char && close[1].length >= open.length) open = undefined;
      return true;
    }
    const fence = FENCE_OPEN.exec(line);
    if (!fence || (fence[1][0] === "`" && fence[2].includes("`"))) return false;
    open = { char: fence[1][0], length: fence[1].length };
    return true;
  });
}

export function parseReviewComment(
  body: unknown,
): { kind: ReviewKind; verdict: Verdict } | undefined {
  if (typeof body !== "string") return undefined;
  const commentLines = body.trim().split(/\r\n|\r|\n/);
  // A fenced example holds no heading or verdict. Severity still reads every line, as the contract says.
  const fencedComment = fencedLines(commentLines);
  const response = commentLines.findIndex(
    (line, index) => index > 0 && !fencedComment[index] && MANAGER_RESPONSE_HEADING.test(line),
  );
  const rawLines = response < 0 ? commentLines : commentLines.slice(0, response);
  const fenced = fencedComment.slice(0, rawLines.length);
  const allLines = rawLines.map(reviewText);
  const lines = allLines.map((line, index) => (fenced[index] ? "" : line));
  const heading = REVIEW_HEADING.exec(lines[0]);
  if (!heading) return undefined;
  const kind: ReviewKind = heading[1].toLowerCase() === "plan" ? "plan" : "code";
  // Raw HTML changes where a fence opens and closes and can hold a line that looks like the response heading (GFM), and
  // this parser reads no HTML. So review text above the response cut that holds a line that can open raw HTML reads as
  // `blocked` when it also holds a first-column fence that the mask opened, or when the comment has a response cut: no
  // misread fence or cut can then produce a pass, and the reviewer posts the record again without the HTML. The mask
  // and the cut of a line depend only on the lines above it, so review text without raw HTML has a certain cut.
  if (rawLines.some((line) => RAW_HTML_START.test(line)) && (response >= 0 || fenced.some(Boolean)))
    return { kind, verdict: "blocked" };
  const blocks: Array<Array<number>> = [[]];
  for (const index of lines.keys()) {
    if (index === 0) continue;
    if (!fenced[index] && blockHeadingKind(rawLines[index]) === kind) blocks.push([]);
    else blocks[blocks.length - 1].push(index);
  }
  const isVerdictLine = (index: number): boolean =>
    REVIEW_VERDICT.exec(allLines[index])?.[1].toLowerCase() === kind;
  // A word outside the verdict table reads as `blocked`, in a block and in a fence alike: a block, or prose that the
  // scan takes for a block, can then not make the comment unreadable and keep an older pass.
  const verdictOf = (index: number): Verdict =>
    verdictFor(kind, verdictWord(rawLines[index])) ?? "blocked";
  // Like the severity scan, a fenced verdict line of the comment's kind that is stricter keeps the stricter verdict. So
  // a fence that the mask misreads, such as a fence line inside raw HTML, can hide no live `blocked` or
  // `fixes-required`, also when it hides every live verdict line; a fenced example of a stricter verdict only makes the
  // reading stricter. A comment whose only verdict lines are fenced passes is no review record.
  let masked: Verdict | undefined;
  for (const index of allLines.keys()) {
    if (!fenced[index] || !isVerdictLine(index)) continue;
    const example = verdictOf(index);
    if (masked === undefined || VERDICT_SEVERITY[example] > VERDICT_SEVERITY[masked])
      masked = example;
  }
  // A block without a verdict line is a heading inside the block before it, also the first block when a heading that
  // the scan takes for a block split it off: the verdict lines of the other blocks still count. A comment with no live
  // verdict line keeps a stricter masked one, and otherwise is no review record.
  const firsts = blocks
    .map((block) => block.find((index) => !fenced[index] && isVerdictLine(index)))
    .filter((index): index is number => index !== undefined);
  if (firsts.length === 0)
    return masked === undefined || masked === "pass" ? undefined : { kind, verdict: masked };
  let verdict = firsts
    .map(verdictOf)
    .reduce((worst, next) => (VERDICT_SEVERITY[next] > VERDICT_SEVERITY[worst] ? next : worst));
  if (masked !== undefined && VERDICT_SEVERITY[masked] > VERDICT_SEVERITY[verdict])
    verdict = masked;
  if (kind === "code" && verdict === "pass" && allLines.some(severeFinding))
    verdict = "fixes-required";
  return { kind, verdict };
}

// The comments that the trust rule accepts, oldest first: the issue has one assignee, and that assignee wrote them.
export function trustedComments(issue: CommentSource): Array<IssueComment> {
  const owners = issue.assignees;
  if (owners.length !== 1) return [];
  return issue.comments
    .map((comment, index) => ({ comment, index }))
    .sort(
      (a, b) =>
        Date.parse(a.comment.createdAt) - Date.parse(b.comment.createdAt) || a.index - b.index,
    )
    .map(({ comment }) => comment)
    .filter((comment) => comment.author?.login === owners[0].login);
}

export function reviewVerdicts(issue: CommentSource): Partial<Record<ReviewKind, Verdict>> {
  const verdicts: Partial<Record<ReviewKind, Verdict>> = {};
  for (const comment of trustedComments(issue)) {
    const review = parseReviewComment(comment.body);
    if (review) verdicts[review.kind] = review.verdict;
  }
  return verdicts;
}

// The archive record that `archive` posts with each successful archive, so that a later recovery knows which archive
// rule finished the plan (E1). A reopen comment ends the record of the archive before it.
export const parentRecord = (children: ReadonlyArray<{ readonly number: number }>): string =>
  `Archived as parent: children ${children.map((child) => `#${child.number}`).join(", ")}`;
export const landingRecord = (pr: number): string => `Archived with landing pull request #${pr}`;
// A reopen comment of `reopen` or `archive` ends the archive cycle before it.
const isReopenComment = (comment: IssueComment): boolean =>
  comment.body.trim().startsWith("Reopened: ");

export function archiveKind(issue: CommentSource): "parent" | "landing" | undefined {
  let kind: "parent" | "landing" | undefined;
  for (const comment of trustedComments(issue)) {
    const lines = comment.body.split(/\r?\n/).map((line) => line.trim());
    if (isReopenComment(comment)) kind = undefined;
    if (lines.some((line) => /^Archived as parent: children #\d+(?:, #\d+)*$/.test(line)))
      kind = "parent";
    if (lines.some((line) => /^Archived with landing pull request #\d+$/.test(line)))
      kind = "landing";
  }
  return kind;
}

// The trusted comments of the current archive cycle: the ones after the latest trusted reopen comment.
export function cycleComments(issue: CommentSource): Array<IssueComment> {
  const trusted = trustedComments(issue);
  let reopened = -1;
  trusted.forEach((comment, index) => {
    if (isReopenComment(comment)) reopened = index;
  });
  return trusted.slice(reopened + 1);
}

// Whether the current archive cycle already holds a trusted comment with the line `record`, so that a rerun does not
// post the record again, while the archive after a reopen gets its own record.
export const recorded = (issue: CommentSource, record: string): boolean =>
  cycleComments(issue).some((comment) =>
    comment.body.split(/\r?\n/).some((line) => line.trim() === record),
  );

// Authority events (contract, Delegated decisions). The parsing is not symmetric because each misreading must fail
// closed: a wrong `in force` gives the agent authority that the user did not give, and a wrong end only sends the
// questions back to the user. So a grant's first line must be exact, and a quoted or decorated grant is no event;
// a revocation's first line is read through emphasis, code marks, and case, so a hand-typed revocation still ends
// the grant; and a parent that the helper cannot read or check gives no grant.
const GRANT_EVENT = /^Delegation grant: (?:(yolo): )?(.*\S)$/;
const PARENT_EVENT = /^Parent event:(.*)$/;
const DELEGATED_LINE =
  /^Delegated: the user delegated the design and tradeoff decisions to the agent\. User: (.*)$/;

export type AuthorityEvent =
  | { readonly id: string; readonly createdAt: string; readonly kind: "revocation" }
  | {
      readonly id: string;
      readonly createdAt: string;
      readonly kind: "yolo" | "delegated";
      readonly quote: string;
      readonly parentEvent: string | undefined;
    };

// A quote compares after trimming and without one pair of surrounding double quotes.
function delegationQuote(quote: string): string {
  const text = quote.trim();
  return /^".*"$/s.test(text) ? text.slice(1, -1) : text;
}

function authorityEvent(comment: IssueComment): AuthorityEvent | undefined {
  const { fullDatabaseId: id, createdAt, body } = comment;
  const revocation = body.trim().split(/\r?\n/)[0].replace(/[*_`]/g, "").trim().toLowerCase();
  if (revocation === "delegation revoked") return { id, createdAt, kind: "revocation" };
  const [first, second = ""] = body.split(/\r?\n/);
  const grant = GRANT_EVENT.exec(first);
  if (!grant) return undefined;
  // A malformed `Parent event:` value still counts as a link, and it never matches a parent event.
  const parentEvent = PARENT_EVENT.exec(second)?.[1].trim();
  return {
    id,
    createdAt,
    kind: grant[1] ? "yolo" : "delegated",
    quote: grant[2],
    parentEvent,
  };
}

export const authorityEvents = (issue: CommentSource): Array<AuthorityEvent> =>
  trustedComments(issue).flatMap((comment) => authorityEvent(comment) ?? []);

export interface GrantState {
  readonly line: string;
  readonly advice: ReadonlyArray<string>;
}

/** The plan fields that the grant rule reads. */
export interface GrantSource extends CommentSource {
  readonly parent: ParentLink | null | undefined;
}

/** The read of the parent plan: its authority events, or a read that failed. */
export type ParentRead =
  | { readonly kind: "read"; readonly events: ReadonlyArray<AuthorityEvent> }
  | { readonly kind: "unreadable" };

// The `grant:` line of `show` and its advice. The plan's latest trusted event decides. A child's grant then holds only
// while its parent allows it, and the parent is read only for a child whose latest event is a grant. Last, the one
// live delegation line of Goal must match the deciding event in kind and quote. When the rule needs the parent and
// `parentRead` is undefined, the result names the parent to read; the caller reads it and calls again.
export function grantState(
  issue: GrantSource,
  goal: string,
  repositoryName: string,
  parentRead?: ParentRead,
): GrantState | { readonly readParent: number } {
  const latest = authorityEvents(issue).at(-1);
  const lines = liveGoalLines(goal)
    .map(({ text }) => text)
    .filter((text) => text === YOLO_DELEGATION_LINE || DELEGATED_LINE.test(text));
  const none = (reason?: string): GrantState => ({
    line: reason ? `grant: none; ${reason}` : "grant: none",
    advice: [],
  });
  if (!latest)
    return none(
      lines.length ? "the Goal delegation line has no trusted authority event" : undefined,
    );
  if (latest.kind === "revocation")
    return { line: `grant: ended by revocation comment ${latest.id}`, advice: [] };
  const { parent } = issue;
  if (!parent && latest.parentEvent !== undefined)
    return none(`comment ${latest.id} names a parent event, but the plan has no parent`);
  if (parent) {
    if (parent.repository.nameWithOwner !== repositoryName)
      return none(
        `parent #${parent.number} is in another repository (${parent.repository.nameWithOwner})`,
      );
    if (parentRead === undefined) return { readParent: parent.number };
    if (parentRead.kind === "unreadable") return none(`parent #${parent.number} cannot be read`);
    const parentLatest = parentRead.events.at(-1);
    // A linked grant holds only while the named event is the parent's latest, whatever the timestamps say; an
    // unlinked grant ends at any parent event that is not older than it. Equal timestamps cannot prove the order, so
    // a parent event with the same time ends the grant too (fail closed).
    const ended =
      latest.parentEvent === undefined
        ? parentLatest !== undefined &&
          Date.parse(parentLatest.createdAt) >= Date.parse(latest.createdAt)
        : parentLatest?.id !== latest.parentEvent;
    if (ended && !parentLatest)
      return none(`parent #${parent.number} has no trusted authority event`);
    if (ended && parentLatest)
      return {
        line: `grant: ended by parent #${parent.number} comment ${parentLatest.id}`,
        advice: lines.length
          ? [
              `parent #${parent.number} comment ${parentLatest.id} ended the grant; remove the delegation line from Goal, with no new event`,
            ]
          : [],
      };
  }
  if (lines.length !== 1)
    return none(
      lines.length
        ? `the Goal has ${lines.length} delegation lines for comment ${latest.id}`
        : `the Goal has no delegation line for comment ${latest.id}`,
    );
  const quote = DELEGATED_LINE.exec(lines[0])?.[1];
  const matches =
    latest.kind === "yolo"
      ? lines[0] === YOLO_DELEGATION_LINE
      : quote !== undefined && delegationQuote(quote) === delegationQuote(latest.quote);
  if (!matches) return none(`the Goal delegation line does not match comment ${latest.id}`);
  return { line: `grant: in force (${latest.kind}) by comment ${latest.id}`, advice: [] };
}
