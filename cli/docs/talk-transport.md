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
`LICENSE.md`, or `LICENSE.txt`. It keeps `@oh-my-pi/*` external and fails when
the emitted code loads a host module in another form than a dynamic `import`
of one string literal: a static `import`, an `export ... from`, a `require`,
or a dynamic `import` of an expression. The package smoke
(`cli/scripts/package-smoke.ts`) fails when the tarball holds a `cli/talk/`
entry.

## Registry folder

Each live main session has one entry in the registry folder of the user:

| System | Folder |
|---|---|
| Linux | `/tmp/docks-kit-talk-<uid>` |
| macOS | `docks-kit-talk` in the folder that `/usr/bin/getconf DARWIN_USER_TEMP_DIR` prints |
| Windows | `%LOCALAPPDATA%\docks-kit\talk` |

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
  hex characters per process. The session key is the first 16 hex characters
  of the SHA-256 of the session id.
- Sockets: `<16 hex>.sock`.
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
  listener keeps that descriptor until it replaces the entry or the
  registration ends.
- Client read: `lstat` first, and any object other than a regular file is
  skipped without an open, so a FIFO or a device cannot block the read. Then
  an `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` open, and `fstat` must show the same
  regular file of the user with mode exactly 0600.

A failed check stops the operation with an error that names the path and the
reason.

### Windows

Each entry file holds only a DPAPI blob. `talk` seals the whole entry JSON
for the current user with the entropy `docks-kit-talk/v1`. One
`powershell.exe` start seals or unseals a batch. Another account can neither
read nor forge the secret, the endpoint, or the process id.

## Endpoints

On Linux and macOS, each omp process listens on one Unix socket with a fresh
random name for each bind. Bun binds without a mode, so the umask and, on
Linux, a default ACL of the folder decide the bits of the socket. A client
needs write permission on the socket to connect. After each bind, the
listener checks that the path is a socket of the user with the owner write
bit. `talk` never changes the mode of a socket. When the check fails, the
listener closes the new socket without publishing it, and registration
fails with an error that points to the umask and the default ACL of the
folder. Thus a umask or a default ACL that removes owner write prevents
registration.

On Windows, the listener uses TCP on `127.0.0.1` with a port that the system
picks.

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
  end of the handshake.
- Requests: `{ type: "request", id, kind, body }` and
  `{ type: "response", id, result }`. The kind `ping` answers liveness. A
  request times out after 5 s by default, and a probe after 500 ms.

### Withdrawal

The listener first marks the registration ended. Each request that it holds
for that registration gets `not-live`, each of its connections closes, and a
new `hello` for it gets `ended` after the full proof. Then the listener
removes the entry file. A failed removal stays pending, and each repair pass
retries it. The listener keeps the ids and secrets of each registration that
ended until the process ends.

### Client outcomes

A client keeps the entry of each target that it listed or reached, so a
missing entry file alone does not stop a send. When the endpoint is missing
or refuses the connection, the client reads the entry file of the target once
more and retries on a new endpoint.

| Outcome | When |
|---|---|
| `not-live` | An authenticated `not-live` or `ended`, or a missing or refusing endpoint while no process holds the process id of the target |
| `not-found` | No entry and no kept entry names the target |
| `auth-failed` | The proof of the listener does not match |
| `timeout` | No answer in time |
| `unreachable` | Other connection failures, for example a missing endpoint while a process holds the process id of the target |
| `unknown-kind` | The live target has no handler for the request kind |

A process id in use counts as alive, whatever process holds it. A second
live registration with the same session id in one process fails.

### Pruning

A listing removes an entry and its socket only when the entry decoded, its
endpoint is missing or refuses the connection, and its process id is not
alive. A timeout, `EACCES`, `EMFILE`, or a failed handshake never prunes.

### Repair

Every 60 s, the listener checks its entries. It publishes a missing or
changed entry again and retries a failed publication on the next pass. When
the registry folder is missing, it creates the folder again; on POSIX it also
binds a new socket. On POSIX, every 6 hours it refreshes the times of its
entry files through the descriptors that it kept.

## Known limits

- Cleanup by age can remove an entry once its process has been stopped
  longer than the system's age minus up to 6 hours (10 days on systemd).
  When the process continues, the next repair pass publishes it again.
- Without an authenticated answer, a client cannot tell a reused process id
  from the target, so it reports `unreachable`, not `not-live`.
- A registry that the user shares between computers or PID namespaces lets
  one peer prune the live entry of another. The repair of the target
  publishes it again.

## Source files

| File | Holds |
|---|---|
| `cli/talk/index.ts` | The bundle entry; it exports the transport API |
| `cli/talk/licenses/pi-intercom.txt` | The license of the ported pi-intercom source, first in the banner |
| `cli/talk/transport/frame.ts` | The frame codec and the 1 MiB cap |
| `cli/talk/transport/handshake.ts` | The handshake and request messages, nonces, and HMAC proofs |
| `cli/talk/transport/folder.ts` | The registry folder of each system, the test override, and the command runner |
| `cli/talk/transport/trustPosix.ts` | The POSIX trust rules, folder creation, and secret file publication and reads |
| `cli/talk/transport/sealWindows.ts` | The DPAPI seal and unseal batches of Windows |
| `cli/talk/transport/registry.ts` | The entry Schema, the owned names, publication, listing, removal, and the repair check |
| `cli/talk/transport/endpoint.ts` | Socket names, the `sun_path` limit, the post-bind check, and the Windows port |
| `cli/talk/transport/request.ts` | Request results, outcomes, and handler types |
| `cli/talk/transport/connection.ts` | One framed socket |
| `cli/talk/transport/listener.ts` | The process listener: handshake, limits, withdrawal, repair, rebind, and refresh |
| `cli/talk/transport/client.ts` | Kept entries, the re-read, outcomes, and pruning |
| `cli/talk/transport/transport.ts` | The `TalkTransport` service, its layer, and the defaults |
