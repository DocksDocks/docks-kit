# talk tool

The `talk` extension gives each live omp session one tool, `talk`. With it, a
session lists the other live sessions, sends them messages, asks a question
and waits for the reply, and answers the asks of other sessions. This
document describes the tool, the delivery of a message into a session, the
results, and the known limits. The transport under the tool (registry,
endpoints, handshake, routes) is in `cli/docs/talk-transport.md`.

The source lives in `cli/talk/`, outside the npm `files` list.
`bun cli/scripts/build-talk.ts --out <dir>` builds `<dir>/talk.js`. The kit
plugin does not load `talk` yet: plan DocksDocks/docks-kit#252 does the
cutover from pi-intercom. Plan DocksDocks/docks-kit#250 holds the design
decisions (E1 to E14) that this document names.

## Contents

- [Load](#load)
- [The tool](#the-tool)
- [Targets](#targets)
- [Messages and attachments](#messages-and-attachments)
- [Delivery](#delivery)
- [Results](#results)
- [Queue and busy rules](#queue-and-busy-rules)
- [Transition hold](#transition-hold)
- [Asks and replies](#asks-and-replies)
- [Session scope](#session-scope)
- [Known limits](#known-limits)
- [Source files](#source-files)

## Load

omp loads the default export of `talk.js`, the extension factory. omp calls
the factory once for each session of a module evaluation: for the main
session and for each subagent session. Each such call is a binding.

### Worker threads

omp can run a subagent on a worker thread. A worker thread has its own
`globalThis`, so a binding there registers no tool and no handler, and that
subagent has no `talk` tool.

### Capability probe

The factory checks by type each member of `pi` that `talk` calls:
`pi.registerTool`, `pi.sendMessage`, `pi.on`, `pi.getAllTools`,
`pi.getSessionName`, and the builders `Object`, `String`, `Boolean`,
`Literal`, `Union`, `Array`, and `Optional` of `pi.typebox.Type`. When all
are present, it registers the tools and the event handlers. When one is
missing:

- With a callable `pi.on`, the binding registers only a `session_start`
  handler. That handler shows one notice, which names the missing members and
  omp 19.2.0. A session with a UI (`ctx.hasUI`) gets it through
  `ctx.ui.notify` as a warning; other sessions get it on standard error.
- Without `pi.on`, the binding writes the notice to standard error during the
  load and registers nothing.

Each handler and the tool also check the `ctx` members that they read. A
main session's `session_start` reads `ctx.agent`, `ctx.mode`, `ctx.isIdle`,
`ctx.hasPendingMessages`, `ctx.setInterval`, `ctx.clearTimer`, and
`getSessionId`, `getSessionFile`, `getEntries`, and `getCwd` of
`ctx.sessionManager`. The tool reads `ctx.agent`, `getSessionId`, and
`getCwd`. When one is missing or has the wrong type, that call fails with the
error `talk: this omp gives no valid <members>. talk needs omp 19.2.0 or
later.` `ctx.isIdle()` and `ctx.hasPendingMessages()` must return booleans:
another value fails the delivery with that error instead of a guess, and the
request gets no answer.

### Process singleton

One omp process can evaluate the module several times on its main thread, for
example an ACP process with several sessions. So the process keeps one
singleton under `globalThis[Symbol.for("docks-kit.talk")]`. It holds:

- The transport: one Effect `ManagedRuntime` of `TalkTransport.layer`, with
  the admission hook and the `deliver`, `reply`, and `cancel` handlers. The
  bindings reach it through a plain facade of functions that return promises,
  because the Effect service tags differ per evaluation.
- The registration dispatch: which binding owns each registration.
- The ask store: the waiters of every session of the process, the live
  registration of each main session, and the agent map.
- The sweep (see [Session scope](#session-scope)).

The singleton records the talk protocol version (1) and the docks-kit
package version. A later evaluation uses the singleton only when both
versions are equal. Otherwise that evaluation registers nothing, and the
process writes one notice to standard error: `talk: another version of talk
runs in this omp process, so this one is off until omp restarts.`

The runtime stays until the process exits. So the listener keeps its
authenticated `not-live` answers for registrations that ended.

## The tool

Each binding registers two tools:

- `talk`, label `Talk`: the tool that the model calls.
- `talk_active`: a hidden marker tool with a fixed name and definition. Its
  `execute` only answers that it is internal. The activity check of
  [Session scope](#session-scope) reads its row.

### Fields

| Field         | Used by                 | Value                                                                              |
| ------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `action`      | all                     | `list`, `send`, `ask`, `reply`, `pending`, `status`, or `cancel`                   |
| `to`          | `send`, `ask`, `cancel` | A session name, a full session id, or a session id prefix of at least 4 characters |
| `instance`    | `send`, `ask`, `cancel` | A full instance id: 16 lowercase hex digits                                        |
| `message`     | `send`, `ask`, `reply`  | The text; it must not be blank                                                     |
| `attachments` | `send`, `ask`, `reply`  | A list of `{ type, name, content, language? }`; see [Attachments](#attachments)    |
| `replyTo`     | `reply`                 | The id of the ask to answer                                                        |
| `messageId`   | `cancel`                | The message id from a `send` or `ask` result: 16 lowercase hex digits              |
| `noWake`      | `send`, `ask`, `reply`  | `true` appends the message without a request for a turn                            |

The tool ignores unknown fields. A blank `to` or `instance` counts as unset.
The field rules:

- `send` and `ask` need exactly one of `to` and `instance`.
- `cancel` needs `messageId` and exactly one of `to` and `instance`.
- `reply`, `list`, `pending`, and `status` take neither `to` nor
  `instance`. `reply` takes its target from the ask.

A call that breaks a rule fails before it sends anything. The tool has no
broker, Herdr, cross-machine, `list-cwd`, or `handover` fields.

### Actions

- `list` lists the registry and probes each registration (the authenticated
  ping of the transport), the registration of this session too, which it
  marks `(this session)`. It omits each registration that the probe proves
  ended (`not-live`). It marks each other failure as
  `unresolved: <outcome>`. Each line shows the name, a 4-character instance
  prefix for display only, the first 8 characters of the session id, the
  folder, and the full instance id. Use the full instance id as `instance`.
  When the registry cannot be listed, the call fails. All probes of one call
  go out as one batch of the transport, which reads the socket folder once.
- `send` resolves the target, sends the message, and returns the result of
  [Results](#results).
- `ask` sends the message as an ask and waits for the reply. See
  [Asks and replies](#asks-and-replies).
- `reply` answers an ask that waits for this session.
- `pending` shows the asks that wait for a reply from this session, oldest
  first: the ask id, the sender's name, the first 8 characters of the
  sender's session id, the age in seconds, and the first 80 characters of the
  text on one line. It shows only the asks of this session's current
  registration (see [Reply](#reply)).
- `status` shows this session's name, the first 8 characters of its session
  id, and its folder; its registration (the full instance id, or none); the
  live peer count; the number of queued messages; and the pending asks, as
  `pending` shows them. The live peer count counts the other registrations
  whose probe answered. When the registry cannot be listed, it reads
  `unknown` with the reason.
- `cancel` withdraws a queued message, or reads the current outcome of
  another message. See [Results](#results).

The result of `send`, `ask`, `reply`, and `cancel` names the message id and
the full instance id of the registration that received the request, and the
name of the target when the tool knows it. So the model can cancel with
`instance` and `messageId`, also after the peer renamed itself. Once the body
of a request went out, every failure names the message id and the instance id
too, also a transport failure or an answer that does not decode, because the
target can hold the message.

A call that fails throws an error whose message names the reason, so omp
shows a tool error. Each result also carries `details`: the action and, where
present, the message id, the instance id, and the outcome.

## Targets

### Names

The name of a session is its trimmed session name (`pi.getSessionName()`).
Without one, it is `session-` and the first 8 characters of the session id.
The repair timer publishes a new name or folder within about 1 s (see
[Session scope](#session-scope)).

### `to`

`to` is a discovery selector. It matches against the current listing only,
in this order:

1. The exact name, without regard to case.
2. The full session id.
3. A session id prefix of at least 4 characters. A prefix that starts more
   than one session id is an error: the tool lists the candidates without a
   probe, so the error does not tell which candidate is live, and it sends
   nothing.

One match can hold several registrations, for example two registrations of
one session. The tool then probes each matched registration, because a listed
entry can outlive its registration for a short time. It probes the own
registration of this session too: that registration can have ended since the
tool read it, for example after a persistence move that the repair timer did
not see yet. The outcomes:

| Probe results                                                    | Result                                                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| No listed match                                                  | The call fails with `not-found`                                                                    |
| Every match proven ended (`not-live`)                            | The call fails with `not-live` and lists the candidates                                            |
| Exactly one match answered, and each other match is proven ended | The message goes to that match                                                                     |
| Any other case                                                   | The call fails, lists each candidate with its full instance id and probe result, and sends nothing |

Only `ok` answers, and only `not-live` proves an end. `not-found`,
`auth-failed`, `timeout`, `unreachable`, and `unknown-kind` prove neither.
The probes share the dial limit of the transport: at most 8 connections at a
time to one target process.

### `instance`

`instance` takes only a full instance id and compares it exactly. A name, a
session id, or a prefix never matches, so a session title that equals an
instance id cannot capture it. The tool looks for the id in the listing and
then among the entries that this process kept from an earlier listing or
request (`known` of the transport). An instance id that this process never
saw fails with `not-found`. When the listing fails and this process kept no
entry with that id, the call fails with the listing error instead, because no
lookup proved that the instance is absent. The request itself proves
liveness: a kept target that ended reads `not-live` on the transport's proof,
or another transport failure without one, and the request never reaches a
replacement.

## Messages and attachments

### Message text

Each message has a random message id of 16 lowercase hex digits. The id of an
ask is also its ask id. The receiving session shows the message as a custom
message (`customType` `talk`, displayed, `details.messageId` set) with this
text:

1. `**From <name>** (<cwd>)`, with the name and the folder as literals.
2. For an ask: `This is an ask. Answer it with the talk tool: action "reply",
   replyTo "<ask id>".` For a reply that reaches the session as a message:
   `Reply to ask <ask id>.`
3. The text.
4. Each attachment as a labeled block, after a blank line.

Peer metadata (a name, a folder, or a session id) shows as a literal: one
Markdown code span on one line. Each run of control characters or line
separators becomes one space, and the fence of the span is longer than every
backtick run in the text. So a peer cannot start a line or a row, or add
Markdown structure. The From line, the attachment labels, the reply heading,
the rows of `list`, `pending`, and the candidate lists, and the text preview
of each ask row show peer text this way. An error also shows the `to` or
`replyTo` value of the call as a literal, because a model can copy a peer
name into `to`.

### Size limit

A whole message is at most 512 KiB of UTF-8 JSON, half the 1 MiB frame cap
of the transport. The sender fails a larger message before it sends. The
receiver also refuses one: a body that does not decode gets no answer, the
listener closes the connection, and the sender's request fails at once.

### Attachments

| `type`    | Fields                         | Block                                                                                 |
| --------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| `file`    | `name`, `content`              | The label, a line with the send time and `freshness unknown`, then the fenced content |
| `snippet` | `name`, `content`, `language`? | The label, then the content in a fence with the language                              |
| `context` | `name`, `content`              | The label, then the fenced content                                                    |

The label is `**Attachment (<type>): <name>**`, with the name as a literal.
`name` must not be empty. A
`language` is 1 to 64 characters of letters, digits, and `_ + # . -`. Each
fence is a run of backticks longer than every backtick run in the content,
and at least three.

Attachments are unverified data that the sender supplies. `talk` never reads
a file, at either end. A `file` block shows the name in its label, then the
line `Name and content as the sender gave them,
sent <ISO time>; freshness unknown.`, then the content as the sender gave it.
It gives no instruction to open the named
file, because the name comes from a peer and can point at another checkout or
at a remote target that the receiving model's `read` tool would open without
a prompt. A receiving model can compare the content with a file of its own
only when it can identify the same source itself, for example a shared
checkout. That is its own decision, outside `talk`.

pi-intercom hashes the named file at both ends. `talk` does not: an automatic
read of a path that a peer names must pass the receiving session's own tool
permissions, which an extension cannot evaluate before it touches the file,
and a Windows path can reach a network share and send the user's
credentials.

## Delivery

A `deliver` request reaches the binding that owns the target registration.
The binding runs a synchronous guard in the tick of the send:

1. The registration is the binding's current registration, and the extension
   is active (see [Session scope](#session-scope)). Otherwise: `not-live`.
2. The gate is open (see [Transition hold](#transition-hold)). Otherwise:
   `queued`.
3. `getSessionId()` equals the session id of the registration. Otherwise no
   transition is pending, so this is a change that the extension did not see:
   the result is `not-live`, and the binding withdraws the registration and
   registers the current session id.
4. The session is not busy. Otherwise: `queued` or `busy` (see
   [Queue and busy rules](#queue-and-busy-rules)).
5. No message waits in the queue. Otherwise the message goes behind them:
   `queued`.

A message that would join the queue gets `busy` instead when the queue is
full (see [Queue and busy rules](#queue-and-busy-rules)). That check runs
before the binding keeps a record of the message or a pending ask.

When every check passes, the binding calls `pi.sendMessage` in the same tick.
For an ask, the receiver first retains the route to the reply address (see
[Asks and replies](#asks-and-replies)).

### Wake

Without `noWake`, the message goes out with `triggerTurn: true`, a request
for a turn that omp owns. `talk` sends no separate wake message. On an idle
TUI or RPC session the message becomes the prompt of a new turn. When another
turn claims the session first, omp steers the message into that turn. On the
branch that starts a new turn, omp first runs a usage preflight and drops the
message when the preflight refuses. An ACP session, whose extensions see
`rpc` mode, holds the turn until its next client prompt.

With `noWake`, the message goes out as a plain append without a turn.

### Confirmation

After the send, the binding watches the entries of the session for an entry
with the message id: in each of the next 8 microtask turns, then every 10 ms.
It reads omp's live read-only list `getEntriesView()` where omp has it, else
the copy of `getEntries()`. Each read inspects only the entries that came
after its last read of the same list; another list, or a shorter one, is a
reset, and the binding reads it again from its start. So on a host with the
live list, a watch that runs for minutes does not copy or scan the whole
transcript each 10 ms. The `getEntries()` fallback gives a new array on each
read, so there each read copies and scans the whole transcript. The binding
keeps its read position only while a watch runs, so it holds no list after
the last watch ends. The watch ends:

- `delivered` when the entry appears while `getSessionId()` still equals the
  target session id.
- `not-live` when the session id changes first.
- `unknown` after 10 minutes, or when a read of the session throws.

The request answers `delivered` or `not-live` when the watch ends so within
1 s, and `submitted` otherwise. A watch that ends `unknown` within 1 s, for
example because a read of the session threw, also gives `submitted` to the
request; the receiver keeps `unknown` as the outcome, so a later `cancel`
answers `unknown`. No deadline proves an outcome: omp can wait for deferred
extension loading, refuse or hold a turn-requesting send, or put the send
into its steer queue, which a later `/clear` drops without an event. The
receiver keeps the outcome of each message for `cancel` answers. It keeps at
most 1,024 messages when it can: above that, it drops the oldest final
outcomes first, and a dropped message reads `not-found`.

When `pi.sendMessage` throws, the message reads `unknown`, the request gets
no answer, and the sender's request fails at once.

## Results

### `send` and `ask`

| Outcome          | Meaning                                                                                                                                                     | Call  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `delivered`      | The watch saw the entry in the target session                                                                                                               | ok    |
| `queued`         | `talk` holds the message in the queue of the registration, outside the transcript; `cancel` can withdraw it                                                 | ok    |
| `submitted`      | `talk` handed the message to omp and the append is not confirmed. This is no proof that omp still holds it, and `talk` can no longer withdraw it            | ok    |
| `busy`           | The target is busy and runs one task and exits (`print` or `json` mode), or the queue that `talk` holds for the registration is full; nothing was delivered | fails |
| `not-live`       | The extension is inactive, the session id changed, or the registration ended; nothing was delivered                                                         | fails |
| `no-reply-route` | Only for an ask: the receiver cannot retain the route to the reply address, so it refused the ask                                                           | fails |

A transport failure fails the call with its outcome and reason: `not-live`,
`not-found`, `auth-failed`, `timeout`, `unreachable`, or `unknown-kind`. The
transport has its own section on these outcomes in
`cli/docs/talk-transport.md`.

### `reply`

`reply` has the outcomes of `send`, except `no-reply-route`, and adds
`not-found`: a reply from a subagent's ask that matches no waiter, which the
receiver drops. `delivered` also covers a reply that completed a waiter
without a transcript append, so the tool text says only that the reply
reached the asker. `busy`, `not-live`, and `not-found` fail the call, and the
ask stays pending. Any other outcome removes the ask from the pending asks.

### `cancel`

`cancel` asks the receiver about a message that this session sent to that
registration. The receiver matches the message id, the instance id, and the
sender's session id.

| Outcome     | Meaning                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------- |
| `cancelled` | The message was still queued, and `talk` removed it; it never goes out                       |
| `submitted` | The watch still runs: `talk` handed the message to omp, so it cannot be cancelled            |
| `delivered` | The message is in the session                                                                |
| `not-live`  | The message or its registration ended                                                        |
| `unknown`   | The watch ended without an outcome                                                           |
| `not-found` | The receiver has no message with this id from this session, or the outcome is no longer kept |

Each of these outcomes is a successful call: the text says whether the
message was cancelled. A transport failure fails the call. After the
registration ended, every request, `cancel` included, reads `not-live`.

## Queue and busy rules

A session is busy when `!ctx.isIdle() || ctx.hasPendingMessages()`. The
guard and the queue use the same rule.

- A busy session that stays open (`ctx.mode` is `tui` or `rpc`) queues the
  message. An RPC session, such as a Tern session, has no UI but stays open,
  so it queues too. pi-intercom refuses here (`!hasUI`); `talk` does not.
- A busy session that runs one task and exits (`ctx.mode` is `print` or
  `json`) answers `busy`, unless the message is a reply that matches a
  waiter.
- A closed gate queues the message in every mode.
- A full queue answers `busy` in every mode. The queue of one registration
  holds at most 64 messages and at most 4 MiB of message text (UTF-8). This
  bounds what a peer can make the receiving omp process hold while the
  session cannot take messages. The receiver checks the count first and
  measures the text only of a message that joins the queue.

Each registration has one queue, first in first out, outside the transcript.
The binding tries the queue from a fresh task: once 100 ms after a message
joins an open-gate queue, at once when the gate opens, and then every 100 ms
while messages wait. Each try sends at most the first message, and only when
the extension is active, the session id matches the registration, the gate is
open, and the session is not busy. A session id that differs while the gate
is open is a change that the extension did not see: the binding withdraws the
registration and registers the current id.

When the registration ends, the binding drops its queue, and each dropped
message reads `not-live`.

## Transition hold

omp emits no event when a session transition settles. So the binding holds
messages from each before-event to its after-event.

- Each handler of `session_before_switch`, `session_before_branch`, and
  `session_before_tree` closes the gate while it runs, without a deadline. It
  waits until no send is in flight, that is, until every watch ended, at most
  20 s. It returns without a cancel, so `talk` never vetoes a session change.
- When the handler returns, it leaves a hold. The hold records its event kind
  and, where present, the event's `reason` and the current session file.
- An after-event (`session_switch`, `session_branch`, `session_tree`) removes
  a hold only when exactly one hold matches it. A hold matches by kind, and by
  `reason` and by the event's `previousSessionFile` where both carry them.
  Tree events carry neither. An after-event that matches two holds or none
  removes none.
- Each hold ends at the latest 30 s after its own handler returned, for
  example when a later handler cancelled the transition. The 30 s end is a
  bound, not proof that the transition settled.
- The gate is open only while no before-handler runs and no hold remains.
  Held messages go out from a fresh task after the gate opened, never in the
  task of an after-event, because omp restores its snapshot after the
  after-hook.

A subagent binding has no registration, so it holds nothing.

## Asks and replies

### Ask

An ask carries a reply address and an origin flag:

- A main session uses its own registration, with the flag `main`.
- A subagent session uses the registration of the nearest main session that
  it descends from, with the flag `sub`. Each binding of a subagent records
  its agent id and parent id (`ctx.agent`) in the agent map of the
  singleton at `session_start` and at each `talk` call, and the ask walks
  that map. A main session has no parent, so it has no entry. The map counts
  the subagents of each agent. At `session_shutdown`, the binding releases
  its entry; the map keeps it only while the entry of a live subagent names
  it as parent, and then drops it. The sweep (see [Sweep](#sweep)) releases
  the entry of a binding that omp closed without a `session_shutdown`.

A reply address is live only while it is still the current registration of
its owning binding: that binding is active, and its session id equals the
registered id or a transition is pending. When the walk finds no live
registration, the ask fails at once with `no reply address` and sends
nothing, so a reply never goes to an unrelated session of the process. This
check runs before the tool resolves the target, so it reads no listing and
probes nothing, and the ask store checks the address again when the ask goes
out. A session has at most one waiting ask; a second ask fails at once and
sends nothing.

The waiter starts before the ask goes out, so a fast reply finds it. The
receiver retains the route to the reply address (`retain` of the transport)
before it accepts the ask, so the later reply needs no registry entry of the
asker. When it cannot retain the route, it answers `no-reply-route`, and the
ask fails at once. A `busy` or `not-live` answer also ends the ask at once,
unless the reply already came. After `delivered`, `queued`, or `submitted`,
the call waits until:

- a reply comes: the result shows `**Reply from <name>:**`, with the name as a
  literal, the reply text, its attachment blocks, the message id, and the
  instance id;
- 10 minutes pass: the call fails with the outcome `timeout`; or
- the tool `signal` aborts: the call fails with the outcome `aborted`.

A reply or an abort ends the call also before the acknowledgement of the ask
request arrives, for example when the reply overtakes that acknowledgement. A
request that then fails, or that the receiver refuses, does not undo the
reply. A request that fails while no reply came fails the call with the
outcome of the transport, the ask id, and the instance id, so `cancel` can
still withdraw an ask that the receiver queued.

### Reply

The receiver of an ask keeps it as a pending ask until a successful reply,
the 10-minute ask timeout, or the end of the message (`cancelled` or
`not-live`). A timer of the pending asks ends each ask at its timeout, also
when no call reads them; it runs only while an ask is pending. The pending
asks stay in the order of their deadlines: an ask received again under the
same id goes last, and an ask that comes after the clock stepped back keeps
at least the deadline of the ask before it. So each expiry removes only the
due asks at the front. Each pending ask belongs to the registration that
received it. It stays across an after-event that keeps the session id, and
it ends with that registration: at a withdrawal, at an unseen session id
change, and at `session_shutdown`. A successor session never sees it in
`pending` or `status`, and cannot answer it with `reply`. While a transition
is pending and the session id differs from the registered one, `pending`
shows none of them either.

`reply` picks the ask by `replyTo`, or the only pending ask when `replyTo` is
unset. It fails when `replyTo` names no pending ask, when no ask waits, or
when several asks wait and `replyTo` is unset; the last error lists the asks.

`reply` sends a `reply` request to the reply address of the ask. The body
names the registration that received the ask and repeats the origin flag. At
the asker's process:

1. A reply that matches a waiter by ask id and by the registration that
   received the ask completes the waiting call at once, before the busy rules
   and without a transcript append. The waiters live in the process
   singleton, so the reply finds its waiter through any registration of the
   process.
2. Otherwise a reply with the flag `sub` reads `not-found` and is dropped, at
   any time, also after the ask timed out. It never enters a main session.
3. Otherwise a reply with the flag `main` reaches the session as a message,
   under the delivery rules of a send.

When the reply address ended before the reply, the replier gets the result of
the transport, not a reroute: `not-live` when the transport can prove the
end, otherwise another transport failure. The asker then times out.

A subagent session is never a target, so a subagent receives no ask.

## Session scope

### Registrations

Each binding of a main session (`ctx.agent.kind` is `main`) owns at most one
registration, its own. One process can hold several main sessions, and two
bindings can hold the same session id; each binding then owns its own
registration. A subagent binding has the `talk` tool but no registration, no
timer, and no hold.

A main binding registers at `session_start` with its name and folder
(`ctx.sessionManager.getCwd()`), when the extension is active and the gate is
open. When the registration fails, the binding shows a notice with the
reason, but not the same notice twice in a row, and the repair timer tries
again.

After-events:

- `session_tree` keeps the registration, its queue, and its pending asks.
- A `session_switch` or `session_branch` that leaves `getSessionId()` equal
  to the registered id keeps them too, for example a resume of the current
  session file.
- A `session_switch` or `session_branch` that changes the id withdraws the
  old registration, whose queued messages read `not-live` and whose pending
  asks end, and registers the new id from a fresh task once the gate is open.

`session_shutdown` stops the binding's timer and withdraws its registration.
The listener stays open until the process exits.

### Activity check

The extension of a binding is active while `pi.getAllTools()` holds a row
named `talk_active` whose `parameters` is the very object that this binding
passed to `pi.registerTool`, and whose `sourceInfo.path` equals the path that
the same row showed at the first `session_start` of the binding. The factory
cannot read the row, because `getAllTools()` throws while omp loads the
factory. A placeholder path (`<...>`) at `session_start` leaves the binding
without a registration until the repair timer reads a real path. omp resolves
the path through the current runner, so a suspended extension fails the
check even before omp removes its rows. Another extension that replaces the
public `talk` row does not change the check. A check that throws counts as
inactive.

### Admission

The listener asks the singleton in the tick that it admits a request for a
registration, `ping` included. It admits the request only while the owning
binding is active and `getSessionId()` equals the registered id or a
transition is pending. A refusal answers `not-live` and withdraws the
registration at once. When the refusal comes from a changed session id, the
binding registers the current id from a fresh task. A registration that is
still starting, between the `register` call and its claim, is admitted while
its binding is active. The binding chooses the instance id of that
registration before it calls `register`, so the starting record names the
exact pair; a request for another registration of the same session id, with
no owner and no starting record of its own, is refused.

### Repair timer

Each main binding runs a 1 s timer (`ctx.setInterval`; timers run while the
extension is suspended). The timer:

- withdraws the registration while the extension is inactive;
- registers the current session id when the extension is active and the
  binding has no registration;
- withdraws the registration and registers the current id when the session
  id differs and no transition is pending, for example after a persistence
  move or a transition while the extension was suspended;
- calls the transport's `update` when the session name or folder changed, so
  a sender's kept entry stays valid.

A suspension that starts and ends between two samples, meets no request, and
leaves the session id unchanged keeps the registration.

### Sweep

The singleton runs a 1 s sweep that no binding owns: a raw `setInterval` that
is `unref`'d and that catches every error in its callback. It withdraws every
registration of the process whose binding fails its activity check. So the
registration of a binding that omp closed while the extension was suspended,
whose own handler and timer no longer run, is withdrawn even when no other
binding remains and no request comes. The sweep also releases the agent map
entry of each subagent binding whose marker row omp no longer lists (see
[Ask](#ask)). A binding that omp only suspended adds its entry again at its
next `talk` call; until then, an ask of a later subagent of it can fail with
`no reply address`.

## Known limits

omp emits no event when a session transition settles, and its events do not
name their transition. The hold of [Transition hold](#transition-hold) covers
each before-event to its after-event, or at most 30 s. A message that goes
out while a transition is still unsettled can be lost from the live history
or from the transcript, stay only in the replaced transcript, or land in the
successor. Its result can then read `delivered`, `not-live`, or `submitted`
wrongly. The cases:

- A transition that outlasts the 30 s bound.
- Another extension's after-hook that waits for a task boundary.
- A send that is still unconfirmed when a before-handler stops waiting after
  20 s.
- A send that omp defers past its task while it loads deferred extensions.
- A turn-requesting send that a transition overtakes after omp's usage
  preflight: omp checks the session generation only for a send that waits
  for a context replacement.
- An after-event that ends the hold of another transition. Tree events carry
  neither `reason` nor a session file. When the extension missed the
  before-event of a nested transition while it was suspended and resumed
  before its after-event, that after-event can match the outer transition's
  only hold and open the gate before the outer transition settles.

Other limits:

- A resume that rolls back after its `session_switch` already withdrew the
  old registration: its held messages read `not-live`, and the restored
  session registers again under a new instance id.
- A withdrawal blocks new requests and drops the queue that `talk` holds, but
  it cannot take back a payload that omp already has, for example one in its
  steer queue or one whose usage preflight still runs. That payload can still
  land in the same transcript, and start a turn there, while `talk` is
  suspended or after the same session id registers again.
- A persistence move during an append reports `not-live`, while the sibling
  session keeps the message.
- A `/clear` drops queued steers without an event, so a `submitted` message
  can be lost.
- A message to an idle ACP peer waits for that peer's next client prompt. It
  reads `delivered` only when a prompt appends it within 1 s, else
  `submitted`; an ask to it can time out before the prompt comes.

## Source files

| File                           | Holds                                                                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli/talk/index.ts`            | The bundle entry: it default-exports the factory and keeps the transport exports                                                                                              |
| `cli/talk/extension.ts`        | The factory: the capability probe, the process singleton and its transport facade, the sweep, and the binding of each session; the only file of `cli/talk/` that runs effects |
| `cli/talk/tool/protocol.ts`    | The request kinds `deliver`, `reply`, and `cancel`, their body and result Schemas, and the 512 KiB message limit                                                              |
| `cli/talk/tool/targets.ts`     | Session names, the field rules of each action, and the target selection of `to` and `instance`                                                                                |
| `cli/talk/tool/format.ts`      | The text of a delivered message and of a reply that reaches a session as a message                                                                                            |
| `cli/talk/tool/attachments.ts` | The attachment Schemas and their labeled blocks                                                                                                                               |
| `cli/talk/tool/host.ts`        | The host interface that `extension.ts` fills from `pi` and `ctx`, the clock, and the talk entry check of `getEntries()`                                                       |
| `cli/talk/tool/delivery.ts`    | The receiver of one binding: the transition hold, the guard, the confirmation watch, the queue, `cancel`, and the request handlers                                            |
| `cli/talk/tool/asks.ts`        | The ask store of the process (waiters, reply addresses, the agent map) and the pending inbound asks of one session                                                            |
| `cli/talk/tool/tool.ts`        | The `talk` tool: its parameters, its seven actions, and the text of each result                                                                                               |
| `cli/talk/transport/`          | The transport; see `cli/docs/talk-transport.md`                                                                                                                               |
