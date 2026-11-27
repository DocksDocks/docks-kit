/**
 * Attachments of a talk message (#250 E9): the kinds `file`, `snippet`, and
 * `context`, and the labeled block of each one in the message text.
 * Attachments are unverified data from a peer. This module never touches the
 * file system: a `file` block shows the name and the content as the sender
 * gave them, the send time, and the words `freshness unknown`.
 */
import { DateTime, Schema } from "effect";

/** The attachment kinds, in the order of E9. */
export const ATTACHMENT_KINDS = ["file", "snippet", "context"] as const;

const AttachmentName = Schema.NonEmptyString;

/** A fence info word. Backticks and white space would end the fence line early, so they are refused. */
const Language = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_+#.-]{1,64}$/));

export const FileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  name: AttachmentName,
  content: Schema.String,
});

export const SnippetAttachment = Schema.Struct({
  type: Schema.Literal("snippet"),
  name: AttachmentName,
  content: Schema.String,
  language: Schema.optionalKey(Language),
});

export const ContextAttachment = Schema.Struct({
  type: Schema.Literal("context"),
  name: AttachmentName,
  content: Schema.String,
});

export const Attachment = Schema.Union([FileAttachment, SnippetAttachment, ContextAttachment]);
export type Attachment = typeof Attachment.Type;

/**
 * Text from a peer for one line of the message: every run of control
 * characters or line separators becomes one space, so a name cannot start a
 * line of its own.
 */
export const oneLine = (text: string): string => text.replaceAll(/[\p{Cc}\u2028\u2029]+/gu, " ");

const BACKTICK = 0x60;

/**
 * The length of the longest backtick run in the text. It is one scan, so a
 * text with many runs never becomes the argument list of one call.
 */
const longestBacktickRun = (text: string): number => {
  let longest = 0;
  let run = 0;
  for (let index = 0; index < text.length; index += 1) {
    run = text.charCodeAt(index) === BACKTICK ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
};

/** Text that is empty, or that starts or ends with a backtick or a space, needs a space inside each fence. */
const NEEDS_PADDING = /^$|^[` ]|[` ]$/u;

/**
 * Peer metadata (a name, a folder, a session id) as literal text on one
 * line: one Markdown code span. The text goes through `oneLine`, and the
 * fence is longer than every backtick run in it, so the text cannot end the
 * span, start a line or a row, or add Markdown structure.
 */
export const literal = (text: string): string => {
  const flat = oneLine(text);
  const fence = "`".repeat(longestBacktickRun(flat) + 1);
  const pad = NEEDS_PADDING.test(flat) ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
};

/** The content in a backtick fence longer than every backtick run in it, and at least three. */
const fenced = (content: string, language = ""): string => {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  return `${fence}${language}\n${content}\n${fence}`;
};

/**
 * The labeled block of one attachment. `sentAt` is the send time of the
 * message in epoch milliseconds; only a `file` block shows it.
 */
export const formatAttachment = (attachment: Attachment, sentAt: number): string => {
  const label = `**Attachment (${attachment.type}): ${literal(attachment.name)}**`;
  switch (attachment.type) {
    case "file": {
      const sent = DateTime.formatIso(DateTime.makeUnsafe(sentAt));
      return [
        label,
        `Name and content as the sender gave them, sent ${sent}; freshness unknown.`,
        fenced(attachment.content),
      ].join("\n");
    }
    case "snippet":
      return `${label}\n${fenced(attachment.content, attachment.language)}`;
    case "context":
      return `${label}\n${fenced(attachment.content)}`;
  }
};
