export type AgentAction = 'invoke' | 'deposit' | 'collect' | 'price';
export interface AgentPolicy {
  version: 1;
  paymentSymbol: 'USDC' | 'BEM';
  paused: boolean;
  allowedActions: AgentAction[];
  dailySpendToken: string;
  maxCallToken: string;
  dailyDepositToken: string;
  models: string[];
  sellerPrice: { minimum: number; maximum: number; maxChangePercent: number; minIntervalSeconds: number };
}
export interface AgentOperation {
  id: string;
  action: AgentAction;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  status: 'pending' | 'succeeded' | 'failed' | 'uncertain';
  message: string;
  reason: string;
  model?: string;
  reservedToken: string;
  chargedToken: string;
  result?: unknown;
}
export interface AgentActionRequest {
  id: string;
  action: AgentAction;
  reason?: string;
  params: Record<string, unknown>;
}
export interface AgentBudget {
  day: string;
  spentToken: string;
  reservedToken: string;
  remainingToken: string;
  depositedToken: string;
  depositReservedToken: string;
}
