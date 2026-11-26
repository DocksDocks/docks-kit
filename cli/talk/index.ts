// Entry of the talk extension bundle; `cli/scripts/build-talk.ts` builds it
// into `talk.js`. Step 5 of plan #249 adds the transport exports here and
// removes the placeholder below.
import { Effect } from "effect";

/** Placeholder export: it keeps Effect code in the bundle until the transport exports exist. */
export const placeholder: Effect.Effect<void> = Effect.void;
