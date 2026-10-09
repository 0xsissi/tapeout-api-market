import type { BuyerNetworkStatus, BuyerWalletSummary, SellerStatusPayload, ServiceStatus } from '../../types.js';

export interface ConsoleSnapshot {
  buyerService: ServiceStatus;
  sellerService: ServiceStatus;
  buyerSummary: BuyerWalletSummary | null;
  sellerSummary: SellerStatusPayload | null;
  networkSummary: BuyerNetworkStatus | null;
  selectedModel: string;
  sellerQuotaWarning: boolean;
  sellerQuotaMessage: string | null;
}

export interface ConsoleEvent {
  time: string;
  scope: string;
  message: string;
}

export interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
  usage?: string;
  state?: 'pending' | 'complete' | 'failed';
  error?: string;
}

export interface PromptModalState {
  type: 'prompt';
  title: string;
  placeholder?: string;
  initialValue: string;
  description?: string;
  onSubmit: (value: string) => Promise<void> | void;
}

export interface ConfirmModalState {
  type: 'confirm';
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => Promise<void> | void;
  onCancel?: () => void;
}

export interface CommandPaletteState {
  type: 'palette';
}

export interface HelpState {
  type: 'help';
}

export interface QuitState {
  type: 'quit';
}

export interface WalletExportState {
  type: 'wallet-export';
  address: string;
  privateKey: string;
}

export interface WalletImportState {
  type: 'wallet-import';
  currentAddress?: string | null;
  onSubmit: (value: string) => Promise<void> | void;
}

export type ModalState =
  | PromptModalState
  | ConfirmModalState
  | CommandPaletteState
  | HelpState
  | QuitState
  | WalletExportState
  | WalletImportState;
export type FocusPane = 'nav' | 'content';
