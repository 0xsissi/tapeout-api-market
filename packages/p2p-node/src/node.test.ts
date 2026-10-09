import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('libp2p', () => ({
  createLibp2p: vi.fn(),
}));
vi.mock('@chainsafe/libp2p-gossipsub', () => ({
  gossipsub: vi.fn((options) => ({ type: 'gossipsub', options })),
}));

import { createLibp2p } from 'libp2p';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { createNode } from './node.js';

describe('createNode relay reservations', () => {
  const createLibp2pMock = vi.mocked(createLibp2p);
  const gossipsubMock = vi.mocked(gossipsub);

  beforeEach(() => {
    createLibp2pMock.mockReset();
    gossipsubMock.mockClear();
  });

  it('keeps relay reservation addresses out of the base listen config', async () => {
    createLibp2pMock.mockResolvedValue(createFakeLibp2p());

    await createNode({
      privateKey: {} as any,
      listenHost: '0.0.0.0',
      listenPort: 9090,
      announceAddresses: ['/ip4/203.0.113.10/tcp/9090'],
      relayListenAddrs: ['/dns4/bootstrap.example.com/tcp/9090/p2p/RELAY/p2p-circuit'],
    });

    const config = createLibp2pMock.mock.calls[0]?.[0];
    expect(config?.addresses?.listen).toEqual([
      '/ip4/0.0.0.0/tcp/9090',
      '/ip4/0.0.0.0/tcp/9091/ws',
    ]);
    expect(config?.addresses?.appendAnnounce).toEqual(['/ip4/203.0.113.10/tcp/9090']);
    expect(config?.addresses?.announce).toBeUndefined();
  });

  it('renews relay slots on sequential calls after the node has started', async () => {
    const fakeNode = createFakeLibp2p();
    createLibp2pMock.mockResolvedValue(fakeNode as any);

    const node = await createNode({
      privateKey: {} as any,
      relayListenAddrs: [
        '/dns4/bootstrap.example.com/tcp/9090/p2p/RELAY/p2p-circuit',
        '/dns4/bootstrap-2.example.com/tcp/9090/p2p/RELAY2/p2p-circuit',
      ],
    });

    await node.start();
    await node.reserveRelaySlots();
    await node.reserveRelaySlots();

    expect(fakeNode.start).toHaveBeenCalledTimes(1);
    expect(fakeNode.components.transportManager.listen).toHaveBeenCalledTimes(2);
    expect(
      fakeNode.components.transportManager.listen.mock.calls[0][0].map((addr: { toString(): string }) => addr.toString()),
    ).toEqual([
      '/dns4/bootstrap.example.com/tcp/9090/p2p/RELAY/p2p-circuit',
      '/dns4/bootstrap-2.example.com/tcp/9090/p2p/RELAY2/p2p-circuit',
    ]);
    expect(
      fakeNode.components.transportManager.listen.mock.calls[1][0].map((addr: { toString(): string }) => addr.toString()),
    ).toEqual([
      '/dns4/bootstrap.example.com/tcp/9090/p2p/RELAY/p2p-circuit',
      '/dns4/bootstrap-2.example.com/tcp/9090/p2p/RELAY2/p2p-circuit',
    ]);
  });

  it('deduplicates only concurrent relay reservation attempts', async () => {
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fakeNode = createFakeLibp2p();
    fakeNode.components.transportManager.listen.mockImplementation(async () => {
      await inFlight;
    });
    createLibp2pMock.mockResolvedValue(fakeNode as any);

    const node = await createNode({
      privateKey: {} as any,
      relayListenAddrs: [
        '/dns4/bootstrap.example.com/tcp/9090/p2p/RELAY/p2p-circuit',
      ],
    });

    await node.start();
    const first = node.reserveRelaySlots();
    const second = node.reserveRelaySlots();
    expect(fakeNode.components.transportManager.listen).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([first, second]);
    expect(fakeNode.components.transportManager.listen).toHaveBeenCalledTimes(1);
  });

  it('does not enable autonat unless explicitly requested', async () => {
    createLibp2pMock.mockResolvedValue(createFakeLibp2p());

    await createNode({
      privateKey: {} as any,
    });

    const defaultConfig = createLibp2pMock.mock.calls[0]?.[0];
    expect(defaultConfig?.services?.autoNAT).toBeUndefined();

    createLibp2pMock.mockReset();
    createLibp2pMock.mockResolvedValue(createFakeLibp2p());

    await createNode({
      privateKey: {} as any,
      enableAutoNAT: true,
    });

    const explicitConfig = createLibp2pMock.mock.calls[0]?.[0];
    expect(explicitConfig?.services?.autoNAT).toBeDefined();
    expect(explicitConfig?.services?.pubsub).toBeDefined();
    expect(gossipsubMock).toHaveBeenCalledWith({
      allowPublishToZeroTopicPeers: true,
      floodPublish: true,
    });
  });

  it('publishes and subscribes through the pubsub service', async () => {
    const fakeNode = createFakeLibp2p();
    createLibp2pMock.mockResolvedValue(fakeNode as any);

    const node = await createNode({
      privateKey: {} as any,
    });

    const received: Uint8Array[] = [];
    const unsubscribe = await node.subscribe('aimm/quotes/gpt-5.4', (message) => {
      received.push(message);
    });

    const payload = new TextEncoder().encode('hello');
    await node.publish('aimm/quotes/gpt-5.4', payload);
    fakeNode.services.pubsub.dispatch('message', {
      topic: 'aimm/quotes/gpt-5.4',
      data: payload,
    });

    expect(fakeNode.services.pubsub.subscribe).toHaveBeenCalledWith('aimm/quotes/gpt-5.4');
    expect(fakeNode.services.pubsub.publish).toHaveBeenCalledWith('aimm/quotes/gpt-5.4', payload);
    expect(new TextDecoder().decode(received[0])).toBe('hello');

    await unsubscribe();
    expect(fakeNode.services.pubsub.unsubscribe).toHaveBeenCalledWith('aimm/quotes/gpt-5.4');
  });
});

function createFakeLibp2p() {
  const listeners = new Set<(event: CustomEvent<{ topic: string; data: Uint8Array }>) => void>();

  return {
    peerId: {
      toString: () => '12D3KooWTestPeer',
    },
    services: {
      pubsub: {
        publish: vi.fn(async () => {}),
        subscribe: vi.fn(() => {}),
        unsubscribe: vi.fn(() => {}),
        addEventListener: vi.fn((_type: 'message', listener: (event: CustomEvent<{ topic: string; data: Uint8Array }>) => void) => {
          listeners.add(listener);
        }),
        removeEventListener: vi.fn((_type: 'message', listener: (event: CustomEvent<{ topic: string; data: Uint8Array }>) => void) => {
          listeners.delete(listener);
        }),
        dispatch(type: 'message', detail: { topic: string; data: Uint8Array }) {
          const event = new CustomEvent(type, { detail });
          for (const listener of listeners) {
            listener(event);
          }
        },
      },
    },
    components: {
      transportManager: {
        listen: vi.fn(async () => {}),
      },
    },
    handle: vi.fn(() => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getMultiaddrs: vi.fn(() => []),
  };
}
