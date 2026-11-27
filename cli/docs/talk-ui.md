# talk UI

The `talk` extension gives an interactive omp session a `/talk` command, the
shortcut `alt+t`, views to list sessions, write a message, and confirm its
destination, a card for each talk message, and handover. This document
describes them. The `talk` tool, the delivery of a message, and the results
are in `cli/docs/talk-tool.md`. The transport is in
`cli/docs/talk-transport.md`.

The source lives in `cli/talk/ui/`, outside the npm `files` list. Plan
DocksDocks/docks-kit#251 holds the design decisions (G1 to G9) that this
document names. The kit plugin ships `talk` (plan DocksDocks/docks-kit#252).

## Contents

- [Modes](#modes)
- [The /talk command](#the-talk-command)
- [Flows](#flows)
- [List view](#list-view)
- [Compose view](#compose-view)
- [Confirm view](#confirm-view)
- [Keys](#keys)
- [Shortcut](#shortcut)
- [Message cards](#message-cards)
- [Handover](#handover)
- [UI host probe](#ui-host-probe)
- [Known limits](#known-limits)
- [Source files](#source-files)

## Modes

The views work only when `ctx.mode` is `tui`: omp in a terminal, or omp in a
Tern pane. Tern runs omp in TUI mode and draws its UI over the Tern Surface
Protocol, so the views show natively there.

In the modes `rpc` (RPC and ACP clients), `print`, and `json`, `/talk` and
`alt+t` open no view. Each call shows this notice:

```text
talk: the /talk views need an interactive omp session in a terminal or in Tern. The talk tool works in every mode, except its handover action, which needs such a session too.
```

A session with a UI (`ctx.hasUI`) gets the notice through `ctx.ui.notify` as
a warning. Other sessions get it on standard error. The `talk` tool works in
every mode, except its `handover` action: that action starts a flow, so it
refuses outside mode `tui` (see [Handover](#handover)).

When the host gives no `ctx.ui.custom` or no `ctx.ui.notify`, `/talk` shows a
notice that names the two methods and omp 19.2.0, and opens no view.

## The /talk command

| Form                      | Effect                                                        |
| ------------------------- | ------------------------------------------------------------- |
| `/talk`                   | Opens the [list view](#list-view); Enter composes a message   |
| `/talk <target>`          | Opens the [compose view](#compose-view) for that target       |
| `/talk handover <target>` | Starts a [handover](#handover) to that target                 |
| `/talk handover`          | Opens the list view in handover mode; Enter starts a handover |

`h` in the list that `/talk` or `alt+t` opens also starts a handover to the
selected row.

The command trims its argument text. The word `handover` as the first word
always starts the sub-command, and the rest of the text is the target. Every
other text is one target, so a session name with spaces works. The reserved
word stops only the targeting by name: a session whose name starts with the
word `handover` gets a message from the list, or from `/talk <session id>`
or a session id prefix that resolves to it.

A target resolves with the rules of the tool field `to`: the exact name
without regard to case, the full session id, or a session id prefix of at
least 4 characters (see `cli/docs/talk-tool.md`, "Targets"). The target
resolves to exactly one registration pair before a view opens or a side turn
starts. When it does not resolve, the flow shows the error of the resolver
and opens no view.

### Completion

omp asks for completions synchronously and gives no context, so the
completion reads a snapshot: the names of the last listing of the binding.
Each listing of the binding (`listSessions`: the `list` action of the tool
and the list view) refreshes the snapshot with its probed rows, so a name
whose probe proved an end is not offered. A target resolution probes only
its matches, so it does not refresh the snapshot. When two listings overlap,
only the one that started last refreshes it. The snapshot is empty until the
first listing.

- The completion offers `handover` while the argument text is a start of
  `handover`.
- It offers each name of the snapshot that starts with the argument text. A
  name whose first word is `handover` is left out, because `/talk` would read
  it as the sub-command.
- After `handover` and a space, it offers each name that starts with the rest
  of the text, as a handover target.
- It offers only a name that is not empty, has no outer spaces, and has no
  control character or line separator. It offers each name once.
- It returns no list when nothing matches.

## Flows

A flow is one run of `/talk`, of `alt+t`, or of the `handover` action of the
`talk` tool: a listing or a target resolution, the views, and at most one
send. Each binding has one flow slot, so it runs at most one flow at a time.
A flow belongs to the session id of the context that started it.

A flow ends:

- when another flow starts in the same binding, from the command or from the
  shortcut. The `handover` action never ends an open flow: it refuses while
  one is open;
- when the tool call that started it is aborted;
- at `session_before_switch`, `session_before_branch`, `session_before_tree`,
  `session_clear` (an in-place reset that keeps the session id), and
  `session_shutdown` of the binding;
- when the session id of its context differs from the one that it started
  in. Each step of the flow checks this before it mounts a view or sends, and
  the 1 s repair timer of a main binding checks it too.

An ended flow aborts its pending listing, target resolution, or side turn,
closes its open view through the view's own `done`, mounts no other view,
sends nothing, and shows no notice.

Each transport call of a flow (the listing, the probes, the lookups of the
resolver and of the send, and the request) runs with the `AbortSignal` of
the flow, so the end of the flow interrupts the call. Right before each
transport call, the flow checks that it did not end and that its session id
did not change. So a send whose lookup was pending when the flow ended makes
no request. The client of the transport runs the same check once more after
the handshake with the peer, right before it writes the request body: omp
can move the transcript to a new session id without a transition event,
also while the handshake runs. When the check fails, the client writes no
body, closes the connection, and the request ends as interrupted; the flow
reports no send. A request whose body already went out can reach the peer;
the flow shows no notice for it and does not say that it was withdrawn.

Each view is an overlay, so no other dialog of omp replaces it in the editor
slot. omp gives the handle of each overlay through `onHandle`. When omp
closed the overlay without `done`, the next check of the flow (the 1 s
repair timer of a main binding) ends the view as a cancel.

When a key in a view leads to the next talk view (Enter or `h` in the list,
Enter in compose, `ctrl+s` in the review, the last correct code letter or
`escape` in the confirm view), or a waiting view ends with a result that
leads to the next talk view (the side-turn waiting view with a draft, the
resize view with the fresh rows), the view settles but stays shown and
focused until the factory of the next view runs. The first correct code
letter only updates the typed letters, and the send waiting view ends the
flow. omp mounts an overlay a microtask after `ctx.ui.custom`, so a key
that omp dispatched in between would otherwise reach the composer. A
settled view consumes every key: `escape` and `alt+t` end the flow at once,
and every other key does nothing. A settled compose field or review field
also consumes each paste and ignores each late edit, also an edit that Tern
reports to it, so the text that the confirm view shows and that the flow
sends is the text at the key. The settled view closes inside the factory of
the next view, before omp opens the next overlay, because omp gives the
focus back to the node that was focused when an overlay opened. A key that
ends the flow (`escape` in the list, compose, the review, or a waiting
view; `alt+t` in any view) aborts the flow signal before the view closes,
so a pending step stops at once.

The command handler awaits its flow, because omp awaits a command handler
without a deadline. The shortcut handler starts its flow and returns, because
no omp source states the deadline of a shortcut handler. The `handover`
action awaits its flow and reports how it ended (see `cli/docs/talk-tool.md`,
"Handover").

A flow shows each error with `ctx.ui.notify` as an error, while it did not
end. The text starts
with exactly one `talk:` prefix. A failed listing or a failed resolution opens
no view.

### Destination

Each list row and each resolved target maps to one registration pair: an
instance id and its session id. The send goes to that pair through the
`instance` path of the tool, never by name again. Before it sends, the flow
lists the registry once more. When the instance is no longer listed or kept,
the send fails as the tool fails. When the instance now serves another session
id, the send fails with `not-live` and sends nothing. So a peer that ended
while a view was open gets nothing, and a session that took over its name gets
nothing.

The views and the tool share one listing (`listSessions`), one resolver
(`resolveTarget`), and one send (`sendTo`) in `cli/talk/tool/tool.ts`. So a
send from a view gives the same results, message ids, and errors as the
`send` action. The flow shows the result text of a successful send with
`ctx.ui.notify` as information, and a failure as an error.

Every peer string passes the cleaners of `cli/talk/tool/attachments.ts`
before it reaches a node: a name or a folder goes through `literal` (one code
span on one line), and a text line goes through `oneLine` (each run of
control characters or line separators becomes one space).

## List view

`/talk`, `/talk handover`, and `alt+t` open the list view. The flow first
lists the registry and probes each registration, as the `list` action does.
The view opens only after the listing.

The view is a `picker` node with `size: "screen"`, shown as a full-screen
overlay (`{ overlay: true, fullscreen: true }`). With `size: "screen"`, omp
does not turn the picker into the bounded sheet of Tern. omp removes the
`term` props before it sends the node to Tern, so Tern lays out and scrolls
the list itself. The title is `talk sessions`, or `talk: hand over to` in
handover mode.

Each row is one registration whose probe did not prove an end:

- The label starts with the full instance id, then two spaces and the name.
- The detail holds, in this order: `(this session)` on the row of this
  session; `unresolved: <outcome>` when the probe answered with a failure
  that proves no end; `session` and the first 8 characters of the session id;
  the folder.

The first selected row is the first row of another session. Without rows, the
view shows `No live talk sessions.`

The view sends nothing. It selects a pair: Enter opens the compose view in
the normal list and starts a handover in the handover-mode list. `h` starts a
handover in both lists.

### Size guard

In a terminal, the full-screen overlay owns the whole screen, so `ui.size()`
gives its space. On each render, the view sets `term.maxRows` to the rows
after the 3 fixed picker rows (the two borders and the hint row), at most 10.
It also checks that the label holds the 16-character instance id: the label
gets the width less 9 cells (the frame, the scrollbar, the pointer, and the
two cells that the painter keeps when it cuts a label). So the list needs at
least 4 rows and 25 columns.

When the space is smaller, the view shows only a line that asks for a larger
pane. The picker draws no such request: omp clips a frame that does not fit,
and no row of it can hold a whole request. Instead, the flow shows the resize
view in place of the list:

- At open, the list ends inside its factory, so omp mounts nothing of it.
  `ctx.ui.custom` is still called, because only its factory gets
  `ui.size()`.
- While the list is open, the next draw after a resize below that size ends
  the list. That draw shows no rows, no empty-state text, and no key hint, so
  an undersized frame never reads as an empty registry.
- The resize view is a full-screen overlay whose root is one `text` node,
  with no frame, no title, and no hint. omp's bare sheet centers a single
  child vertically in the full-screen overlay (`bare-sheet.ts`
  v19.2.1:24-27), so the request is the middle row of the screen, and the
  only row of a one-row pane. On each draw, it shows the longest of these
  cues that fits the width from `ui.size()`. Each cue is whole: no word is
  cut. A pane without a column shows no cue. The cue follows the current
  size first: the progress text below shows only while the list fits.

```text
talk: enlarge the pane to see the session list
talk: enlarge the pane
enlarge the pane
enlarge
grow
```

- A pane narrower than 4 columns shows a symbol cue that asks for a wider
  pane. The cue follows the symbol preset that omp gives the factory of the
  view (`theme.symbols.preset`; a theme without a known preset counts as
  `unicode`, the default of omp):
  - The `unicode` and `nerd` presets show `⤢` (U+2922), the expand symbol
    of omp (`cmd.expand` in pi-tui `src/theme/data/symbols.json` v19.2.1).
    Its East Asian Width is neutral (`2900..297F ; N` in
    `EastAsianWidth.txt` 17.0.0), so it takes one cell also in a terminal
    that draws ambiguous characters wide. The nerd glyph of `cmd.expand` is
    a private-use character, whose width is ambiguous, so the view does not
    use it.
  - The `ascii` preset is for terminals and fonts that show only ASCII, and
    omp gives it no `cmd.expand` glyph. In 3 columns the view shows `<->`,
    an arrow with two heads: make the pane wider. In 1 or 2 columns it
    shows `+`, the ASCII `nav.expand` glyph of omp: expand the pane. No
    clearer ASCII cue fits one column.
- When the list fits again, the resize view stays open and focused, shows
  `talk: listing sessions`, and lists the registry again with the abort
  signal and the session checks of the flow. It ends only when the rows are
  ready, so no key reaches the composer of omp between the warning and the
  list; `escape` and `alt+t` during the listing end the flow and abort the
  listing, and no list mounts later. The flow mounts the list with the fresh
  rows: a registration that ended while the warning showed is gone, and a
  new one shows. The list selects the pair that the operator selected in a
  list that showed before the resize, while that pair is still listed, else
  the first row of another session. A list that ended before it showed
  creates no selection to restore.
- In the resize view, Enter, `h`, and every other key do nothing; `escape`
  and `alt+t` end the flow. Enter and `h` never act on a list that does not
  fit.

## Compose view

The compose view is an `input` node, so the field has the focus. It is an
overlay at the bottom of the screen (`{ overlay: true, fullscreen: false }`).
The field holds one line and has no prompt: omp 19.2.1 scrolls an `input`
without the width of its prompt, so a prompt can hide the caret of a long
text. The placeholder names the destination while the field is empty. The
editor painter of omp 19.2.1 draws the caret of an empty field as a bar in
one cell and then draws the placeholder only when one more cell stays free
before it. So the placeholder gets the width less 2 cells, and the view uses
the longest of these forms that fits the width from `ui.size()`, and cuts
the destination as the last resort:

```text
To <name>: the message; ⏎ confirms the destination, ⎋ cancels
To <name> · ⏎ confirm · ⎋ cancel
To <name>
```

The confirm view names the destination again. Each edit passes
`safeMultiline` (see [Review](#review)), and then each line feed becomes a
space, so the one-line field shows the whole text that the view sends.

Enter with text that is not blank opens the [confirm view](#confirm-view).
Enter with a blank text does nothing. `escape` and `alt+t` end the flow and
send nothing. Other keys go to the field.

## Confirm view

No text leaves through a view before the operator confirms the destination
in the confirm view. The view is a full-screen overlay. Its rows are:

1. `Send to <full instance id>: type <code>`. For a handover that the
   `handover` action of the `talk` tool started:
   `Send to <full instance id> (a handover that the agent started): type <code>`.
2. The name and the folder of the destination.
3. `Kind: message` or `Kind: handover`.
4. `Text:` and the first line of the text.
5. The letters typed so far and a hint.

The view cuts each row after the first to the width. When the first row does
not fit the width, the view shows only
`talk: make the pane wider to confirm the destination.`, and no key sends:
the code letters are not shown, and the view takes none. So the user cannot
confirm a tool-started handover without the line that names the agent.

### Confirm code

Each confirm view draws a fresh code of two different random lowercase
letters (`crypto.randomInt`). The code is never the last code of the binding.
Only the two letters, typed in order as two separate key presses, send.

- A key event of the kind `repeat` clears the typed letters.
- A paste that omp reports as a paste event (a bracketed paste) clears the
  typed letters. So does a key that omp marks as after a paste: the first key
  that omp decodes from the same input read as the bracketed paste. A paste
  that the terminal does not bracket arrives as separate key presses, which
  the view cannot tell from typing.
- Any other key clears the typed letters. Enter sends nothing.
- `escape` returns to the compose view or the handover review, with the text
  kept. The next confirm view draws a new code.
- `alt+t` ends the flow and sends nothing.

The code makes a send depend on the row that names the full instance id: the
operator must read that row to know the code. The two letters are different,
so a held key cannot send: the legacy key decoder reports each repeated byte
as a press. A new code each time stops a typed habit from a last confirm. The
code does not prove that omp drew the row.

## Keys

| View            | Key                                                 | Effect                                               |
| --------------- | --------------------------------------------------- | ---------------------------------------------------- |
| List            | up, down, PgUp, PgDn, Home, End                     | Moves the selection                                  |
| List            | Enter                                               | Normal list: compose. Handover-mode list: handover   |
| List            | `h`                                                 | Handover to the selected row                         |
| List            | `escape`, `alt+t`                                   | Closes the list; ends the flow                       |
| Resize          | `escape`, `alt+t`                                   | Ends the flow                                        |
| Resize          | Any other key, Enter and `h` included               | Does nothing                                         |
| Compose         | Enter                                               | Opens the confirm view when the text is not blank    |
| Compose         | `escape`, `alt+t`                                   | Ends the flow; sends nothing                         |
| Handover review | `ctrl+s`                                            | Opens the confirm view when the text is not blank    |
| Handover review | `alt+enter`, `shift+enter` (kitty), `ctrl+j`        | Adds a line                                          |
| Handover review | Enter                                               | Does nothing                                         |
| Handover review | `escape`, `alt+t`                                   | Ends the flow; sends nothing                         |
| Confirm         | The two code letters, as two presses                | Sends                                                |
| Confirm         | A repeat, a paste, a key after a paste, another key | Clears the typed letters                             |
| Confirm         | `escape`                                            | Returns to compose or the review, with the text kept |
| Confirm         | `alt+t`                                             | Ends the flow; sends nothing                         |

The hint row of the list shows `⏎ message · h handover · ⎋ close`, or
`⏎ hand over · ⎋ close` in handover mode.

## Shortcut

Each binding registers `alt+t` (`pi.registerShortcut`). It opens the list
view, as `/talk` does. A terminal sends `alt+t` as the bytes `ESC t`, or as
`CSI 116;3u` in the kitty keyboard mode. While a `/talk` view is open, the
view gets `alt+t` and the shortcut does not fire: each view then closes or
ends the flow.

`pi.getShortcutConflict` throws while omp loads the factory, so the binding
checks `alt+t` at `session_start`. When another key binding, a reserved key,
or another extension holds `alt+t`, the binding shows one warning, once for
each binding:

```text
talk: the shortcut alt+t is taken (<kind>), so it may not open the talk list. /talk still works.
```

`<kind>` is the conflict kind that omp gives (`reserved`, `keybinding`, or
`extension`), or `unknown`. The warning goes through `ctx.ui.notify` in a
session with a UI, else to standard error.

## Message cards

### Details

The receiver writes versioned `details` on each talk message
(`customType` `talk`). The `content` text stays as `cli/docs/talk-tool.md`
describes it, so the model reads the same text.

| Field         | Value                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------- |
| `v`           | `1`                                                                                      |
| `messageId`   | The message id: 16 lowercase hex digits                                                  |
| `kind`        | `message`, `ask`, `reply` (a reply that reaches the session as a message), or `handover` |
| `from`        | The sender: `name`, `cwd`, and `sessionId`                                               |
| `sentAt`      | The send time of the sender, in epoch milliseconds                                       |
| `askId`       | The ask id of an ask, or the ask that a reply answers; only on `ask` and `reply`         |
| `attachments` | The `kind` (`file`, `snippet`, or `context`) and the `name` of each attachment           |
| `body`        | `start` and `end`: the UTF-16 range of the sender's text in `content`                    |

A Schema in `cli/talk/tool/host.ts` decodes the details. It refuses another
version, an `askId` on the wrong kind or a missing one, a body range that ends
before it starts, and a body range that ends after the end of `content`.

### Card

Each binding registers a message renderer for `talk`
(`pi.registerMessageRenderer`). omp calls it for each draw and again when the
card expands or collapses. The card has this header:

```text
talk <kind> from <name> · <folder> · <HH:MM>
```

The name and the folder show as code spans (`literal`). `HH:MM` is the local
time of `sentAt` in the receiving process. For example:
``talk ask from `alice` · `/work/alice` · 09:30``.

Under the header, the card shows, in this order:

1. For an ask, the reply hint of the text; for a reply, `Reply to ask <id>.`
2. One row `Attachment (<kind>): <name>` for each attachment. The card shows
   no attachment content.
3. The body: the sender's text from the `body` range. A collapsed card shows
   its first 3 lines and then `… <n> more lines` when more lines remain. An
   expanded card shows all lines. An empty body shows no body row.

The card leaves out the head line and the trust line of the text (see
`cli/docs/talk-tool.md`, "Message text"). It passes each shown line through
`oneLine`, so a peer cannot send a control character to the terminal. A
collapsed card cleans only its first 3 lines and counts the line breaks of
the rest; it does not split or clean the hidden text.

When the message does not decode, the renderer returns `undefined`, and omp
draws its default card with the text. A message from the talk tool of plan
DocksDocks/docks-kit#250, whose `details` hold only `messageId`, gets the
default card.

## Handover

`/talk handover <target>`, Enter in the handover-mode list, `h` in a list,
and the `handover` action of the `talk` tool start a handover. A side turn
writes a summary of this session's work. The operator reviews and edits it
locally, confirms the destination, and the approved text goes to the target
as a message with a request for a turn there (a wake). A handover that the
tool starts has the same review and confirm code (see
[Tool-started handover](#tool-started-handover)).

### Side turn

The flow first shows an information notice that names the review keys (a
tool-started handover shows none; see
[Tool-started handover](#tool-started-handover)). Then
it calls `ctx.runEphemeralTurn({ promptText, signal })` with the template and
the signal of the flow. It gives no `maxTokens` and no `tools` option. omp
runs the side turn with the current model on a copy of the conversation. The
side turn appends nothing to the session, can run during a main turn, and
cuts a reply above 4096 bytes of UTF-8, which it ends with the line
`[…truncated]`. omp keeps its tool list in the request and discards
each tool call of the side turn.

While the side turn runs, a waiting view at the bottom of the screen holds
the focus: `talk: a side turn writes the handover summary · ⎋ cancels`, or
for a tool-started handover
``talk: agent handover to `<name>` (<instance id>) · ⎋ cancels``, with
`(no name)` for a session without a name.
`escape` and `alt+t` there end the flow; every other key does nothing, so no
key reaches the composer of omp. When the flow ends during the side turn,
the flow aborts it, shows no error, and mounts no review. When the reply
arrives, the flow checks its signal and its session id before it mounts the
review.

A tool-started handover mounts its review only after omp drew the waiting
view once, whatever the size of the pane, so the line that names the agent
had a frame even when the side turn ends at once. When omp closes the
waiting view before that frame, the flow ends, and the tool result is
`cancelled`. A failed or empty side turn is reported at once. The line that
the user is sure to see is the first line of the confirm view (see
[Tool-started handover](#tool-started-handover)).

### Template

The prompt (`HANDOVER_PROMPT` in `cli/talk/ui/handover.ts`) asks for a
handover that stands alone, written from the view of this session, in
Markdown with these five sections in this order:

1. `## Next task`: the one thing that the receiver must do next.
2. `## Decisions`: the decisions and findings to keep, with their reasons,
   and the approaches that failed or were rejected.
3. `## Files`: the files, folders, and repositories that matter, with
   absolute paths.
4. `## Current state`: what is done and in progress, uncommitted changes,
   branches, and the last check results.
5. `## Risks`: open questions, risks, and what to check first.

The rules of the prompt: at most 3500 bytes of UTF-8 text (fewer characters
in scripts other than ASCII), short bullets, no greeting,
no secrets (API keys, tokens, passwords, credentials, private keys), no tool
calls, and only the handover in the reply. The sections follow the handover
of pi-intercom 0.19.0; the text is talk's own.

### Review

The review view is an `editor` node, so the field has the focus. It is a
full-screen overlay (`{ overlay: true, fullscreen: true }`), so it owns the
screen that `ui.size()` reports, and it shows a window of that many rows
around the caret. While no editable row fits the screen, `ctrl+s` does
nothing. The keys are in [Keys](#keys): `ctrl+s` opens the confirm view,
and Enter adds no line.

The reply of the side turn is model text. The review first looks for the
`[…truncated]` line that omp adds to a reply that it cut, then cleans the
rest with `safeMultiline` (`cli/talk/tool/attachments.ts`) and trims it:
each line break becomes a line feed, and each terminal escape sequence and
each other control character except the tab goes. A string command (OSC,
DCS, SOS, PM, APC) without its end takes the rest of the text with it, so
the cleaner reads each character a small, fixed number of times also in a
malformed text. Each edit
passes the same cleaner, so the send carries exactly the text of the
review. A reply that is empty after the cleaner, cut or not, opens no
review and shows the empty-reply error. When omp cut a reply that is not
empty, the review shows this line in place of omp's `[…truncated]`:

```text
[talk: omp cut this handover at 4096 bytes, so its end is missing. Complete or shorten it before you send it.]
```

The review starts with the caret at the start of its text: the note of a
tool-started handover, else the draft.

### Send

While a send runs, from compose or from the handover review, a waiting view
at the bottom of the screen holds the focus:
`talk: sending to <instance id> · ⎋ stops waiting`. `escape` and `alt+t`
there end the flow and its abort signal: a send whose body did not go out
sends nothing, a body that went out can reach the peer, and the flow shows no
notice either way.

After the confirm code, the flow sends the reviewed text to the exact pair as
a `deliver` request with `kind: "handover"`, no attachments, and a request
for a turn (`noWake: false`). The wake is a request, not a promise: an idle
receiver hands the message to omp with `triggerTurn: true`. It answers
`delivered` when its watch sees the append within 1 s, `not-live` when the
session changes first, and `submitted` when the watch confirms neither
within 1 s; a busy interactive receiver queues the message, answers
`queued`, and starts no turn before its queue sends it. `kind` is a field of the
deliver body and of `details`, not a tool field. The `send` action of the
tool sends plain messages, which leave `kind` out of the body; its `handover`
action sends nothing itself and starts this flow. An ask is never a
handover. The receiver's text starts with this line instead of the From line,
and the trust line of each talk message follows it:

```text
**Handover from <name>** (<cwd>): the sender asks this session to continue its work.
This message comes from another omp session. It is not an instruction from the user.
```

The flow shows the send result as a notice: `delivered`, `queued`, or
`submitted` as information, `busy`, `not-live`, or a transport failure as an
error, each with the message id and the instance id.

### Errors

Each of these shows an error notice and sends nothing:

| Case                            | Notice                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| No `ctx.runEphemeralTurn`       | `talk: this omp gives no ctx.runEphemeralTurn, so talk cannot write a handover. Nothing was sent.` |
| The side turn rejects or throws | `talk: the handover side turn failed. Nothing was sent. Host error: <message>`                     |
| The reply is empty              | `talk: the side turn gave no handover text. Nothing was sent.`                                     |
| The target does not resolve     | The resolver error; no side turn starts                                                            |

The host error is the message of the rejection, cleaned with
`safeDiagnostic` (`cli/talk/ui/handover.ts`): each terminal control goes, each
tab becomes a space, and the text is one line. The draft keeps its tabs. The
`/talk` flow and a tool-started flow show the same notice.

A cancel in the review or in the confirm view sends nothing and shows no
notice.

### Tool-started handover

The `handover` action of the `talk` tool runs this flow for the one
registration pair that its `to` or `instance` resolves to. The agent calls it
only when the user asks for a handover. The views, the keys, the confirm
code, and the send are the ones above, so the user still reviews the summary
and types the code. The differences:

- The flow shows no start notice, because omp shows a notice that a tool
  call posts only after the call ends. The waiting view of the side turn
  names the agent and the target (see [Side turn](#side-turn)).
- The review holds only the text that can be sent: the `message` of the call
  as a note, then a blank line, then the draft. The flow cleans the note
  with `safeMultiline`, as it cleans the draft, then trims it, so no terminal
  control of agent text reaches the view. A blank note adds nothing. The
  note does not change the template, but the side-turn model sees it,
  because omp copies the pending tool call with its arguments into the
  side-turn request. The user approves only what goes to the peer.
- The first line of the confirm view names the agent:
  `Send to <full instance id> (a handover that the agent started): type <code>`.
  The view draws it in full or takes no code: a pane too narrow for it shows
  `talk: make the pane wider to confirm the destination.` So this line is
  where the user sees, at the approval, that the agent started the handover.
- Right before the send, the flow checks that the pair is not this binding's
  registration: now, at the start of the call, or the pair that the binding
  publishes and has not attached yet. The client asks the same check right
  before the body write. When the pair is this session, the flow shows
  `talk: the destination of this handover is now this session, so talk sent nothing.`
  and sends nothing.
- `escape` in the waiting view or the review ends the flow. `escape` in the
  confirm view returns to the review with the text kept, and the tool call
  still waits. `alt+t` ends the flow. An abort of the tool call ends the
  flow as `escape` does. A flow that ends before the body write gives
  `cancelled`; after the write started, the result follows the dispatch
  record: the answer when one came, `failed` for a failed write, else
  `unknown`.
- The action refuses before the side turn outside mode `tui`, without
  `ctx.hasUI`, in a subagent, while a `/talk` flow is open (which stays
  open), without `ctx.runEphemeralTurn`, and for the registration of this
  session. When the registry cannot be read to check the target, the user
  gets the notice
  `talk: the agent asked for a handover, but talk could not check its target, so nothing was sent. Error: <host error>`,
  cleaned with `safeDiagnostic`, and the agent gets a fixed text without it.

The tool result gives the outcome of the send from its dispatch record:
`delivered`, `queued`, or `submitted`; a refusal such as `busy` or `not-live`;
`unknown` when the text may have gone out and no usable answer settled the
outcome; `failed`; or `cancelled` when the flow ended before anything went
out, by a key, an abort, or the destination check.
After a failed side turn, the result holds only `talk: the handover side
turn failed. Nothing was sent.` The host error stays in the notice. The
result never holds the summary. `cli/docs/talk-tool.md`, "Handover", lists
the refusals and the outcomes.

### Privacy

A `/talk` flow calls only two methods of `ctx.ui`: `custom` and `notify`
(plan DocksDocks/docks-kit#248 D9). In TUI mode both stay local: omp sends
`select`, `editor`, `approve`, `askDialog`, and `formDialog` to a Collab
guest, and the first answer wins for the first three. So the list, the draft,
and the confirm code never reach a guest, and a guest cannot approve a send.
The `FlowUi` interface in `cli/talk/ui/command.ts` holds only the two methods.
The fake TUI host of the tests (`cli/test/lib/talkFlowHost.ts`) records each
call by name, and the flow tests check the exact list of calls.

## UI host probe

omp supplies `@oh-my-pi/pi-tui` at run time. The factory is async: before it
registers anything, it loads `@oh-my-pi/pi-tui` and
`@oh-my-pi/pi-tui/text/width` with literal dynamic imports
(`cli/talk/ui/host.ts`). `cli/scripts/build-talk.ts` keeps both modules
external and allows a host module only in that form. The probe checks by type
that each of these exports is a function:

- `jsx`, `signal`, and `isUiNode` of `@oh-my-pi/pi-tui`;
- `visibleWidth`, `truncate`, and `wrap` of `@oh-my-pi/pi-tui/text/width`.

omp 19.1.1 has a `@oh-my-pi/pi-tui` with an older component API, so the
probe checks the exports and not only the module. The probe of `pi` also
checks `pi.registerCommand`, `pi.registerShortcut`, `pi.getShortcutConflict`,
and `pi.registerMessageRenderer` (see `cli/docs/talk-tool.md`, "Capability
probe").

When an import fails or an export is missing, the binding registers no tool,
no renderer, no command, and no shortcut. It shows only the one notice that
names each missing part and omp 19.2.0. For example, a failed import of
`@oh-my-pi/pi-tui` gives:

```text
talk: this omp has no @oh-my-pi/pi-tui. talk needs omp 19.2.0 or later, so the talk tool is off.
```

`cli/talk/types/pi-tui.d.ts` and `cli/talk/types/pi-tui/text/width.d.ts`
declare only the host exports that talk probes and calls. `cli/tsconfig.json`
maps the two module names to them through `paths`, so no host package is
installed.

## Known limits

- RPC and ACP clients get no views. They get the notice of [Modes](#modes)
  and can use the `talk` tool, but not its `handover` action, which refuses.
- An ACP client does not see a notice that talk shows with `ctx.ui.notify`:
  ACP writes `notify` only to a debug log. This includes the notice of
  [Modes](#modes) and the shortcut warning.
- omp documents message renderers only for the interactive UI. How an RPC or
  ACP client shows a talk message is unknown; the `content` text stays as
  the tool writes it.
- The pseudo-terminal flow of the verify skill (`omp-smoke.ts talk-ui`) runs
  on Linux in a terminal. No check of this plan ran the views on macOS or in
  a Tern pane.
- The completion reads the snapshot of the last listing, so it can offer a
  name that ended or miss a new one. The list view and the send check the
  registry again.
- The list does not refresh while it is open. A row that ended while the
  view was open reads `not-live` at the send.
- The compose view holds one line and no attachments. Use the `talk` tool for
  attachments, and handover for a long text.
- The confirm code does not prove that omp drew the row with the instance id.
- omp cuts a side-turn reply above 4096 bytes. The template asks for at most
  3500 bytes, but a model can write more; the review then names the cut.

## Source files

| File                                    | Holds                                                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `cli/talk/ui/host.ts`                   | The host module loader with the literal dynamic imports, and the probe of the host exports                                 |
| `cli/talk/ui/card.ts`                   | The renderer of the message card                                                                                           |
| `cli/talk/ui/command.ts`                | The `/talk` argument parser, the completion, the notices, and the flow slot with the list, compose, and handover flows     |
| `cli/talk/ui/views.ts`                  | The list, compose, and confirm views, the size guards, and the confirm code                                                |
| `cli/talk/ui/handover.ts`               | The handover template, the side-turn call, its errors, and the review view                                                 |
| `cli/talk/types/pi-tui.d.ts`            | The declarations of the `@oh-my-pi/pi-tui` exports that talk uses                                                          |
| `cli/talk/types/pi-tui/text/width.d.ts` | The declarations of the `@oh-my-pi/pi-tui/text/width` exports that talk uses                                               |
| `cli/talk/extension.ts`                 | The registration of the renderer, the command, and the shortcut, the mode check, the conflict check, and the flow services |

### Test files

| File                                   | Covers                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `cli/test/lib/talkFlowHost.ts`         | The fake TUI host of the flow tests: a recording `ctx.ui`, fake flow services, and a `jsx` that records each node           |
| `cli/test/unit/talk/command.test.ts`   | The `/talk` arguments, the completion, the list, compose, and confirm views, the size guards, and the flow slot             |
| `cli/test/unit/talk/handover.test.ts`  | The template, the side turn, the review, the handover-mode list and `h`, the errors, and the end of a flow in the side turn |
| `cli/test/unit/talk/card.test.ts`      | The message card of each kind, collapsed and expanded, the cleaners, and the renderer registration                          |
| `cli/test/unit/talk/extension.test.ts` | The registration of the command, the shortcut, and the renderer, and the flows end to end with the fake transport           |
