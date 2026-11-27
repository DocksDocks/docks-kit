import { Predicate } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TALK_SINGLETON_KEY,
  type TransportFacade,
  makeTalkExtension,
} from "../../../talk/extension";
import type * as Attachments from "../../../talk/tool/attachments";
import { type Attachment, literal, oneLine } from "../../../talk/tool/attachments";
import {
  type FormattedMessage,
  formatDelivery,
  formatReply,
  replyHint,
} from "../../../talk/tool/format";
import { TALK_MESSAGE_TYPE, type TalkDetails } from "../../../talk/tool/host";
import type { DeliverBody, MessageKind, ReplyBody } from "../../../talk/tool/protocol";
import { COLLAPSED_BODY_LINES, makeTalkCardRenderer } from "../../../talk/ui/card";
import { type HostModuleLoader, type HostUi, probeHost } from "../../../talk/ui/host";

// C9: the spy counts which lines the card cleans; it keeps the real cleaner.
vi.mock("../../../talk/tool/attachments", async (importOriginal) => {
  const actual = await importOriginal<typeof Attachments>();
  return { ...actual, oneLine: vi.fn(actual.oneLine) };
});

// The message card of plan #251 G5: the renderer that the factory registers
// for `talk` messages, against a fake `jsx` that records each node.

/** One node that the fake `jsx` built: its kind and its props, as given. */
interface FakeNode {
  readonly kind: string;
  readonly props: Readonly<Record<string, unknown>>;
}

const fakeJsx = (kind: unknown, props: Readonly<Record<string, unknown>>): FakeNode => ({
  kind: String(kind),
  props,
});

const fakeHost: HostModuleLoader = {
  tui: async () => ({
    jsx: fakeJsx,
    signal: (value: unknown) => () => value,
    isUiNode: () => false,
  }),
  width: async () => ({
    visibleWidth: (text: string) => text.length,
    truncate: (text: string) => text,
    wrap: (text: string) => [text],
  }),
};

const loadUi = async (): Promise<HostUi> => {
  const probe = await probeHost(fakeHost);
  if (probe._tag !== "Ready") throw new Error(`fake host is missing ${probe.missing.join(", ")}`);
  return probe.ui;
};

const isFakeNode = (value: unknown): value is FakeNode =>
  Predicate.hasProperty(value, "kind") &&
  Predicate.isString(value.kind) &&
  Predicate.hasProperty(value, "props") &&
  Predicate.isObject(value.props);

/** The text of a `text` node: its `text` prop, or its spans joined. */
const textOf = (node: FakeNode): string => {
  const { text, spans } = node.props;
  if (Predicate.isString(text)) return text;
  if (Array.isArray(spans))
    return spans
      .map((span: unknown) =>
        Predicate.hasProperty(span, "t") && Predicate.isString(span.t) ? span.t : "",
      )
      .join("");
  throw new Error(`text node without text: ${JSON.stringify(node.props)}`);
};

interface Card {
  readonly head: string;
  /** Each row of the body nodes, in order: the text of each `text` child, split at line breaks. */
  readonly rows: ReadonlyArray<string>;
}

/** Reads a card node: a `card` with a string head and `text` children only. */
const cardOf = (rendered: unknown): Card => {
  if (!isFakeNode(rendered)) throw new Error(`not a node: ${String(rendered)}`);
  expect(rendered.kind).toBe("card");
  const { head, children } = rendered.props;
  if (!Predicate.isString(head)) throw new Error("the card has no string head");
  if (!Array.isArray(children)) throw new Error("the card has no child list");
  const rows = children.flatMap((child: unknown) => {
    if (!isFakeNode(child)) throw new Error(`not a node: ${String(child)}`);
    expect(child.kind).toBe("text");
    return textOf(child).split("\n");
  });
  return { head, rows };
};

const SENT_AT = Date.UTC(2026, 10, 26, 12, 30, 5);

