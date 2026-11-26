# talk transport

`talk` lets live omp sessions send messages to each other without a broker.
This document describes its build, its registry, and its transport. The
source lives in `cli/talk/`, outside the npm `files` list. The kit plugin
does not load `talk` yet: plan DocksDocks/docks-kit#252 does the cutover from
pi-intercom.

## Build

`bun cli/scripts/build-talk.ts --out <dir>` bundles `cli/talk/index.ts` into
`<dir>/talk.js` with `Bun.build`. The file holds, in this order:

1. A generated-file header.
2. A license banner: the complete text of each file in `cli/talk/licenses/`
   (pi-intercom first), then Effect's license, then the license of each other
   package that adds code, sorted by name. A package adds code when one of its
   inputs has `bytesInOutput > 0` in the build metafile.
3. The bundled code.

The build fails when a package that adds code has no `LICENSE`,
`LICENSE.md`, or `LICENSE.txt`; it reads the license of the package after the
last `node_modules` folder of each input, so a nested package counts on its
own. It keeps `@oh-my-pi/*` external and fails when the emitted code loads a
host module in another form than a dynamic `import` of one string literal: a
static `import`, an `export ... from`, a `require` (also Bun's `__require` and
`import.meta.require`), or a dynamic `import` of an expression. The check
finds static forms with `Bun.Transpiler.scanImports` and reads the other forms
in code only, so import-like text in strings, templates, comments, and
regular expressions does not fail the build. The check is a lexer, not a
parser: it does not see a loader that the code reaches through another name,
such as `const load = require` or `import.meta["require"]`, or a loader name
written with escapes, such as `requ\u0069re`, and it can read an unusual
construct of the emitted code wrongly. The tests cover each rule
of the lexer. The build writes `talk.js`
through an exclusive temporary file and a rename, so it replaces a link at the
name `talk.js` and never writes through it; a link in the path of the output
folder is followed, so give a folder that you own. The package smoke
(`cli/scripts/package-smoke.ts`) fails when the tarball holds a `cli/talk/`
entry, a folder entry included.

## Registry folder

Each live main session has one entry in the registry folder of the user:

| System  | Folder                                                                             |
| ------- | ---------------------------------------------------------------------------------- |
| Linux   | `/tmp/docks-kit-talk-<uid>`                                                        |
| macOS   | `docks-kit-talk` in the folder that `/usr/bin/getconf DARWIN_USER_TEMP_DIR` prints |
| Windows | `%LOCALAPPDATA%\docks-kit\talk`                                                    |

Only tests and verify flows set `DOCKS_KIT_TALK_DIR`, to a short folder that
they make in the system temporary root. It is no user setting.

### Threat model

`talk` protects the entries against another local account without root or
Administrators rights. A rule that the user or root sets, such as an ACL or
a link onto shared storage, is the user's choice, and `talk` does not change
it on an existing object. One exception: on macOS, `talk` runs `chmod -N` on
a registry folder that it creates, which clears the ACL entries that the new
folder inherited from its parent. Existing objects and the ACLs of ancestor
folders stay unchanged.

### Names

`talk` creates, replaces, refreshes, and removes only these names, directly
in the registry folder:

- Entries: `<instance id>-<session key>.entry`. The instance id is 16 random
  hex characters per registration, so a session that registers again after a
  withdrawal is a new target. The session key is the first 16 hex characters
  of the SHA-256 of the session id.
- Sockets: `<pid>-<16 hex>.sock`. The `<pid>` part is the process id of the
  owner, without leading zeros, and the 16 hex characters are random for
  each bind.
- Temporary files: `.<16 hex>.tmp`.

An entry whose ids do not give its file name, or whose socket path is not a
socket name directly in the folder, is rejected. omp's daemon files never
match these names, so a user who points `OMP_DAEMON_DIR` at the talk folder
keeps omp's files intact.

### Trust rules (POSIX)

Before each secret read and each secret write, `talk` checks the path again:

- It walks the path from the root with `lstat`. Each ancestor must belong to
  the user or root and must not be writable by others, except a sticky
  folder. A symbolic link above the registry folder must belong to the user
  or root and sit in a folder that passed; the walk checks each link hop, up
  to 40.
- The registry folder must be a real folder of the user with mode 0700. On
  macOS, `ls -led` of the folder must show no ACL entry line. This check is
  defense in depth, not a proof.
- Creation: `mkdir` with mode 0700, then `chmod` 0700, then `chmod -N` on
  macOS, then the check. When the check fails, `talk` removes the folder that
  it created, only while the folder is empty, and stops.
- Publication: an exclusive `O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW` open of
  a temporary name with mode 0600, then `fchmod` 0600, because the umask can
  narrow the open mode, then the write and a rename to the entry name. The
  listener keeps that descriptor until a replacement publishes or the
  registration ends.
