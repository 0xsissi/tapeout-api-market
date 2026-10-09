import { PAYMENT_TOKEN, PAYMENT_NATIVE_SYMBOL } from '@clawmarket/shared';
import type { CliDefaults } from '../../config/store.js';
import type { ClawMarketRole } from '../../config/schema.js';
import { needsSettlementConfiguration } from '../../payment/configuration.js';

export type OnboardingStepId =
  | 'role'
  | 'buyer_wallet'
  | 'buyer_start'
  | 'buyer_fund'
  | 'buyer_model'
  | 'buyer_purchase'
  | 'seller_wallet'
  | 'seller_upstream'
  | 'seller_login_method'
  | 'seller_login'
  | 'seller_models'
  | 'seller_input_price'
  | 'seller_output_price'
  | 'seller_max_concurrent'
  | 'seller_gas_check'
  | 'seller_start'
  | 'complete';

export function shouldRunOnboarding(config: CliDefaults): boolean {
  return !config.onboarding.completedAt && !needsSettlementConfiguration(config);
}

export function buildOnboardingStepIds(role: ClawMarketRole | null, includeRoleStep: boolean): OnboardingStepId[] {
  const steps: OnboardingStepId[] = [];
  if (includeRoleStep || !role) {
    steps.push('role');
  }

  if (!role) {
    return steps;
  }

  if (role === 'buyer' || role === 'both') {
    steps.push('buyer_wallet', 'buyer_start', 'buyer_fund', 'buyer_model', 'buyer_purchase');
  }

  if (role === 'seller' || role === 'both') {
    steps.push(
      'seller_wallet',
      'seller_upstream',
      'seller_login_method',
      'seller_login',
      'seller_models',
      'seller_input_price',
      'seller_output_price',
      'seller_max_concurrent',
      'seller_gas_check',
      'seller_start',
    );
  }

  steps.push('complete');
  return steps;
}

export function getStepTitle(stepId: OnboardingStepId): string {
  switch (stepId) {
    case 'role':
      return '选择角色';
    case 'buyer_wallet':
      return '买家钱包与身份';
    case 'buyer_start':
      return '启动买家节点';
    case 'buyer_fund':
      return ('充值 USDC 与 gas').replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL);
    case 'buyer_model':
      return '选择默认模型';
    case 'buyer_purchase':
      return '预充值额度';
    case 'seller_wallet':
      return '卖家钱包';
    case 'seller_upstream':
      return '选择上游账号';
    case 'seller_login_method':
      return '选择登录方式';
    case 'seller_login':
      return '上游登录';
    case 'seller_models':
      return '选择出售模型';
    case 'seller_input_price':
      return '设置底价 p0';
    case 'seller_output_price':
      return '设置斜率 alpha';
    case 'seller_max_concurrent':
      return '设置最大并发';
    case 'seller_gas_check':
      return '检查卖家 gas';
    case 'seller_start':
      return '启动卖家节点';
    case 'complete':
      return '完成';
  }
}
