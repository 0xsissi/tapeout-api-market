#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { extractPaymentOption, parsePaymentSymbol, preparePaymentEnvironment, readPaymentChoice, savePaymentChoice } from './payment/selection.js';
import { extractLanguageOption, getUiLanguage, initializeUiLanguage, saveUiLanguage } from './i18n/language.js';

const message = (zh: string, en: string) => getUiLanguage() === 'zh' ? zh : en;

async function launch() {
  const languageOption = extractLanguageOption(process.argv.slice(2));
  await initializeUiLanguage(languageOption.language);
  const parsed = extractPaymentOption(languageOption.args);
  const args = parsed.args;
  if (args[0] === 'language') {
    const value = args[1];
    if (args.length === 2 && (value === 'en' || value === 'zh')) {
      await saveUiLanguage(value);
      console.log(message('界面语言已保存为中文。', 'Interface language saved as English.'));
    } else if (args.length === 1) console.log(JSON.stringify({ language: getUiLanguage(), supported: ['zh', 'en'] }));
    else throw new Error('Usage: tam language [en|zh]');
    return;
  }
  if (process.env.CLAWMARKET_PAYMENT_NETWORK && process.env.CLAWMARKET_PAYMENT_NETWORK !== 'bsc-testnet') throw new Error(message('当前 TAM 内测只使用 BSC 测试网，请清除其他网络覆盖。', 'This TAM pilot uses BSC Testnet only. Remove other network overrides.'));
  if (process.env.CHAIN_ID && Number(process.env.CHAIN_ID) !== 97) throw new Error(message('当前 TAM 内测的 CHAIN_ID 必须为 97。', 'CHAIN_ID must be 97 for the TAM pilot.'));
  process.env.CLAWMARKET_PAYMENT_NETWORK = 'bsc-testnet';
  if (args[0] === 'payment') {
    if (args[1] === 'use' && args.length === 3) {
      const symbol = parsePaymentSymbol(args[2]!);
      await savePaymentChoice(symbol);
      console.log(message(`已选择 ${symbol}，下次启动生效。现有服务继续使用原币种；价格、余额和待收款不会自动转换。`, `${symbol} selected for the next launch. Existing services keep their currency; prices, balances and receivables are not converted.`));
      return;
    }
    if (args.length === 1 || (args[1] === 'list' && args.length === 2)) {
      console.log(JSON.stringify({ selected: parsed.symbol ?? (process.env.CLAWMARKET_PAYMENT_TOKEN ? parsePaymentSymbol(process.env.CLAWMARKET_PAYMENT_TOKEN) : await readPaymentChoice()) ?? 'USDC', choices: [
        { symbol: 'USDC', network: 'BSC Testnet', chainId: 97, config: 'config-usdc-bsc-testnet.json' },
        { symbol: 'BEM', network: 'BSC Testnet', chainId: 97, config: 'config-bem-bsc-testnet.json' },
      ], pricing: message('报价和付款均为卖家选择的代币；不自动兑换', 'Prices and payments use the seller-selected token; no automatic conversion'), switching: message('下次启动生效，独立保存两套价格和限额', 'Applies on next launch; prices and limits are stored separately') }, null, 2));
      return;
    }
    throw new Error('用法：tam payment list | tam payment use USDC | tam payment use BEM');
  }
  let symbol = parsed.symbol ?? (process.env.CLAWMARKET_PAYMENT_TOKEN ? parsePaymentSymbol(process.env.CLAWMARKET_PAYMENT_TOKEN) : await readPaymentChoice());
  if (!symbol && args.length === 0 && stdin.isTTY && stdout.isTTY) {
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      console.log(message('当前网络：BSC 测试网（chain 97）。\n选择报价与收款币种：\n  1. 测试 USDC\n  2. 测试 BEM', 'Network: BSC Testnet (chain 97).\nChoose the pricing and payment token:\n  1. Test USDC\n  2. Test BEM'));
      while (!symbol) {
        const answer = (await prompt.question(message('输入 1 或 2：', 'Enter 1 or 2: '))).trim();
        if (answer === '1' || answer.toUpperCase() === 'USDC') symbol = 'USDC';
        else if (answer === '2' || answer.toUpperCase() === 'BEM') symbol = 'BEM';
        else console.log(message('请选择 1 / USDC 或 2 / BEM。', 'Choose 1 / USDC or 2 / BEM.'));
      }
      await savePaymentChoice(symbol);
    } finally { prompt.close(); }
  }
  symbol ??= 'USDC';
  await preparePaymentEnvironment(symbol);
  process.argv = [process.argv[0]!, process.argv[1]!, ...args];
  await import('./main.js');
}
launch().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
