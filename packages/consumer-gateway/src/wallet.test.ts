import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createPublicClient,
  http,
  formatUnits,
  privateKeyToAccount,
  generatePrivateKey,
} = vi.hoisted(() => ({
  createPublicClient: vi.fn(),
  http: vi.fn((url: string) => ({ url })),
  formatUnits: vi.fn((value: bigint, decimals: number) => {
    const divisor = 10n ** BigInt(decimals);
    const whole = value / divisor;
    const fraction = (value % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole.toString();
  }),
  privateKeyToAccount: vi.fn((key: string) => ({
    address: (`0x${key.slice(-40)}`) as `0x${string}`,
  })),
  generatePrivateKey: vi.fn(() =>
    '0x9999999999999999999999999999999999999999999999999999999999999999',
  ),
}));

vi.mock('viem', () => ({
  createPublicClient,
  http,
  formatUnits,
}));

vi.mock('viem/accounts', () => ({
  privateKeyToAccount,
  generatePrivateKey,
}));

describe('WalletManager', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let readContract: ReturnType<typeof vi.fn>;
  let getBalance: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmarket-wallet-test-'));
    process.env.HOME = tempHome;
    readContract = vi.fn().mockResolvedValue(12_500_000n);
    getBalance = vi.fn().mockResolvedValue(500_000_000_000_000n);
    createPublicClient.mockReset();
    createPublicClient.mockReturnValue({ readContract, getBalance });
    privateKeyToAccount.mockClear();
    generatePrivateKey.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  async function createManager() {
    const { WalletManager } = await import('./wallet.js');
    return new WalletManager('http://127.0.0.1:8545');
  }

  it('throws when accessed before initialization', async () => {
    const manager = await createManager();

    expect(() => manager.getAddress()).toThrow(/not initialized/);
  }, 15_000);

  it('initializes from a provided private key', async () => {
    const manager = await createManager();
    const key = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;

    await manager.init(key);

    expect(manager.getPrivateKey()).toBe(key);
    expect(manager.getAddress()).toBe('0x1111111111111111111111111111111111111111');
  });

  it('loads a stored private key from disk', async () => {
    const walletDir = path.join(tempHome, '.clawmarket');
    fs.mkdirSync(walletDir, { recursive: true });
    fs.writeFileSync(
      path.join(walletDir, 'wallet.json'),
      JSON.stringify({
        privateKey: '0x2222222222222222222222222222222222222222222222222222222222222222',
      }),
    );
    const manager = await createManager();

    await manager.init();

    expect(generatePrivateKey).not.toHaveBeenCalled();
    expect(manager.getAddress()).toBe('0x2222222222222222222222222222222222222222');
  });

  it('generates and persists a new wallet when none is stored', async () => {
    const manager = await createManager();

    await manager.init();

    expect(generatePrivateKey).toHaveBeenCalledOnce();
    const stored = JSON.parse(
      fs.readFileSync(path.join(tempHome, '.clawmarket', 'wallet.json'), 'utf-8'),
    );
    expect(stored.privateKey).toBe(
      '0x9999999999999999999999999999999999999999999999999999999999999999',
    );
  });

  it('migrates the legacy seller-wallet.json file into wallet.json', async () => {
    const walletDir = path.join(tempHome, '.clawmarket');
    fs.mkdirSync(walletDir, { recursive: true });
    fs.writeFileSync(
      path.join(walletDir, 'seller-wallet.json'),
      JSON.stringify({
        privateKey: '0x5555555555555555555555555555555555555555555555555555555555555555',
      }),
    );
    const manager = await createManager();

    await manager.init();

    expect(fs.existsSync(path.join(walletDir, 'wallet.json'))).toBe(true);
    expect(manager.getAddress()).toBe('0x5555555555555555555555555555555555555555');
  });

  it('returns zero balance when the RPC query fails', async () => {
    readContract.mockRejectedValueOnce(new Error('rpc down'));
    const manager = await createManager();
    await manager.init(
      '0x3333333333333333333333333333333333333333333333333333333333333333',
    );

    await expect(manager.getBalance()).resolves.toBe('0');
  });

  it('exports wallet summary with formatted balance', async () => {
    const manager = await createManager();
    await manager.init(
      '0x4444444444444444444444444444444444444444444444444444444444444444',
    );

    await expect(manager.exportWallet()).resolves.toEqual({
      address: '0x4444444444444444444444444444444444444444',
      balance: '12.5',
      nativeBalance: '0.0005',
      nativeBalanceWei: '500000000000000',
    });
  });
});
