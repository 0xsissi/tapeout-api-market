import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Keep this module free of shared/runtime imports: selection precedes their currency constants.
export type PaymentSymbol = 'USDC' | 'BEM';
export function parsePaymentSymbol(value: string): PaymentSymbol {
  const symbol = value.trim().toUpperCase();
  if (symbol !== 'USDC' && symbol !== 'BEM') throw new Error('收款币种只能选择 USDC 或 BEM。');
  return symbol;
}
export function paymentChoicePath(home = process.env.HOME ?? homedir()): string {
  return path.join(home, '.clawmarket', 'payment-choice.json');
}
export async function readPaymentChoice(home?: string): Promise<PaymentSymbol | null> {
  try {
    return parsePaymentSymbol(JSON.parse(await readFile(paymentChoicePath(home), 'utf8')).symbol);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('币种选择文件无效，请用 tam payment use USDC 或 BEM 重新选择。');
  }
}
export async function savePaymentChoice(symbol: PaymentSymbol, home?: string): Promise<void> {
  const file = paymentChoicePath(home);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ symbol: parsePaymentSymbol(symbol), updatedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}
export function extractPaymentOption(args: string[]): { symbol: PaymentSymbol | null; args: string[] } {
  let symbol: PaymentSymbol | null = null;
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === '--payment-token' || argument.startsWith('--payment-token=')) {
      if (symbol) throw new Error('--payment-token 只能指定一次。');
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : args[++index];
      if (!value || value.startsWith('--')) throw new Error('--payment-token 后需要 USDC 或 BEM。');
      symbol = parsePaymentSymbol(value);
    } else remaining.push(argument);
  }
  return { symbol, args: remaining };
}

export async function preparePaymentEnvironment(symbol: PaymentSymbol, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  env.CLAWMARKET_PAYMENT_TOKEN = symbol;
  const network = env.CLAWMARKET_PAYMENT_NETWORK ?? 'default';
  if (!['default', 'bsc-testnet'].includes(network)) throw new Error('测试网络请选择 default 或 bsc-testnet。');
  const home = env.HOME ?? homedir();
  const file = env.CLAWMARKET_CONFIG_PATH ?? path.join(home, '.clawmarket', network === 'bsc-testnet' ? `config-${symbol.toLowerCase()}-bsc-testnet.json` : symbol === 'BEM' ? 'config-bem.json' : 'config.json');
  let settlement: Record<string, unknown> = {};
  try { settlement = JSON.parse(await readFile(file, 'utf8')).settlement ?? {}; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`无法读取配置：${file}`); }
  if (settlement.symbol != null && settlement.symbol !== symbol) throw new Error('配置币种与当前选择不同。请分别保存 USDC 和 BEM 配置，不要共用同一个配置文件。');
  if (settlement.network != null && settlement.network !== network) throw new Error('配置网络与当前选择不同，请使用独立的网络配置。');
  if (!env.ESCROW_POOL_ADDRESS && typeof settlement.escrowPoolAddress === 'string' && settlement.escrowPoolAddress) env.ESCROW_POOL_ADDRESS = settlement.escrowPoolAddress;
  if (!env.RPC_URL && typeof settlement.rpcUrl === 'string' && settlement.rpcUrl) env.RPC_URL = settlement.rpcUrl;
}
