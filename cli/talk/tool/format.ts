/**
 * The text that a receiving session shows for a talk message (#250 E9): the
 * From line, the reply hint of an ask or the ask that a reply answers, the
 * text, and then each attachment as a labeled block. With the text comes the
 * range of the sender's text in it, for the message card (#251 G5).
 */
import { formatAttachment, literal } from "./attachments";
import type { DeliverBody, ReplyBody } from "./protocol";

/** The line that tells the receiver how to answer an ask. */
export const replyHint = (askId: string): string =>
  `This is an ask. Answer it with the talk tool: action "reply", replyTo "${askId}".`;

/** The line that names the ask that a reply answers. */
export const replyNote = (askId: string): string => `Reply to ask ${askId}.`;

/** A range of UTF-16 code units: `content.slice(start, end)`. */
export interface BodyRange {
  readonly start: number;
  readonly end: number;
}

/** The message text and the range of the sender's text in it. */
export interface FormattedMessage {
  readonly content: string;
  readonly body: BodyRange;
}

type MessageParts = Pick<DeliverBody, "from" | "text" | "attachments" | "sentAt">;

const formatMessage = (message: MessageParts, note: string | undefined): FormattedMessage => {
  const head = `**From ${literal(message.from.name)}** (${literal(message.from.cwd)})`;
  const lead = note === undefined ? `${head}\n` : `${head}\n${note}\n`;
  const blocks = message.attachments.map((attachment) =>
    formatAttachment(attachment, message.sentAt),
  );
  const content = [`${lead}${message.text}`, ...blocks].join("\n\n");
  return { content, body: { start: lead.length, end: lead.length + message.text.length } };
};

/** The text of a send, or of an ask with its reply hint. */
export const formatDelivery = (body: DeliverBody): FormattedMessage =>
  formatMessage(body, body.ask === undefined ? undefined : replyHint(body.messageId));

/** The text of a reply that reaches the session as a message (E6). */
export const formatReply = (body: ReplyBody): FormattedMessage =>
  formatMessage(body, replyNote(body.askId));
