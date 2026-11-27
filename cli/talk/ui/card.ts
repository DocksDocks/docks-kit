/**
 * The message card of a talk message (plan #251 G5). The factory registers
 * the renderer for the `talk` custom type. omp calls it for each draw and
 * again when the card is expanded or collapsed. The card shows the header
 * `talk <kind> from <name> · <folder> · <HH:MM>`, then the reply hint of an
 * ask or the ask that a reply answers, the attachment names, and the body.
 *
 * The renderer returns undefined for a message whose details do not decode,
 * such as a message of #250, so omp draws its default card with the text.
 * Every peer string passes the #250 cleaners: one-line fields go through
 * `literal`, and each body line goes through `oneLine`, so no peer text can
 * add a line to the header or send a control character to the terminal.
 */
import { DateTime, Predicate } from "effect";

import type { JSXNode } from "@oh-my-pi/pi-tui";

import { literal, oneLine } from "../tool/attachments";
import { replyHint, replyNote } from "../tool/format";
import { type TalkDetails, decodeTalkMessage } from "../tool/host";
import type { HostUi } from "./host";

/** The body lines that a collapsed card shows. */
export const COLLAPSED_BODY_LINES = 3;

/** `pi.registerMessageRenderer` gets `(message, { expanded }, theme)` (F3). */
export type TalkCardRenderer = (
  message: unknown,
  options: unknown,
  theme: unknown,
) => JSXNode | undefined;

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/u;

/** The note under the header: the reply hint of an ask, or the ask that a reply answers. */
const noteOf = (details: TalkDetails): string | undefined => {
  if (details.askId === undefined) return undefined;
  return details.kind === "ask" ? replyHint(details.askId) : replyNote(details.askId);
};

/** The renderer of the message card, built with the loaded `jsx` of omp. */
export const makeTalkCardRenderer = (ui: HostUi): TalkCardRenderer => {
  const zone = DateTime.zoneMakeLocal();
  const dim = (text: string): JSXNode => ui.jsx("text", { spans: [{ t: text, s: "dim" }] });

  return (message, options) => {
    const decoded = decodeTalkMessage(message);
    if (decoded === undefined) return undefined;
    const { content, details } = decoded;
    const expanded = Predicate.hasProperty(options, "expanded") && options.expanded === true;
    const sent = DateTime.toParts(DateTime.makeZonedUnsafe(details.sentAt, { timeZone: zone }));
    const head = [
      `talk ${details.kind} from ${literal(details.from.name)}`,
      literal(details.from.cwd),
      `${String(sent.hour).padStart(2, "0")}:${String(sent.minute).padStart(2, "0")}`,
    ].join(" · ");
    const body = content.slice(details.body.start, details.body.end);
    const lines = body === "" ? [] : body.split(LINE_BREAK).map(oneLine);
    const shown = expanded ? lines : lines.slice(0, COLLAPSED_BODY_LINES);
    const hidden = lines.length - shown.length;
    const note = noteOf(details);
    const children = [
      ...(note === undefined ? [] : [dim(note)]),
      ...details.attachments.map((attachment) =>
        dim(`Attachment (${attachment.kind}): ${literal(attachment.name)}`),
      ),
      ...(shown.length === 0 ? [] : [ui.jsx("text", { text: shown.join("\n") })]),
      ...(hidden === 0 ? [] : [dim(`… ${hidden} more lines`)]),
    ];
    return ui.jsx("card", { head, children });
  };
};