- Client read: `lstat` first, and any object other than a regular file is
  skipped without an open, so a FIFO or a device cannot block the read. Then
  an `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` open, and `fstat` must show the same
  regular file of the user with mode exactly 0600.
- Size: an entry file holds at most 64 KiB (`MAX_SECRET_FILE_BYTES`).
  Publication refuses a larger entry, and a read checks the size before it
  reads.

A failed check stops the operation with an error that names the path and the
reason. A request whose entry lookup fails this way gets `unreachable` with
that reason, not `not-found`.

### Windows

Each entry file holds only a DPAPI blob. `talk` seals the whole entry JSON
for the current user with the entropy `docks-kit-talk/v1`. One
`powershell.exe` start seals or unseals a batch. Every command that `talk`
starts has a deadline of 30 s (`TOOL_TIMEOUT_MS`). Another account can neither
read nor forge the secret, the endpoint, or the process id.

## Endpoints

On Linux and macOS, each omp process listens on one Unix socket with a fresh
name for each bind: its own process id and a random part (see Names). Bun
binds without a mode, so the umask and, on Linux, a default ACL of the folder
decide the bits of the socket. A client needs write permission on the socket
to connect. After each bind, the listener checks that the path is a socket
of the user with the owner write bit. `talk` never changes the mode of a
socket. When the check fails, the listener closes the new socket without
publishing it, and registration fails with an error that points to the umask
and the default ACL of the folder. Thus a umask or a default ACL that removes
owner write prevents registration.

On Windows, the listener uses TCP on `127.0.0.1` with a port that the system
picks. The listener keeps its port across a repair, so a kept endpoint stays
valid.

## Protocol

- Frames: a 4-byte big-endian length, then UTF-8 JSON. A length above 1 MiB
  closes the connection.
- Handshake: `hello` (version, target instance id, target session id, client
  nonce), then `challenge` (listener nonce and the listener HMAC), then
  `proof` (the client HMAC), then `ready`, or `ended` for a registration that
  this listener served and that ended. Each HMAC is HMAC-SHA-256 with the
  registration secret over the role, both nonces, the instance id, and the
  session id. Each side compares in constant time. The secret never crosses
  the connection.
- Limits: at most 32 connections before `ready`, and 1 s from accept to the
  end of the handshake. A connection pauses its socket when more than one
  maximum frame plus its header waits unread.
- Requests: `{ type: "request", id, kind, body }` and
  `{ type: "response", id, result }`. The kind `ping` answers liveness. A
  request times out after 5 s by default, and a probe after 500 ms. When the
  listener cannot send a response, for example a result above 1 MiB, it
  closes the connection.
- Admission: the transport option `admit` is a hook that the listener asks in
  the tick that it admits a request for a registration, `ping` included. When
  the hook gives false or throws, the request gets `not-live` and the listener
  withdraws the registration. Without the option, the listener admits every
  request.

### Registrations

One listener can hold several live registrations of one session id. Each
registration has its own instance id, secret, and entry. Requests and
withdrawals go to a registration by its pair: the instance id and the
session id.

`update(target, { name, cwd })` publishes a live registration again with a
new name and folder. The instance id, the session id, the secret, the start
time, and the endpoint stay the same, so an entry that a client kept still
reaches the registration. A registration that is not live gives
`TalkUpdateError`. When the publication fails, the call gives
`TalkUpdateError`, the entry stays stale, and the next repair pass publishes
it with the new name and folder.

### Withdrawal

The listener first marks the registration ended and takes every request
that it holds for it: each gets `not-live`, each connection of the
registration closes, and a new `hello` for it gets `ended` after the full
proof. A handler that has not started for such a request never starts. Then
the listener removes the entry file. A failed removal stays pending until it
succeeds or a new entry of that name publishes, and each repair pass retries
it. The listener keeps the ids and secrets of each registration that ended
until the process ends.

### Client outcomes

A client keeps the entry of each target that it listed, retained, or reached
(after the listener proof checked out), so a missing entry file alone does
not stop a send.

- `retain(pair)` reads the entry of the pair now and keeps it like a listed
  entry. When no entry names the pair, it fails with `not-found`; a failed
  lookup gives `unreachable` with the reason.
- `known(instanceId)` gives the pair (the instance id and the session id,
  never the secret) of a kept entry with exactly this instance id, or
  nothing for an instance id that the client never kept.

#### Routes

A request tries these routes for the pair:

1. The #249 path: the kept endpoint first. When that socket is missing
   (`ENOENT`) or refuses the connection (`ECONNREFUSED`), the client reads the
   entry file of the pair once more and dials its endpoint when it changed.
2. On POSIX, once the first connect of the #249 path settled: each other
   socket in the folder whose name carries the process id of the kept entry.
   Each one dials as soon as a dial slot is free. These routes need no live
   entry, so a listener that withdrew its last registration and then bound a
   new socket still gives its proof of the end.

