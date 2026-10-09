import { createMockSellerConfigs, type MockClusterPreset } from './mock-seller.config.js';
import { MockSeller } from './mock-seller.js';

export class MockCluster {
  private sellers: MockSeller[];

  constructor(sellers: MockSeller[]) {
    this.sellers = sellers;
  }

  static create(options: {
    count: number;
    preset: MockClusterPreset;
    basePort?: number;
    listenHost?: string;
    model?: string;
  }): MockCluster {
    const configs = createMockSellerConfigs(options);
    return new MockCluster(configs.map((config) => new MockSeller(config)));
  }

  async start(): Promise<void> {
    for (const seller of this.sellers) {
      await seller.start();
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.sellers.map((seller) => seller.stop()));
  }

  getSeedRecords() {
    return this.sellers.map((seller) => seller.toSeedRecord());
  }

  getAnnouncements() {
    return this.sellers.map((seller) => seller.getAnnouncement());
  }

  snapshot() {
    return this.sellers.map((seller) => seller.snapshot());
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const count = Number(args.count ?? 5);
  const preset = (args.preset ?? 'mixed') as MockClusterPreset;
  const basePort = Number(args['base-port'] ?? 22000);
  const model = args.model ?? 'mock-gpt-4';

  const cluster = MockCluster.create({ count, preset, basePort, model });
  await cluster.start();

  console.log(
    JSON.stringify(
      {
        preset,
        count,
        sellers: cluster.getSeedRecords(),
      },
      null,
      2,
    ),
  );

  const shutdown = async () => {
    await cluster.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => {});
}

function parseArgs(argv: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const part = argv[index];
    if (!part?.startsWith('--')) {
      continue;
    }
    output[part.slice(2)] = argv[index + 1] ?? 'true';
    index += 1;
  }
  return output;
}

if (typeof process.argv[1] === 'string' && /mock-cluster(\.js)?$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
