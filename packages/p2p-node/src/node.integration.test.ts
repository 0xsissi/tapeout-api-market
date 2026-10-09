import { describe, expect, it } from 'vitest';

import { createNode, dialPeerAddress, type ClawMarketNode } from './node.js';

describe('createNode pubsub integration', () => {
  it('delivers a message when a publisher dials and immediately publishes', async () => {
    const basePort = 21_000 + Math.floor(Math.random() * 2_000);
    const subscriber = await createNode({
      listenHost: '127.0.0.1',
      listenPort: basePort,
      bootstrapPeers: [],
    });
    const publisher = await createNode({
      listenHost: '127.0.0.1',
      listenPort: basePort + 10,
      bootstrapPeers: [],
    });

    const topic = `aimm/test/quotes/gpt-5.4/${basePort}`;
    const payload = new TextEncoder().encode('quote-now');
    let unsubscribe: (() => void | Promise<void>) | null = null;

    try {
      await subscriber.start();
      await publisher.start();

      const received = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for pubsub message')), 1_000);
        void subscriber.subscribe(topic, (message) => {
          clearTimeout(timer);
          resolve(new TextDecoder().decode(message));
        }).then((stop) => {
          unsubscribe = stop;
        });
      });

      await dialPeerAddress(publisher.libp2p, subscriber.getMultiaddrs()[0]!);
      await publisher.publish(topic, payload);

      await expect(received).resolves.toBe('quote-now');
    } finally {
      await unsubscribe?.();
      await stopQuietly(publisher);
      await stopQuietly(subscriber);
    }
  }, 10_000);
});

async function stopQuietly(node: ClawMarketNode): Promise<void> {
  await node.stop().catch(() => {});
}