Every handshake runs under the whole deadline of the caller; no route stops
because other routes exist. The first connection that completes the mutual
proof over the secret and the session id of the pair is the only one that
sends the request body; the other connections close. The client never
retries after it sent the body. Only the listener that served the pair can
complete that proof, so a `not-live` or `ended` answer through any route is
authenticated. When the deadline expires first, the request gives `timeout`.
When every route ends without that proof, the request gives the result of
the #249 path. A socket that the client found by its process id alone never
replaces that result: a bad proof of the kept endpoint or of its fresh entry
still gives `auth-failed` when a process-id socket refuses the connection.

#### Dial slots

Every connection that the client opens to one target process id takes one of
8 slots (`DIAL_SLOTS`) from its connect to its close, whichever caller opens
it (a request, a probe, or the connect test of a listing) and whichever socket
it dials. A dial without a free slot waits for one within the deadline of its
caller. So this process never offers a listener more than 8 of the 32
connections that the listener admits before `ready`.

| Outcome        | When                                                                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not-live`     | An authenticated `not-live` or `ended` through any route, or a missing or refusing endpoint on the #249 path while no process holds the process id of the target |
| `not-found`    | No entry and no kept entry names the target                                                                                                                      |
| `auth-failed`  | The proof of the listener on the #249 path does not match, and no route completed the proof                                                                      |
| `timeout`      | No answer before the deadline                                                                                                                                    |
| `unreachable`  | Other connection failures, for example a missing endpoint while a process holds the process id of the target                                                     |
| `unknown-kind` | The live target has no handler for the request kind                                                                                                              |

A process counts as not alive only when `process.kill(pid, 0)` fails with
`ESRCH`; a process id in use counts as alive, whatever process holds it.

### Pruning

A listing removes an entry and its socket only when the entry decoded, its
endpoint is missing or refuses the connection, and its process id is not
alive. A timeout, `EACCES`, `EMFILE`, or a failed handshake never prunes. A
client keeps its own entry of a pruned target; its next send still applies
the endpoint and process id checks above.

On POSIX, a listing then removes a file of the socket pattern only when no
decoded entry names it, the process id in its name is not alive, and its
connect attempt is refused. So a socket of a live process stays, also one
that a starting process bound and does not listen on yet. omp can exit on a
signal without an exit hook, so this rule removes the socket that such a
process left.

### Repair

Every 60 s, the listener checks each of its entries on its own: a failure of
one entry is logged, and the pass goes on with the others. It publishes a
missing or changed entry again and retries a failed publication on the next
pass. When the registry folder is missing, it creates the folder again; on
POSIX it also binds a new socket. On POSIX, every 6 hours it refreshes the
times of its entry files through the descriptors that it kept, and logs each
failure with the path and the reason.

## Known limits

- Cleanup by age can remove an entry once its process has been stopped
  longer than the system's age minus up to 6 hours (10 days on systemd).
  When the process continues, the next repair pass publishes it again.
- Without an authenticated answer, a client cannot tell a reused process id
  from the target, so it reports `unreachable`, not `not-live`. A reused
  process id also makes a process-id route dial the sockets of another
  process; those dials fail the proof and change no result.
- A registry that the user shares between computers or PID namespaces lets
  one peer prune the live entry of another. The repair of the target
  publishes it again.

## Source files

| File                                | Holds                                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `cli/talk/index.ts`                 | The bundle entry; it exports the transport API                                                                  |
| `cli/talk/licenses/pi-intercom.txt` | The license of the ported pi-intercom source, first in the banner                                               |
| `cli/talk/transport/frame.ts`       | The frame codec and the 1 MiB cap                                                                               |
| `cli/talk/transport/handshake.ts`   | The handshake and request messages, nonces, and HMAC proofs                                                     |
| `cli/talk/transport/folder.ts`      | The registry folder of each system, the test override, and the command runner                                   |
| `cli/talk/transport/trustPosix.ts`  | The POSIX trust rules, folder creation, and secret file publication and reads                                   |
| `cli/talk/transport/sealWindows.ts` | The DPAPI seal and unseal batches of Windows                                                                    |
| `cli/talk/transport/registry.ts`    | The entry Schema, the owned names, publication, listing of entries and sockets, removal, and the repair check   |
| `cli/talk/transport/endpoint.ts`    | Socket names with the owner process id, the `sun_path` limit, the post-bind check, and the Windows port         |
| `cli/talk/transport/request.ts`     | Request results, outcomes, and handler types                                                                    |
| `cli/talk/transport/connection.ts`  | One framed socket                                                                                               |
| `cli/talk/transport/listener.ts`    | The process listener: handshake, limits, admission, update, withdrawal, repair, rebind, and refresh             |
| `cli/talk/transport/client.ts`      | Kept entries, `retain` and `known`, the routes and the dial slots, outcomes, and pruning of entries and sockets |
| `cli/talk/transport/transport.ts`   | The `TalkTransport` service, its layer, and the defaults                                                        |
