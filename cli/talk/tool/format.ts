/**
 * The text that a receiving session shows for a talk message (#250 E9): the
 * From line, the reply hint of an ask or the ask that a reply answers, the
 * text, and then each attachment as a labeled block.
 */
import { formatAttachment, literal } from "./attachments";
import type { DeliverBody, ReplyBody } from "./protocol";

/** The line that tells the receiver how to answer an ask. */
export const replyHint = (askId: string): string =>
  `This is an ask. Answer it with the talk tool: action "reply", replyTo "${askId}".`;

type MessageParts = Pick<DeliverBody, "from" | "text" | "attachments" | "sentAt">;

const formatMessage = (message: MessageParts, note: string | undefined): string => {
  const head = `**From ${literal(message.from.name)}** (${literal(message.from.cwd)})`;
  const blocks = message.attachments.map((attachment) =>
    formatAttachment(attachment, message.sentAt),
  );
  const lead = [head, ...(note === undefined ? [] : [note]), message.text].join("\n");
  return [lead, ...blocks].join("\n\n");
};

/** The text of a send, or of an ask with its reply hint. */
export const formatDelivery = (body: DeliverBody): string =>
  formatMessage(body, body.ask === undefined ? undefined : replyHint(body.messageId));

/** The text of a reply that reaches the session as a message (E6). */
export const formatReply = (body: ReplyBody): string =>
  formatMessage(body, `Reply to ask ${body.askId}.`);
