/**
 * Serializes live Conversation mutations within this plugin process.
 *
 * Durable cross-process authority still belongs to the Conversation Store CAS.
 * This lane only prevents an awaited local mutation from overwriting another
 * mutation made to the same live StoredSession object.
 */
declare const conversationMutationAuthorityBrand: unique symbol;

export interface ConversationMutationAuthority {
  readonly [conversationMutationAuthorityBrand]: true;
}

interface ConversationMutationAuthorityState {
  conversationId: string;
  active: boolean;
}

const conversationMutationAuthorityStates =
  new WeakMap<object, ConversationMutationAuthorityState>();

export function assertConversationMutationAuthority(
  authority: ConversationMutationAuthority,
  conversationId: string
): void {
  const key = normalizedConversationId(conversationId);
  const state = (
    authority !== null
    && typeof authority === "object"
  )
    ? conversationMutationAuthorityStates.get(authority)
    : undefined;
  if (!state) {
    throw new Error("Conversation mutation authority is invalid or forged");
  }
  if (!state.active) {
    throw new Error("Conversation mutation authority has expired");
  }
  if (state.conversationId !== key) {
    throw new Error(
      "Conversation mutation authority belongs to a different conversation"
    );
  }
}

export class ConversationMutationLane {
  private readonly tails = new Map<string, Promise<void>>();

  async withConversationMutation<T>(
    conversationId: string,
    action: (authority: ConversationMutationAuthority) => Promise<T>
  ): Promise<T> {
    const key = normalizedConversationId(conversationId);
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, current);

    await previous;
    const authority = Object.freeze({}) as ConversationMutationAuthority;
    const authorityState: ConversationMutationAuthorityState = {
      conversationId: key,
      active: true
    };
    conversationMutationAuthorityStates.set(authority, authorityState);
    try {
      return await action(authority);
    } finally {
      authorityState.active = false;
      release();
      if (this.tails.get(key) === current) {
        this.tails.delete(key);
      }
    }
  }
}

function normalizedConversationId(conversationId: string): string {
  const key = conversationId.trim();
  if (!key) {
    throw new Error("Conversation mutation requires a non-empty conversationId");
  }
  return key;
}
