// Entry of the talk extension bundle; `cli/scripts/build-talk.ts` builds it
// into `talk.js`. It exports the transport API of plan #249; #250 adds the
// extension factory.
export {
  type Client,
  type Peer,
  type PeerListing,
  TalkListError,
  processAlive,
} from "./transport/client";
export { type Endpoint, TalkEndpointError } from "./transport/endpoint";
export { TALK_DIR_OVERRIDE, TalkFolderError, resolveRegistryFolder } from "./transport/folder";
export {
  type ListenerStatus,
  type Registration,
  type RegistrationInput,
  type RegistrationStatus,
  TalkRegisterError,
} from "./transport/listener";
export { type RejectedEntry, entryFileName, sessionKey } from "./transport/registry";
export {
  PING_KIND,
  type RequestContext,
  type RequestHandler,
  RequestOutcome,
  type Target,
  TalkRequestFailed,
} from "./transport/request";
export {
  TRANSPORT_DEFAULTS,
  TalkTransport,
  type TalkTransportOptions,
  type TransportStatus,
} from "./transport/transport";
export { TalkTrustError } from "./transport/trustPosix";
