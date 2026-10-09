import { PAYMENT_TOKEN, PAYMENT_NATIVE_SYMBOL, translateUiText } from '@clawmarket/shared';
import type { BuyerNetworkStatus, NetworkProviderSummary, SellerStatusPayload } from '../../types.js';

export type ConsoleViewId = 'dashboard' | 'wallet' | 'chat' | 'network' | 'usage' | 'seller' | 'accounts' | 'claims' | 'agent' | 'settings';

export interface ConsoleNavItem {
  id: ConsoleViewId;
  label: string;
}

export interface ConsoleCommand {
  id: string;
  label: string;
  keywords: string[];
}

export const consoleNavItems: ConsoleNavItem[] = [
  { id: 'dashboard', label: '总览' },
  { id: 'wallet', label: '余额与充值' },
  { id: 'chat', label: '调用体验' },
  { id: 'network', label: '服务市场' },
  { id: 'usage', label: 'API 接入' },
  { id: 'seller', label: '我的服务' },
  { id: 'accounts', label: '上游账号' },
  { id: 'claims', label: '收入与收款' },
  { id: 'agent', label: 'AI 管理' },
  { id: 'settings', label: '设置' },
];

export function isCompactConsole(width: number): boolean {
  return width < 80;
}

export function filterConsoleCommands(commands: ConsoleCommand[], query: string): ConsoleCommand[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return commands;
  }

  return commands
    .map((command) => ({
      command,
      score: scoreCommand(command, normalized),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.command.label.localeCompare(right.command.label))
    .map((entry) => entry.command);
}

function scoreCommand(command: ConsoleCommand, query: string): number {
  const haystacks = [command.label, translateUiText(command.label, 'en'), ...command.keywords].map((item) => item.toLowerCase());
  let best = 0;
  for (const haystack of haystacks) {
    if (haystack === query) {
      best = Math.max(best, 100);
      continue;
    }
    if (haystack.includes(query)) {
      best = Math.max(best, 60 - Math.max(0, haystack.indexOf(query)));
      continue;
    }
    if (query.split(/\s+/).every((token) => haystack.includes(token))) {
      best = Math.max(best, 30);
    }
  }
  return best;
}

export function getAvailableModels(networkSummary: BuyerNetworkStatus | null): string[] {
  return Array.from(
    new Set(
      (networkSummary?.models ?? [])
        .filter((item) => item.providerCount > 0 || item.bestProvider)
        .map((item) => item.model),
    ),
  );
}

export function getSelectedProvider(networkSummary: BuyerNetworkStatus | null, selectedModel: string): NetworkProviderSummary | null {
  const model = networkSummary?.models.find((item) => item.model === selectedModel);
  return model?.bestProvider ?? networkSummary?.bestProvider ?? null;
}

export function hasHealthyP2p(snapshot: {
  networkSummary: BuyerNetworkStatus | null;
  selectedModel: string;
  sellerSummary: SellerStatusPayload | null;
}): boolean {
  if (getSelectedProvider(snapshot.networkSummary, snapshot.selectedModel)) {
    return true;
  }

  const reachabilityStatus = snapshot.sellerSummary?.reachability?.status;
  return reachabilityStatus === 'public_direct' || reachabilityStatus === 'relay';
}

export function formatProviderPrice(provider: NetworkProviderSummary | null): string {
  if (!provider) {
    return '暂无';
  }

  if (typeof provider.p0 === 'number') {
    const alpha = typeof provider.alpha === 'number' ? provider.alpha : 1;
    return `AIMM p0=${provider.p0} α=${alpha}`;
  }

  return (`${provider.inputPer1m}/${provider.outputPer1m} USDC/1M`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL);
}
