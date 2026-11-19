import { CAUSE } from "../causes";
import type { ErrorCopy } from "../types";

/** App-wide internal codes that have a user sentence. */
export const APP_CODES: Readonly<Record<string, ErrorCopy>> = {
  provider_url_invalid: CAUSE.providerUrlInvalid,
  pi_native_conversation_busy: CAUSE.previousAnswerRunning
};
