import type { CapabilityAccess } from "../membership/types";
/** Explicit paid fixture. Production constructors remain fail closed. */
export const paidTestAccess: CapabilityAccess = {
  checkCapability: () => true,
  requireCapability: () => {},
  subscribe: () => () => {},
};
