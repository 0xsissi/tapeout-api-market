import type { ClawMarketConfig } from '../../config/schema.js';
import type { CliDefaults } from '../../config/store.js';
import { parsePaymentAmount } from '@clawmarket/shared';

export type ConsoleSettingKey =
  | 'buyer.url'
  | 'buyer.selectedModel'
  | 'buyer.subscribedModels'
  | 'seller.url'
  | 'settlement.rpcUrl'
  | 'settlement.escrowPoolAddress'
  | 'settlement.maxRequestCostToken'
  | 'settlement.maxUnconfirmedCreditToken'
  | 'settlement.dailyLimitToken'
  | 'seller.pricing.input'
  | 'seller.pricing.output'
  | 'seller.pricing.p0'
  | 'seller.pricing.alpha'
  | 'seller.pricing.maxConcurrent';

export function getSettingsItems(config: CliDefaults, selectedModel: string): Array<{ label: string; value: ConsoleSettingKey }> {
  return [
    { label: `结算 RPC = ${config.settlement.rpcUrl}`, value: 'settlement.rpcUrl' },
    { label: `托管合约 = ${config.settlement.escrowPoolAddress}`, value: 'settlement.escrowPoolAddress' },
    { label: `单次最高费用 = ${config.settlement.maxRequestCostToken} ${config.settlement.symbol}`, value: 'settlement.maxRequestCostToken' },
    { label: `卖家未确认信用额度 = ${config.settlement.maxUnconfirmedCreditToken} ${config.settlement.symbol}`, value: 'settlement.maxUnconfirmedCreditToken' },
    { label: `卖家每日额度 = ${config.settlement.dailyLimitToken} ${config.settlement.symbol}`, value: 'settlement.dailyLimitToken' },
    { label: `buyer.url = ${config.buyer.url}`, value: 'buyer.url' },
    { label: `buyer.selectedModel = ${selectedModel}`, value: 'buyer.selectedModel' },
    { label: `buyer.subscribedModels = ${config.buyer.subscribedModels.join(', ')}`, value: 'buyer.subscribedModels' },
    { label: `seller.url = ${config.seller.url}`, value: 'seller.url' },
    { label: `输入价格 = ${config.seller.pricing.input} ${config.settlement.symbol}/百万 Token`, value: 'seller.pricing.input' },
    { label: `输出价格 = ${config.seller.pricing.output} ${config.settlement.symbol}/百万 Token`, value: 'seller.pricing.output' },
    { label: `动态报价底价 = ${config.seller.pricing.p0 ?? config.seller.pricing.input} ${config.settlement.symbol}/百万 Token`, value: 'seller.pricing.p0' },
    { label: `随负载调价系数 = ${config.seller.pricing.alpha ?? 1}`, value: 'seller.pricing.alpha' },
    { label: `卖家并发上限 = ${config.seller.pricing.maxConcurrent ?? 5}`, value: 'seller.pricing.maxConcurrent' },
  ];
}

export function getSettingValue(config: CliDefaults, key: ConsoleSettingKey): string {
  switch (key) {
    case 'settlement.rpcUrl':
    case 'settlement.escrowPoolAddress':
    case 'settlement.maxRequestCostToken':
    case 'settlement.maxUnconfirmedCreditToken':
    case 'settlement.dailyLimitToken':
      return String(config.settlement[key.split('.')[1] as keyof typeof config.settlement]);
    case 'buyer.url':
      return config.buyer.url;
    case 'buyer.selectedModel':
      return config.buyer.selectedModel;
    case 'buyer.subscribedModels':
      return config.buyer.subscribedModels.join(', ');
    case 'seller.url':
      return config.seller.url;
    case 'seller.pricing.input':
      return String(config.seller.pricing.input);
    case 'seller.pricing.output':
      return String(config.seller.pricing.output);
    case 'seller.pricing.p0':
      return String(config.seller.pricing.p0 ?? config.seller.pricing.input);
    case 'seller.pricing.alpha':
      return String(config.seller.pricing.alpha ?? 1);
    case 'seller.pricing.maxConcurrent':
      return String(config.seller.pricing.maxConcurrent ?? 5);
  }
}

