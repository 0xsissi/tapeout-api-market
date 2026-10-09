import type { ClawMarketConfig } from '../config/schema.js';

/** Start with the settings page when launch parameters still need owner input. */
export function needsSettlementConfiguration(config: ClawMarketConfig): boolean {
  const settings = config.settlement;
  if (!settings) return false;
  return !/^0x[0-9a-fA-F]{40}$/.test(settings.escrowPoolAddress) || /^0x0{40}$/i.test(settings.escrowPoolAddress) ||
    [settings.maxRequestCostToken, settings.maxUnconfirmedCreditToken, settings.dailyLimitToken].some(value => !Number.isFinite(value) || value <= 0);
}
