type GossipHandler<T> = (message: T) => void;

export class InMemoryGossip {
  private readonly subscribers = new Map<string, Set<GossipHandler<unknown>>>();

  publish<T>(topic: string, message: T): void {
    for (const handler of this.subscribers.get(topic) ?? []) {
      handler(message);
    }
  }

  subscribe<T>(topic: string, handler: GossipHandler<T>): () => void {
    const handlers = this.subscribers.get(topic) ?? new Set<GossipHandler<unknown>>();
    handlers.add(handler as GossipHandler<unknown>);
    this.subscribers.set(topic, handlers);
    return () => {
      handlers.delete(handler as GossipHandler<unknown>);
      if (handlers.size === 0) this.subscribers.delete(topic);
    };
  }

  subscriberCount(topic: string): number {
    return this.subscribers.get(topic)?.size ?? 0;
  }
}