export function applySetting(
  config: CliDefaults,
  key: ConsoleSettingKey,
  nextValue: string,
  fallbackModel: string,
): ClawMarketConfig {
  const { paths, ...configBody } = config;

  switch (key) {
    case 'settlement.rpcUrl': {
      const url = new URL(nextValue.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请填写不含登录凭据的 HTTP/HTTPS RPC 地址。');
      return { ...configBody, settlement: { ...config.settlement, rpcUrl: nextValue.trim() } };
    }
    case 'settlement.escrowPoolAddress':
      if (!/^0x[0-9a-fA-F]{40}$/.test(nextValue.trim()) || /^0x0{40}$/i.test(nextValue.trim())) throw new Error('请填写已部署的托管合约地址，不是代币地址。');
      return { ...configBody, settlement: { ...config.settlement, escrowPoolAddress: nextValue.trim() } };
    case 'settlement.maxRequestCostToken':
    case 'settlement.maxUnconfirmedCreditToken':
    case 'settlement.dailyLimitToken': {
      if (!nextValue.trim() || !Number.isFinite(Number(nextValue)) || Number(nextValue) <= 0) throw new Error(`额度必须大于 0，单位为 ${config.settlement.symbol}。`);
      parsePaymentAmount(nextValue.trim());
      const field = key.split('.')[1]!;
      return { ...configBody, settlement: { ...config.settlement, [field]: Number(nextValue) } };
    }
    case 'buyer.url':
      return { ...configBody, buyer: { ...configBody.buyer, url: nextValue.trim() } };
    case 'buyer.selectedModel':
      return { ...configBody, buyer: { ...configBody.buyer, selectedModel: nextValue.trim() || fallbackModel } };
    case 'buyer.subscribedModels': {
      const subscribedModels = nextValue
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      if (subscribedModels.length === 0) {
        throw new Error('buyer.subscribedModels 至少要保留一个模型。');
      }
      return {
        ...configBody,
        buyer: {
          ...configBody.buyer,
          subscribedModels,
          selectedModel: subscribedModels.includes(configBody.buyer.selectedModel)
            ? configBody.buyer.selectedModel
            : subscribedModels[0]!,
        },
      };
    }
    case 'seller.url':
      return { ...configBody, seller: { ...configBody.seller, url: nextValue.trim() } };
    case 'seller.pricing.input':
      if (!nextValue.trim() || !Number.isFinite(Number(nextValue)) || Number(nextValue) <= 0) {
        throw new Error('seller.pricing.input 必须是合法数字。');
      }
      return {
        ...configBody,
        seller: {
          ...configBody.seller,
          pricing: { ...configBody.seller.pricing, input: Number(nextValue) },
        },
      };
    case 'seller.pricing.output':
      if (!nextValue.trim() || !Number.isFinite(Number(nextValue)) || Number(nextValue) <= 0) {
        throw new Error('seller.pricing.output 必须是合法数字。');
      }
      return {
        ...configBody,
        seller: {
          ...configBody.seller,
          pricing: { ...configBody.seller.pricing, output: Number(nextValue) },
        },
      };
    case 'seller.pricing.p0':
      if (!Number.isFinite(Number(nextValue)) || Number(nextValue) <= 0) {
        throw new Error('seller.pricing.p0 必须是大于 0 的合法数字。');
      }
      return {
        ...configBody,
        seller: {
          ...configBody.seller,
          pricing: { ...configBody.seller.pricing, p0: Number(nextValue) },
        },
      };
    case 'seller.pricing.alpha':
      if (!Number.isFinite(Number(nextValue)) || Number(nextValue) < 0) {
        throw new Error('seller.pricing.alpha 必须是大于等于 0 的合法数字。');
      }
      return {
        ...configBody,
        seller: {
          ...configBody.seller,
          pricing: { ...configBody.seller.pricing, alpha: Number(nextValue) },
        },
      };
    case 'seller.pricing.maxConcurrent':
      if (!Number.isInteger(Number(nextValue)) || Number(nextValue) <= 0) {
        throw new Error('seller.pricing.maxConcurrent 必须是正整数。');
      }
      return {
        ...configBody,
        seller: {
          ...configBody.seller,
          pricing: { ...configBody.seller.pricing, maxConcurrent: Number(nextValue) },
        },
      };
  }
}
