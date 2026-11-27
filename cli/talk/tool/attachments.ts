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

/** CRLF, a lone CR, and the Unicode line and paragraph separators. */
const LINE_BREAKS = /\r\n?|[\u2028\u2029]/gu;
/** Each control character except the line feed and the tab. */
const OTHER_CONTROL = /[^\P{Cc}\n\t]/gu;

const ESC = 0x1b;
const BEL = 0x07;
const BACKSLASH = 0x5c;
const LEFT_BRACKET = 0x5b;
/** The C1 forms of CSI and of ST, the end of a string command. */
const CSI_C1 = 0x9b;
const ST_C1 = 0x9c;
/** The string commands OSC, DCS, SOS, PM, and APC: their letters after ESC, and their C1 forms. */
const STRING_AFTER_ESC = new Set([0x5d, 0x50, 0x58, 0x5e, 0x5f]);
const STRING_C1 = new Set([0x9d, 0x90, 0x98, 0x9e, 0x9f]);

const within = (code: number, low: number, high: number): boolean => code >= low && code <= high;

/** The index after the run of code units in `[low, high]` from `index`. */
const skipRange = (text: string, index: number, low: number, high: number): number => {
  let end = index;
  while (within(text.charCodeAt(end), low, high)) end += 1;
  return end;
};

/** The end of a CSI sequence whose parameters start at `body`: parameters, intermediates, and a final byte. */
const csiEnd = (text: string, body: number): number => {
  const final = skipRange(text, skipRange(text, body, 0x30, 0x3f), 0x20, 0x2f);
  return within(text.charCodeAt(final), 0x40, 0x7e) ? final + 1 : body;
};

/**
 * The end of a string command whose text starts at `body`: after BEL, ST, or
 * ESC `\`. An ESC that starts no ST ends the command before it, so that ESC
 * starts the next sequence. A command without an end takes the rest of the
 * text. So the cleaner reads each code unit a small, fixed number of times,
 * also in malformed input: an ESC that ends a command is read again as the
 * start of the next sequence (R2).
 */
const stringEnd = (text: string, body: number): number => {
  for (let index = body; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === BEL || code === ST_C1) return index + 1;
    if (code === ESC) return text.charCodeAt(index + 1) === BACKSLASH ? index + 2 : index;
  }
  return text.length;
};

/**
 * The end of the terminal escape sequence at `start`, in its 7-bit or its C1
 * form: a CSI sequence, a string command with its end, or a two-character
 * escape. A CSI or a two-character escape that does not complete loses only
 * its introducer, so the text after it stays.
 */
const sequenceEnd = (text: string, start: number): number => {
  const first = text.charCodeAt(start);
  if (first === CSI_C1) return csiEnd(text, start + 1);
  if (STRING_C1.has(first)) return stringEnd(text, start + 1);
  const second = text.charCodeAt(start + 1);
  if (second === LEFT_BRACKET) return csiEnd(text, start + 2);
  if (STRING_AFTER_ESC.has(second)) return stringEnd(text, start + 2);
  const final = skipRange(text, start + 1, 0x20, 0x2f);
  return within(text.charCodeAt(final), 0x30, 0x7e) ? final + 1 : start + 1;
};

/**
 * Text for a multiline field, such as the handover draft (#251 T1): each
 * line break becomes a line feed, and each escape sequence and each other
 * control character except the tab goes, so the text cannot drive the
 * terminal.
 */
export const safeMultiline = (text: string): string => {
  const source = text.replaceAll(LINE_BREAKS, "\n");
  const kept: Array<string> = [];
  let from = 0;
  let index = 0;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (code === ESC || code === CSI_C1 || STRING_C1.has(code)) {
      kept.push(source.slice(from, index));
      index = sequenceEnd(source, index);
      from = index;
    } else index += 1;
  }
  kept.push(source.slice(from));
  return kept.join("").replaceAll(OTHER_CONTROL, "");
};

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
