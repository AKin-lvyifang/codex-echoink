/**
 * Serializes live Conversation mutations within this plugin process.
 *
 * Durable cross-process authority still belongs to the Conversation Store CAS.
 * This lane only prevents an awaited local mutation from overwriting another
 * mutation made to the same live StoredSession object.
 */
export class ConversationMutationLane {
  private readonly tails = new Map<string, Promise<void>>();

  async withConversationMutation<T>(
    conversationId: string,
    action: () => Promise<T>
  ): Promise<T> {
    const key = conversationId.trim();
    if (!key) {
      throw new Error("Conversation mutation requires a non-empty conversationId");
    }
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, current);

    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.tails.get(key) === current) {
        this.tails.delete(key);
      }
    }
  }
}