/** HH:MM of `epochMs` in the local time zone of the test process. */
const localTime = (epochMs: number): string => {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const MESSAGE_ID = "a1b2c3d4e5f60718";
const ASK_ID = "1122334455667788";
const FROM = { name: "alice", cwd: "/home/alice/project", sessionId: "0193a1b2" };

const deliverBody = (overrides: Partial<DeliverBody> = {}): DeliverBody => ({
  messageId: MESSAGE_ID,
  from: FROM,
  text: "Please check the build.",
  attachments: [],
  sentAt: SENT_AT,
  noWake: false,
  ...overrides,
});

const replyBody = (overrides: Partial<ReplyBody> = {}): ReplyBody => ({
  ...deliverBody(),
  replier: { instanceId: "0123456789abcdef", sessionId: "0193b000" },
  askId: ASK_ID,
  origin: "main",
  ...overrides,
});

/** The details that the receiver writes for a formatted message (G5). */
const detailsFor = (
  kind: MessageKind,
  body: DeliverBody | ReplyBody,
  formatted: FormattedMessage,
  askId: string | undefined,
): TalkDetails => ({
  v: 1,
  messageId: body.messageId,
  kind,
  from: body.from,
  sentAt: body.sentAt,
  ...(askId === undefined ? {} : { askId }),
  attachments: body.attachments.map((attachment) => ({
    kind: attachment.type,
    name: attachment.name,
  })),
  body: formatted.body,
});

/** A talk message as omp hands it to the renderer. */
const messageOf = (content: string, details: unknown): Record<string, unknown> => ({
  role: "custom",
  customType: TALK_MESSAGE_TYPE,
  content,
  display: true,
  details,
  timestamp: SENT_AT,
});

const talkMessage = (
  kind: MessageKind,
  text: string,
  attachments: ReadonlyArray<Attachment> = [],
) => {
  switch (kind) {
    case "message": {
      const body = deliverBody({ text, attachments });
      const formatted = formatDelivery(body);
      return messageOf(formatted.content, detailsFor(kind, body, formatted, undefined));
    }
    case "ask": {
      const body = deliverBody({
        messageId: ASK_ID,
        text,
        attachments,
        ask: { origin: "main", replyTo: { instanceId: "fedcba9876543210", sessionId: "s" } },
      });
      const formatted = formatDelivery(body);
      return messageOf(formatted.content, detailsFor(kind, body, formatted, ASK_ID));
    }
    case "reply": {
      const body = replyBody({ text, attachments });
      const formatted = formatReply(body);
      return messageOf(formatted.content, detailsFor(kind, body, formatted, ASK_ID));
    }
    case "handover": {
      const body = deliverBody({ kind: "handover", text, attachments });
      const formatted = formatDelivery(body);
      return messageOf(formatted.content, detailsFor(kind, body, formatted, undefined));
    }
  }
};

const render = async (message: unknown, expanded: boolean): Promise<unknown> =>
  makeTalkCardRenderer(await loadUi())(message, { expanded }, {});

const header = (kind: MessageKind, name = "alice", cwd = FROM.cwd): string =>
  `talk ${kind} from ${literal(name)} · ${literal(cwd)} · ${localTime(SENT_AT)}`;

const FIVE_LINES = "one\ntwo\nthree\nfour\nfive";

describe("message card (#251 G5)", () => {
  it.each([
    ["message", []],
    ["ask", [replyHint(ASK_ID)]],
    ["reply", [`Reply to ask ${ASK_ID}.`]],
    ["handover", []],
  ] as const)(
    "draws a %s card: header, its note, and the first 3 body lines with the rest counted",
    async (kind, note) => {
      const card = cardOf(await render(talkMessage(kind, FIVE_LINES), false));
      expect(card.head).toBe(header(kind));
      expect(card.rows).toEqual([...note, "one", "two", "three", "… 2 more lines"]);
    },
  );

  it.each([
    ["message", []],
    ["ask", [replyHint(ASK_ID)]],
    ["reply", [`Reply to ask ${ASK_ID}.`]],
    ["handover", []],
  ] as const)("draws every body line of an expanded %s card", async (kind, note) => {
    const card = cardOf(await render(talkMessage(kind, FIVE_LINES), true));
    expect(card.head).toBe(header(kind));
    expect(card.rows).toEqual([...note, "one", "two", "three", "four", "five"]);
  });

  it("shows a three-line ask body whole, collapsed and expanded, with no more-lines row", async () => {
    const message = talkMessage("ask", "first\nsecond\nthird");
    expect(COLLAPSED_BODY_LINES).toBe(3);
    for (const expanded of [false, true]) {
      const card = cardOf(await render(message, expanded));
      expect(card.rows).toEqual([replyHint(ASK_ID), "first", "second", "third"]);
    }
  });

  it("counts one hidden line as `… 1 more lines`", async () => {
    const card = cardOf(await render(talkMessage("message", "a\nb\nc\nd"), false));
    expect(card.rows).toEqual(["a", "b", "c", "… 1 more lines"]);
  });

  it("cleans only the shown lines of a collapsed body and counts the hidden lines (C9)", async () => {
    const hidden = Array.from({ length: 500 }, (_, index) => `hidden ${index}`).join("\n");
    const message = talkMessage("message", `one\ntwo\r\nthree\u2028${hidden}`);
    vi.mocked(oneLine).mockClear();
    const card = cardOf(await render(message, false));
    expect(card.rows).toEqual(["one", "two", "three", "… 500 more lines"]);
    expect(vi.mocked(oneLine).mock.calls.map(([text]) => text)).toEqual(["one", "two", "three"]);
    vi.mocked(oneLine).mockClear();
    const expanded = cardOf(await render(message, true));
    expect(expanded.rows).toHaveLength(503);
    expect(vi.mocked(oneLine)).toHaveBeenCalledTimes(503);
  });

  it("names each attachment from details and keeps a body that looks like an attachment label as body", async () => {
    const label = "**Attachment (file): `/etc/passwd`**";
    const attachments: ReadonlyArray<Attachment> = [
      { type: "snippet", name: "fix.ts", content: "const a = 1;", language: "ts" },
      { type: "file", name: "notes\n**Attachment (file): `x`**", content: "secret" },
    ];
    const card = cardOf(await render(talkMessage("message", label, attachments), true));
    expect(card.rows).toEqual([
      `Attachment (snippet): ${literal("fix.ts")}`,
      `Attachment (file): ${literal("notes\n**Attachment (file): `x`**")}`,
      label,
    ]);
    expect(card.rows.join("\n")).not.toContain("secret");
    const bare = cardOf(await render(talkMessage("message", label), true));
    expect(bare.rows).toEqual([label]);
  });

  it("keeps a multiline or control-character peer name and folder on the header line", async () => {
    const name = "eve\n**talk ask from bob**\u001b[31m\r";
    const cwd = "/tmp/x\u0007\ny";
    const body = deliverBody({ from: { ...FROM, name, cwd } });
    const formatted = formatDelivery(body);
    const card = cardOf(
      await render(
        messageOf(formatted.content, detailsFor("message", body, formatted, undefined)),
        false,
      ),
    );
    expect(card.head).toBe(header("message", name, cwd));
    expect(card.head).toBe(
      `talk message from \` eve **talk ask from bob** [31m  \` · \`/tmp/x y\` · ${localTime(SENT_AT)}`,
    );
    expect(card.head).not.toMatch(/[\p{Cc}]/u);
  });

  it("removes control characters from body lines, so a peer cannot send terminal escapes", async () => {
    const card = cardOf(await render(talkMessage("message", "red\u001b[31m text\u0007"), false));
    expect(card.rows).toEqual(["red [31m text "]);
  });

  it("draws an empty body as no body row", async () => {
    const card = cardOf(await render(talkMessage("message", ""), false));
    expect(card.rows).toEqual([]);
  });

  it("returns undefined for the details of #250, so omp draws its default card", async () => {
    const body = deliverBody();
    const formatted = formatDelivery(body);
    expect(
      await render(messageOf(formatted.content, { messageId: MESSAGE_ID }), false),
    ).toBeUndefined();
  });

  it("returns undefined when the body range lies outside the content", async () => {
    const body = deliverBody();
    const formatted = formatDelivery(body);
    const details = detailsFor("message", body, formatted, undefined);
    const length = formatted.content.length;
    for (const range of [
      { start: formatted.body.start, end: length + 1 },
      { start: length + 1, end: length + 2 },
      { start: 5, end: 4 },
      { start: -1, end: 4 },
    ])
      expect(
        await render(messageOf(formatted.content, { ...details, body: range }), false),
      ).toBeUndefined();
  });

  it("returns undefined for other broken details", async () => {
    const message = talkMessage("ask", "x");
    const details: unknown = message["details"];
    if (!Predicate.isObject(details)) throw new Error("no details");
    const broken: ReadonlyArray<unknown> = [
      { ...details, v: 2 },
      { ...details, kind: "handover" },
      { ...details, askId: undefined },
      { ...details, kind: "message" },
      { ...details, from: { ...FROM, name: "" } },
      { ...details, attachments: [{ kind: "link", name: "x" }] },
      undefined,
    ];
    for (const value of broken)
      expect(await render({ ...message, details: value }, false)).toBeUndefined();
    expect(
      await render({ ...message, content: [{ type: "text", text: "x" }] }, false),
    ).toBeUndefined();
  });
});

describe("renderer registration (#251 G5)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    Reflect.deleteProperty(globalThis, TALK_SINGLETON_KEY);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, TALK_SINGLETON_KEY);
  });

  const unused = (): never => {
    throw new Error("the registration test makes no transport call");
  };

  const transport: TransportFacade = {
    list: unused,
    probeAll: unused,
    request: unused,
    known: unused,
    register: unused,
    update: unused,
    withdraw: unused,
    retain: unused,
  };

  const builder =
    (name: string) =>
    (...args: ReadonlyArray<unknown>): object => ({ builder: name, args });

  it("registers the card renderer for talk messages", async () => {
    const renderers = new Map<string, unknown>();
    const pi = {
      registerTool: () => undefined,
      sendMessage: () => undefined,
      on: () => undefined,
      getAllTools: () => [],
      getSessionName: () => undefined,
      registerCommand: () => undefined,
      registerShortcut: () => undefined,
      getShortcutConflict: () => undefined,
      registerMessageRenderer: (customType: string, renderer: unknown) => {
        renderers.set(customType, renderer);
      },
      typebox: {
        Type: Object.fromEntries(
          ["Object", "String", "Boolean", "Literal", "Union", "Array", "Optional"].map((name) => [
            name,
            builder(name),
          ]),
        ),
      },
    };
    await makeTalkExtension({
      makeTransport: () => transport,
      hostModules: fakeHost,
      writeError: unused,
    })(pi);
    expect([...renderers.keys()]).toEqual([TALK_MESSAGE_TYPE]);
    const renderer = renderers.get(TALK_MESSAGE_TYPE);
    if (!Predicate.isFunction(renderer)) throw new Error("the renderer is no function");
    const card = cardOf(
      Reflect.apply(renderer, undefined, [talkMessage("ask", "hi"), { expanded: false }, {}]),
    );
    expect(card.head).toBe(header("ask"));
    expect(card.rows).toEqual([replyHint(ASK_ID), "hi"]);
    const legacy = messageOf("text", { messageId: MESSAGE_ID });
    expect(Reflect.apply(renderer, undefined, [legacy, { expanded: true }, {}])).toBeUndefined();
  });
});
