import { PRODUCT_NAME, PRODUCT_SHORT_NAME, PAYMENT_TOKEN, PAYMENT_NATIVE_SYMBOL, PAYMENT_NETWORK_NAME, PAYMENT_FUNDING_HELP } from '@clawmarket/shared';
import { Box, render, useApp, useInput, useStdout, useWindowSize } from 'ink';
import { Text, getUiLocale } from '../../i18n/Text.js';
import { startTransition, useEffect, useRef, useState } from 'react';

import { saveCliConfig, type CliDefaults } from '../../config/store.js';
import type { ClawMarketConfig, SellerUpstream } from '../../config/schema.js';
import { addressFromPrivateKey } from '../../services/chain.js';
import {
  getDefaultBuyerRuntimeOptions,
  getManagedBuyerRuntime,
  cancelBuyerStartup,
  startBuyerRuntime,
  stopBuyerRuntime,
} from '../../runtime/buyer-runtime.js';
import { cancelSellerStartup, getDefaultSellerRuntimeOptions, getManagedSellerRuntime, startSellerRuntime, stopSellerRuntime } from '../../runtime/seller-runtime.js';
import { executeFlushClaims, loadSeededNetworkStatus, loadSellerSummary } from '../../services/seller.js';
import { loadBuyerNetworkStatus, loadBuyerSummary } from '../../services/buyer.js';
import { getServiceStatus } from '../../services/http.js';
import { theme } from '../../theme.js';
import type { UpdateCheckResult } from '../../update-check.js';
import { formatTxLink } from '../helpers/tx-link.js';
import { normalizeUrl, readPrivateKeyFromWallet, shortenAddress } from '../../utils.js';
import { CLI_DISPLAY_VERSION } from '../../version.js';
import { checkWalletGas } from '../../wallet/gas-check.js';
import { ensureStoredWallet, importStoredWallet } from '../../wallet/store.js';
import { CommandPalette } from './components/CommandPalette.js';
import { ConfirmModal } from './components/ConfirmModal.js';
import { ConsoleFrame } from './components/ConsoleFrame.js';
import { HelpModal } from './components/HelpModal.js';
import { PromptModal } from './components/PromptModal.js';
import { QuitModal } from './components/QuitModal.js';
import {
  consoleNavItems,
  filterConsoleCommands,
  getAvailableModels,
  hasHealthyP2p,
  type ConsoleCommand,
  type ConsoleViewId,
} from './lib.js';
import { AccountsView } from './views/Accounts.js';
import { ChatView } from './views/Chat.js';
import { ClaimsView } from './views/Claims.js';
import { DashboardView } from './views/Dashboard.js';
import { NetworkView } from './views/Network.js';
import { SellerView } from './views/Seller.js';
import { SettingsView } from './views/Settings.js';
import { UsageView } from './views/Usage.js';
import { WalletView } from './views/Wallet.js';
import { AgentView } from './views/Agent.js';
import { AgentController, agentStoreFor, localAgentBackend } from '../../agent/controller.js';
import { needsSettlementConfiguration } from '../../payment/configuration.js';
import type { ChatEntry, ConsoleSnapshot, ConsoleEvent, FocusPane, ModalState } from './types.js';
import { ExportView } from '../wallet/ExportView.js';
import { ImportView } from '../wallet/ImportView.js';
import { useUiLanguage } from '../../i18n/Text.js';
import { saveUiLanguage } from '../../i18n/language.js';
import { StartupProgress, type StartupState } from './components/StartupProgress.js';

export interface ConsoleExitResult {
  action: 'exit' | 'onboarding' | 'seller_login';
  upstream?: SellerUpstream;
  replaceAuth?: boolean;
  restartSeller?: boolean;
  forceFreshLogin?: boolean;
}

interface RunConsoleOptions {
  config: CliDefaults;
  initialEvents?: Array<{ scope: string; message: string }>;
  updateCheckPromise?: Promise<UpdateCheckResult>;
}

const refreshIntervalMs = 3000;

export async function runConsoleApp(options: RunConsoleOptions): Promise<ConsoleExitResult> {
  const controller = new AgentController(agentStoreFor(options.config), localAgentBackend(options.config));
  let controllerStarted = false;
  const initialEvents = [...(options.initialEvents ?? [])];
  if (needsSettlementConfiguration(options.config)) initialEvents.push({ scope: '结算设置', message: `请先填写 ${PAYMENT_TOKEN.symbol} 托管合约和额度。然后重新启动 TAM，或运行初始化向导准备买家和卖家。` });
  try { const url = await controller.start(); controllerStarted = true; initialEvents.push({ scope: 'AI 管理', message: `本地 AI 入口已启动：${url}。自动权限由“AI 管理”页设置。` }); }
  catch { initialEvents.push({ scope: 'AI 管理', message: '管理入口未在本次控制台启动；如已运行独立 agent serve，请继续使用该进程。' }); }
  const app = render(
    <ConsoleApp
      config={options.config}
      initialEvents={initialEvents}
      updateCheckPromise={options.updateCheckPromise}
    />,
    { alternateScreen: true, incrementalRendering: true },
  );
  let result: ConsoleExitResult = { action: 'exit' };
  try {
    result = (await app.waitUntilExit() as ConsoleExitResult | undefined) ?? { action: 'exit' };
    return result;
  } catch (error) {
    if (!error) {
      return { action: 'exit' };
    }
    throw error;
  } finally {
    app.unmount();
    await Promise.allSettled([cancelBuyerStartup(), cancelSellerStartup()]);
    if (result.action === 'exit') await Promise.allSettled([stopBuyerRuntime(), stopSellerRuntime()]);
    if (controllerStarted) await controller.stop();
  }
}

export function ConsoleApp({
  config: initialConfig,
  initialEvents = [],
  updateCheckPromise,
}: RunConsoleOptions) {
  const { exit } = useApp();
  const uiLanguage = useUiLanguage();
  const { stdout } = useStdout();
  const windowSize = useWindowSize();
  const [config, setConfig] = useState(() => initialConfig);
  const selectedModelRef = useRef(initialConfig.buyer.selectedModel);
  const networkSummaryRef = useRef<ConsoleSnapshot['networkSummary']>(null);
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot>({
    buyerService: { online: false, message: 'checking...' },
    sellerService: { online: false, message: 'checking...' },
    buyerSummary: null,
    sellerSummary: null,
    networkSummary: null,
    selectedModel: initialConfig.buyer.selectedModel,
    sellerQuotaWarning: getManagedSellerRuntime()?.quotaWarning ?? false,
    sellerQuotaMessage: getManagedSellerRuntime()?.lastQuotaWarning ?? null,
  });
  const [events, setEvents] = useState<ConsoleEvent[]>(() => [
    {
      time: formatClock(),
      scope: '系统',
      message: `${PRODUCT_NAME} (${PRODUCT_SHORT_NAME}) Console 已就绪。`,
    },
    ...initialEvents.map((event) => ({
      time: formatClock(),
      scope: event.scope,
      message: event.message,
    })),
  ]);
  const [chatHistory, setChatHistory] = useState<ChatEntry[]>([]);
  const [viewIndex, setViewIndex] = useState(needsSettlementConfiguration(initialConfig) ? indexOfView('settings') : 0);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [focusPane, setFocusPane] = useState<FocusPane>('nav');
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const actionBusyRef = useRef(false);
  const [buyerStarting, setBuyerStarting] = useState(false);
  const [sellerStarting, setSellerStarting] = useState(false);
  const [buyerProgress, setBuyerProgress] = useState<StartupState | null>(null);
  const [sellerProgress, setSellerProgress] = useState<StartupState | null>(null);
  const sellerStartRef = useRef<Promise<void> | null>(null);
  const buyerStartRef = useRef<Promise<void> | null>(null);
  const buyerStartupController = useRef(new AbortController());
  const sellerStartupController = useRef(new AbortController());
  const mountedRef = useRef(true);
  const [quitting, setQuitting] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const lastReachabilityRef = useRef<string | null>(null);
  const previousHealthRef = useRef<{ buyer: boolean | null; seller: boolean | null }>({ buyer: null, seller: null });
  const currentView = consoleNavItems[viewIndex]?.id ?? 'dashboard';
  const hasModal = modal != null;
  const commandEntries: ConsoleCommand[] = [
    { id: 'buyer-up', label: 'Start buyer', keywords: ['buyer', 'up', 'start'] },
    { id: 'buyer-down', label: 'Stop buyer', keywords: ['buyer', 'down', 'stop'] },
    { id: 'seller-up', label: 'Start seller', keywords: ['seller', 'up', 'start'] },
    { id: 'seller-down', label: 'Stop seller', keywords: ['seller', 'down', 'stop'] },
    { id: 'open-wallet', label: 'Open wallet', keywords: ['wallet', 'funds', 'deposit', 'withdraw'] },
    { id: 'wallet-export', label: 'Export private key', keywords: ['wallet', 'export', 'backup', 'private key'] },
    { id: 'wallet-import', label: 'Import private key', keywords: ['wallet', 'import', 'private key'] },
    { id: 'flush-claims', label: '立即结算收入', keywords: ['seller', 'claims', 'flush'] },
    { id: 'open-accounts', label: 'Open accounts', keywords: ['account', 'accounts', 'auth', 'login'] },
    { id: 'account-switch-backup', label: 'Account: Switch backup', keywords: ['account', 'switch', 'backup', 'auth'] },
    { id: 'account-logout', label: 'Account: Logout', keywords: ['account', 'logout', 'auth'] },
    { id: 'account-login-codex', label: 'Account: Login new Codex', keywords: ['account', 'login', 'codex', 'chatgpt'] },
    { id: 'account-login-claude', label: 'Account: Login new Claude', keywords: ['account', 'login', 'claude'] },
    { id: 'account-login-gemini', label: 'Account: Login new Gemini', keywords: ['account', 'login', 'gemini', 'google'] },
    { id: 'open-chat', label: 'Open chat', keywords: ['chat', 'ask'] },
    { id: 'open-network', label: 'Open network', keywords: ['network', 'providers', 'models'] },
    { id: 'open-usage', label: 'Open API usage', keywords: ['api', 'usage', 'docs', 'curl', 'openai'] },
    { id: 'open-settings', label: 'Open settings', keywords: ['settings', 'config'] },
    { id: 'run-init', label: 'Run onboarding', keywords: ['init', 'wizard', 'onboarding'] },
  ];
  const filteredCommands = filterConsoleCommands(commandEntries, paletteQuery).slice(0, 8);

  const pushEvent = (scope: string, message: string) => {
    setEvents((current) => [...current, { time: formatClock(), scope, message }].slice(-40));
  };

  const openWalletExportModal = async () => {
    const wallet = await ensureStoredWallet({
      walletPath: config.paths.walletPath,
      legacyWalletPath: config.paths.legacySellerWalletPath,
    });
    setModal({
      type: 'wallet-export',
      address: wallet.wallet.address,
      privateKey: wallet.wallet.privateKey,
    });
  };

  const openWalletImportModal = () => {
    setModal({
      type: 'wallet-import',
      currentAddress: snapshot.buyerSummary?.address ?? null,
      onSubmit: async (value) => {
        const result = await importStoredWallet(value, {
          walletPath: config.paths.walletPath,
          backupExisting: true,
        });
        pushEvent('钱包', `已导入新钱包：${result.wallet.address}`);
        pushEvent('钱包', '如果 buyer / seller 正在运行，请重启后让新钱包生效。');
      },
    });
  };

  const saveConfig = async (nextConfig: ClawMarketConfig) => {
    await saveCliConfig(nextConfig, { homeDir: config.paths.homeDir });
    setConfig((current) => ({ ...current, ...nextConfig }));
  };

  const flushSellerClaimsWithGasCheck = async () => {
    const privateKey = await readPrivateKeyFromWallet(config.seller.walletPath, 'seller wallet');
    const gas = await checkWalletGas(addressFromPrivateKey(privateKey), BigInt(config.seller.minGasWei));
    if (!gas.ok) {
      setModal({
        type: 'confirm',
        title: ('ETH gas 不足').replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL),
        description: [
          (`当前余额：${gas.currentEth} ETH`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL),
          (`预计需要：${gas.minEth} ETH`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL),
          `钱包地址：${gas.address}`,
          PAYMENT_FUNDING_HELP,
        ].join('\n'),
        confirmLabel: '我已充值，继续',
        cancelLabel: '取消',
        onConfirm: async () => {
          const refreshed = await checkWalletGas(gas.address, BigInt(config.seller.minGasWei));
          if (!refreshed.ok) throw new Error(`${PAYMENT_NETWORK_NAME} 手续费余额仍不足，请到账后再收款。`);
          const result = await executeFlushClaims(config.seller.url);
          pushEvent('卖家', result.flushed && result.txHash ? `收款已确认： ${formatTxLink(result.txHash)}` : result.claims.queuedCount > 0 ? '尚有待收款收入，但本次未确认结算。请核对手续费与交易记录。' : '当前没有可结算收入。');
        },
      });
      return;
    }

    const result = await executeFlushClaims(config.seller.url);
    pushEvent('卖家', result.flushed && result.txHash ? `收款已确认： ${formatTxLink(result.txHash)}` : result.claims.queuedCount > 0 ? '尚有待收款收入，但本次未确认结算。请核对手续费与交易记录。' : '当前没有可结算收入。');
  };

  const refresh = async () => {
    const buyerUrl = normalizeUrl(config.buyer.url);
    const sellerUrl = normalizeUrl(config.seller.url);
    const next: ConsoleSnapshot = {
      buyerService: await getServiceStatus(`${buyerUrl}/health`, 'buyer'),
      sellerService: await getServiceStatus(`${sellerUrl}/health`, 'seller'),
      buyerSummary: null,
      sellerSummary: null,
      networkSummary: networkSummaryRef.current,
      selectedModel: selectedModelRef.current,
      sellerQuotaWarning: getManagedSellerRuntime()?.quotaWarning ?? false,
      sellerQuotaMessage: getManagedSellerRuntime()?.lastQuotaWarning ?? null,
    };

    if (next.buyerService.online) {
      try {
        const [, wallet] = await loadBuyerSummary(buyerUrl);
        next.buyerSummary = wallet;
      } catch {
        next.buyerSummary = null;
      }
      try {
        next.networkSummary = await loadBuyerNetworkStatus(buyerUrl);
        networkSummaryRef.current = next.networkSummary;
      } catch {
        const seededNetwork = await loadSeededNetworkStatus(config.buyer.seedProvidersFile, selectedModelRef.current);
        next.networkSummary = seededNetwork ?? networkSummaryRef.current;
        if (seededNetwork) {
          networkSummaryRef.current = seededNetwork;
        }
      }
    } else {
      next.networkSummary = null;
      networkSummaryRef.current = null;
    }

    if (next.sellerService.online) {
      try {
        next.sellerSummary = await loadSellerSummary(sellerUrl);
      } catch {
        next.sellerSummary = null;
      }
    }

    const availableModels = getAvailableModels(next.networkSummary);
    if (availableModels.length > 0 && !availableModels.includes(next.selectedModel)) {
      next.selectedModel = availableModels.includes(selectedModelRef.current) ? selectedModelRef.current : availableModels[0]!;
      selectedModelRef.current = next.selectedModel;
    }

    const previous = previousHealthRef.current;
    if (previous.buyer != null && previous.buyer !== next.buyerService.online) {
      pushEvent('买家', next.buyerService.online ? 'buyer 已连接。' : `buyer 离线: ${next.buyerService.message}`);
    }
    if (previous.seller != null && previous.seller !== next.sellerService.online) {
      pushEvent('卖家', next.sellerService.online ? 'seller 已连接。' : `seller 离线: ${next.sellerService.message}`);
    }
    previousHealthRef.current = { buyer: next.buyerService.online, seller: next.sellerService.online };

    const nextReachability = next.sellerSummary?.reachability?.label ?? null;
    if (nextReachability && nextReachability !== lastReachabilityRef.current) {
      pushEvent('网络', `本机 seller 可连接性: ${nextReachability}`);
      lastReachabilityRef.current = nextReachability;
    }

    startTransition(() => {
      if (mountedRef.current) setSnapshot(next);
    });
  };

  const startConsoleBuyer = (): Promise<void> => {
    if (buyerStartRef.current) return buyerStartRef.current;
    if (needsSettlementConfiguration(config)) {
      setViewIndex(indexOfView('settings'));
      const message = '请先在“设置”填写当前币种的托管合约和额度，再启动买家。';
      setActionError(message);
      return Promise.reject(new Error(message));
    }
    setActionError(null);
    setBuyerStarting(true);
    setBuyerProgress({ phase: 'checking', startedAt: Date.now() });
    pushEvent('买家', '正在启动或连接买家，菜单仍可操作。');
    const promise = startBuyerRuntime({
      ...getDefaultBuyerRuntimeOptions(config),
      signal: buyerStartupController.current.signal,
      report: line => { if (mountedRef.current) pushEvent('买家', line); },
      onProgress: phase => { if (mountedRef.current) setBuyerProgress(current => current ? { ...current, phase } : null); },
    }).then(() => {
      if (mountedRef.current && !buyerStartupController.current.signal.aborted) {
        setSnapshot(current => ({ ...current, buyerService: { online: true, message: 'online' } }));
        void refresh().catch(() => {});
      }
    }).catch(error => {
      if (mountedRef.current && !buyerStartupController.current.signal.aborted && !(error instanceof Error && error.name === 'AbortError')) {
        const message = error instanceof Error ? error.message : String(error);
        setActionError(`${message}\n可在总览选择“启动买家服务”重试，或在设置中检查配置。`);
        pushEvent('买家', `买家启动未完成：${message.split('\n')[0]}`);
      }
      throw error;
    }).finally(() => {
      buyerStartRef.current = null;
      if (mountedRef.current) setBuyerStarting(false);
      if (mountedRef.current) setBuyerProgress(null);
    });
    buyerStartRef.current = promise;
    return promise;
  };

  const startConsoleSeller = (runtimeConfig = config): Promise<void> => {
    if (sellerStartRef.current) return sellerStartRef.current;
    setActionError(null);
    setSellerStarting(true);
    setSellerProgress({ phase: 'checking', startedAt: Date.now() });
    pushEvent('卖家', '正在启动卖家，菜单仍可操作。');
    const promise = startSellerRuntime({
      ...getDefaultSellerRuntimeOptions(runtimeConfig),
      signal: sellerStartupController.current.signal,
      report: line => { if (mountedRef.current) pushEvent('卖家', line); },
      onProgress: phase => { if (mountedRef.current) setSellerProgress(current => current ? { ...current, phase } : null); },
    }).then(() => {
      if (mountedRef.current) {
        setSnapshot(current => ({ ...current, sellerService: { online: true, message: 'online' } }));
        void refresh().catch(() => {});
      }
    }).catch(error => {
      if (mountedRef.current && !(error instanceof Error && error.name === 'AbortError')) setActionError(error instanceof Error ? error.message : String(error));
      throw error;
    }).finally(() => {
      sellerStartRef.current = null;
      if (mountedRef.current) { setSellerStarting(false); setSellerProgress(null); }
    });
    sellerStartRef.current = promise;
    return promise;
  };

  useEffect(() => {
    if (!needsSettlementConfiguration(initialConfig)) void startConsoleBuyer().catch(() => {});
    return () => {
      mountedRef.current = false;
      buyerStartupController.current.abort();
      sellerStartupController.current.abort();
    };
  // Start once per console entry. Refreshes, language changes and manual stops never restart it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, refreshIntervalMs);
    return () => {
      clearInterval(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.buyer.seedProvidersFile, config.buyer.url, config.seller.url]);

  useEffect(() => {
    setPaletteIndex(0);
  }, [paletteQuery]);

  useEffect(() => {
    setPaletteIndex((current) => Math.min(current, Math.max(0, filteredCommands.length - 1)));
  }, [filteredCommands.length]);

  useEffect(() => {
    if (!updateCheckPromise) {
      return;
    }

    let cancelled = false;
    void updateCheckPromise.then((result) => {
      if (!cancelled) {
        setUpdateResult(result);
      }
    }).catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [updateCheckPromise]);

  useEffect(() => {
    // A configured console prepares its wallet in the buyer startup; avoid competing creation.
    if (!needsSettlementConfiguration(initialConfig)) return;
    let cancelled = false;

    void ensureStoredWallet({
      walletPath: config.paths.walletPath,
      legacyWalletPath: config.paths.legacySellerWalletPath,
    }).then((result) => {
      if (!cancelled && result.created) {
        pushEvent('钱包', `✓ 钱包已创建：${shortenAddress(result.wallet.address)} | 按 E 导出私钥备份。机器丢了 = 钱没了。`);
      }
    }).catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [config.paths.legacySellerWalletPath, config.paths.walletPath]);

  useInput((input, key) => {
    if (!modal && input.toLowerCase() === 'l') {
      void saveUiLanguage(uiLanguage === 'en' ? 'zh' : 'en', config.paths.homeDir).catch(error => setActionError(String(error)));
      return;
    }
    // A pending operation blocks another submission, never the way back to the menu.
    if (!modal && (key.tab || key.escape || key.leftArrow)) {
      setFocusPane('nav');
      if (key.tab) setViewIndex((current) => cycleViewIndex(current, key.shift ? -1 : 1));
      return;
    }
    if (!modal && focusPane === 'nav' && (key.upArrow || key.downArrow)) {
      setViewIndex((current) => cycleViewIndex(current, key.upArrow ? -1 : 1));
      return;
    }
    if (actionBusyRef.current) return;
    if (modal?.type === 'help') {
      if (key.escape || key.return || input === '?') {
        setModal(null);
      }
      return;
    }

    if (modal?.type === 'quit') {
      if (key.escape && !quitting) {
        setModal(null);
      }
      return;
    }

    if (modal?.type === 'prompt' || modal?.type === 'wallet-import' || modal?.type === 'wallet-export') {
      if (key.escape) {
        setModal(null);
      }
      return;
    }

    if (modal?.type === 'confirm') {
      if (key.escape) {
        modal.onCancel?.();
        setModal(null);
      }
      return;
    }

    if (modal?.type === 'palette') {
      if (key.escape) {
        setModal(null);
        setPaletteQuery('');
        setPaletteIndex(0);
        return;
      }

      if (key.upArrow) {
        setPaletteIndex((current) => Math.max(0, current - 1));
        return;
      }

      if (key.downArrow) {
        setPaletteIndex((current) => Math.min(filteredCommands.length - 1, current + 1));
        return;
      }

      if (/^[1-8]$/.test(input)) {
        const next = filteredCommands[Number(input) - 1];
        if (next) {
          void runCommandSafely(next.id);
        }
        return;
      }

      return;
    }

    if (focusPane === 'nav') {
      if (key.upArrow) {
        setViewIndex((current) => cycleViewIndex(current, -1));
        return;
      }

      if (key.downArrow) {
        setViewIndex((current) => cycleViewIndex(current, 1));
        return;
      }

      if (key.return || key.rightArrow) {
        setFocusPane('content');
        return;
      }
    }

    if (focusPane === 'content') {
      if (key.escape || key.leftArrow) {
        setFocusPane('nav');
        return;
      }
    }

    if (input === '/') {
      setPaletteQuery('');
      setPaletteIndex(0);
      setModal({ type: 'palette' });
      return;
    }

    if (input === '?') {
      setModal({ type: 'help' });
      return;
    }

    if (input.toLowerCase() === 'e' && !(currentView === 'wallet' && focusPane === 'content')) {
      void openWalletExportModal().catch((error) => {
        setActionError(error instanceof Error ? error.message : String(error));
      });
      return;
    }

    if (input.toLowerCase() === 'i' && !(currentView === 'wallet' && focusPane === 'content')) {
      openWalletImportModal();
      return;
    }

    if (input === 'q') {
      setModal({ type: 'quit' });
    }
  });

  const runCommandSafely = async (commandId: string) => {
    try {
      await runCommand(commandId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(message);
      pushEvent('错误', message.split('\n')[0] ?? message);
    }
  };

  const runCommand = async (commandId: string) => {
    setActionError(null);
    setModal(null);
    setPaletteQuery('');
    setPaletteIndex(0);

    switch (commandId) {
      case 'buyer-up':
        await startConsoleBuyer();
        break;
      case 'buyer-down':
        await stopBuyerRuntime((line) => pushEvent('买家', line));
        break;
      case 'seller-up':
        await startConsoleSeller();
        pushEvent('卖家', 'seller 启动完成。');
        break;
      case 'seller-down':
        await stopSellerRuntime((line) => pushEvent('卖家', line));
        break;
      case 'open-wallet':
        setViewIndex(indexOfView('wallet'));
        setFocusPane('content');
        break;
      case 'wallet-export':
        await openWalletExportModal();
        break;
      case 'wallet-import':
        openWalletImportModal();
        break;
      case 'flush-claims': {
        await flushSellerClaimsWithGasCheck();
        break;
      }
      case 'open-accounts':
      case 'account-switch-backup':
      case 'account-logout':
        setViewIndex(indexOfView('accounts'));
        setFocusPane('content');
        if (commandId === 'account-switch-backup') {
          pushEvent('账号', '在 Accounts 视图选择要恢复的备份。');
        }
        if (commandId === 'account-logout') {
          pushEvent('账号', '在 Accounts 视图选择“登出当前账号”。');
        }
        break;
      case 'account-login-codex':
        exit({ action: 'seller_login', upstream: 'codex', replaceAuth: true, restartSeller: true });
        return;
      case 'account-login-claude':
        exit({ action: 'seller_login', upstream: 'claude', replaceAuth: true, restartSeller: true });
        return;
      case 'account-login-gemini':
        exit({ action: 'seller_login', upstream: 'gemini', replaceAuth: true, restartSeller: true });
        return;
      case 'open-chat':
        setViewIndex(indexOfView('chat'));
        setFocusPane('content');
        break;
      case 'open-network':
        setViewIndex(indexOfView('network'));
        setFocusPane('content');
        break;
      case 'open-usage':
        setViewIndex(indexOfView('usage'));
        setFocusPane('content');
        break;
      case 'open-settings':
        setViewIndex(indexOfView('settings'));
        setFocusPane('content');
        break;
      case 'run-init':
        exit({ action: 'onboarding' });
        return;
    }

    await refresh();
  };

  const selectModel = async (model: string) => {
    const { paths, ...configBody } = config;
    const nextConfig: ClawMarketConfig = {
      ...configBody,
      buyer: {
        ...configBody.buyer,
        selectedModel: model,
      },
    };
    await saveConfig(nextConfig);
    selectedModelRef.current = model;
    setConfig({ ...nextConfig, paths: config.paths });
    setSnapshot((current) => ({ ...current, selectedModel: model }));
    pushEvent('网络', `当前模型已切换为 ${model}`);
  };

  const confirmQuit = () => {
    if (quitting) {
      return;
    }

    setQuitting(true);
    buyerStartupController.current.abort();
    sellerStartupController.current.abort();
    void (async () => {
      try {
        await stopBuyerRuntime();
        await stopSellerRuntime();
      } finally {
        exit({ action: 'exit' });
      }
    })();
  };

  const header = (
    <Box borderStyle="single" borderColor={theme.primary} paddingX={1} width="100%" height={3} flexShrink={0}>
      <Text wrap="truncate-end">
        {PRODUCT_NAME} ({PRODUCT_SHORT_NAME}) {CLI_DISPLAY_VERSION}{' '}
        <Text color={buyerStarting ? theme.accent : snapshot.buyerService.online ? theme.primary : theme.danger}>buyer {buyerStarting ? '…' : snapshot.buyerService.online ? '●' : '✕'}</Text>{' '}
        <Text color={sellerStarting ? theme.accent : snapshot.sellerService.online ? theme.primary : theme.danger}>seller {sellerStarting ? '…' : snapshot.sellerService.online ? '●' : '✕'}</Text>{' '}
        <Text color={hasHealthyP2p(snapshot) ? theme.primary : theme.accent}>p2p {hasHealthyP2p(snapshot) ? '●' : '◆'}</Text>
        {snapshot.sellerQuotaWarning ? <Text color={theme.danger}>  quota !</Text> : null}
      </Text>
    </Box>
  );

  const modalContent = hasModal ? (
    <>
      {modal.type === 'prompt' ? (
        <PromptModal
          title={modal.title}
          description={modal.description}
          placeholder={modal.placeholder}
          initialValue={modal.initialValue}
          onSubmit={async (value) => {
            if (actionBusyRef.current) return;
            actionBusyRef.current = true; setActionBusy(true);
            const submit = modal.onSubmit;
            setModal(null);
            try {
              await submit(value);
            } catch (error) {
              setActionError(error instanceof Error ? error.message : String(error));
            } finally {
              actionBusyRef.current = false; setActionBusy(false);
              void refresh().catch(() => {});
            }
          }}
        />
      ) : null}
      {modal.type === 'confirm' ? (
        <ConfirmModal
          isFocused={!actionBusy}
          title={modal.title}
          description={modal.description}
          confirmLabel={modal.confirmLabel}
          cancelLabel={modal.cancelLabel}
          onConfirm={() => {
            if (actionBusyRef.current) return;
            actionBusyRef.current = true; setActionBusy(true);
            const confirm = modal.onConfirm;
            setModal(null);
            setFocusPane('nav');
            void (async () => {
              try {
                await confirm();
              } catch (error) {
                setActionError(error instanceof Error ? error.message : String(error));
              } finally {
                actionBusyRef.current = false; setActionBusy(false);
                void refresh().catch(() => {});
              }
            })();
          }}
          onCancel={() => {
            modal.onCancel?.();
            setModal(null);
          }}
        />
      ) : null}
      {modal.type === 'palette' ? (
        <CommandPalette
          query={paletteQuery}
          commands={filteredCommands}
          selectedIndex={paletteIndex}
          onChange={setPaletteQuery}
          onRun={runCommandSafely}
        />
      ) : null}
      {modal.type === 'help' ? <HelpModal /> : null}
      {modal.type === 'quit' ? (
        <QuitModal
          quitting={quitting}
          onCancel={() => setModal(null)}
          onConfirm={confirmQuit}
        />
      ) : null}
      {modal.type === 'wallet-export' ? (
        <ExportView
          address={modal.address}
          privateKey={modal.privateKey}
          onClose={() => setModal(null)}
        />
      ) : null}
      {modal.type === 'wallet-import' ? (
        <ImportView
          currentAddress={modal.currentAddress}
          onSubmit={(value) => {
            void (async () => {
              try {
                await modal.onSubmit(value);
                setModal(null);
                await refresh();
              } catch (error) {
                setActionError(error instanceof Error ? error.message : String(error));
              }
            })();
          }}
        />
      ) : null}
    </>
  ) : undefined;
  const status = actionError
    ? <Text color={theme.danger}>操作未完成：{actionError}</Text>
    : actionBusy
      ? <Text color={theme.accent}>正在处理，菜单仍可切换；请等待结果后再提交操作。</Text>
      : buyerProgress || sellerProgress
        ? <StartupProgress buyer={buyerProgress} seller={sellerProgress} compact />
        : snapshot.buyerService.online && !hasHealthyP2p(snapshot)
          ? <Text color={theme.accent}>本机买家已启动，正在寻找可用卖家。</Text>
        : needsSettlementConfiguration(config)
          ? <Text color={theme.accent}>请先在“设置”填写当前币种的托管合约和额度，再启动买家。</Text>
      : updateResult?.hasUpdate
        ? <Text color={theme.accent}>有新版本 v{updateResult.latest} · tam self-update</Text>
        : <Text color={theme.muted}>当前结算：{PAYMENT_TOKEN.symbol} · {PAYMENT_NETWORK_NAME}</Text>;

  return (
    <ConsoleFrame
      columns={windowSize.columns ?? stdout.columns ?? 100}
      rows={windowSize.rows ?? stdout.rows ?? 24}
      header={header}
      status={status}
      currentView={currentView}
      navFocused={focusPane === 'nav'}
      title={labelForView(currentView)}
      modal={hasModal ? { title: getModalTitle(modal), content: modalContent } : undefined}
      events={events}
      footer={hasModal ? 'Esc 关闭 · Enter 确认 · PgUp/PgDn 翻页' : 'Tab 菜单 · Enter 操作 · Esc 返回 · L 语言 · PgUp/PgDn 翻页 · q 退出'}
      startup={buyerProgress || sellerProgress ? { content: <StartupProgress buyer={buyerProgress} seller={sellerProgress} />, rows: (buyerProgress ? 1 : 0) + (sellerProgress ? 1 : 0) + 1 } : undefined}
    >
      <ConsoleView
        currentView={currentView}
        config={config}
        snapshot={snapshot}
        chatHistory={chatHistory}
        settingsError={settingsError}
        actionError={actionError}
        isFocused={focusPane === 'content' && !actionBusy}
        onSelectModel={selectModel}
        onOpenPrompt={(nextModal) => {
          setActionError(null);
          setSettingsError(null);
          setModal(nextModal);
        }}
        onOpenModal={(nextModal) => {
          setActionError(null);
          setSettingsError(null);
          setModal(nextModal);
        }}
        onRequestSellerLogin={(request) => {
          exit({
            action: 'seller_login',
            upstream: request.upstream,
            replaceAuth: request.replaceAuth,
            restartSeller: request.restartSeller,
            forceFreshLogin: request.forceFreshLogin,
          });
        }}
        onActionError={setActionError}
        onSettingsError={setSettingsError}
        onAppendChat={(entry) => setChatHistory((current) => [...current, entry])}
        onReplaceLastChat={(entry) => setChatHistory((current) => (
          current.length > 0 ? [...current.slice(0, -1), entry] : [entry]
        ))}
        onClearChat={() => setChatHistory([])}
        onPushEvent={pushEvent}
        onRefresh={refresh}
        buyerStarting={buyerStarting}
        onStartBuyer={startConsoleBuyer}
        sellerStarting={sellerStarting}
        onStartSeller={startConsoleSeller}
        onUpdateConfig={async (nextConfig) => {
          await saveConfig(nextConfig);
        }}
        onSetView={(viewId) => setViewIndex(indexOfView(viewId))}
      />
    </ConsoleFrame>
  );
}

function ConsoleView(props: {
  currentView: ConsoleViewId;
  config: CliDefaults;
  snapshot: ConsoleSnapshot;
  chatHistory: ChatEntry[];
  settingsError: string | null;
  actionError: string | null;
  isFocused: boolean;
  onSelectModel: (model: string) => Promise<void>;
  onOpenPrompt: (modal: Extract<ModalState, { type: 'prompt' }>) => void;
  onOpenModal: (modal: ModalState) => void;
  onRequestSellerLogin: (request: { upstream: SellerUpstream; replaceAuth: boolean; restartSeller: boolean; forceFreshLogin?: boolean }) => void;
  onActionError: (message: string | null) => void;
  onSettingsError: (message: string | null) => void;
  onAppendChat: (entry: ChatEntry) => void;
  onReplaceLastChat: (entry: ChatEntry) => void;
  onClearChat: () => void;
  onPushEvent: (scope: string, message: string) => void;
  onRefresh: () => Promise<void>;
  buyerStarting: boolean;
  onStartBuyer: () => Promise<void>;
  sellerStarting: boolean;
  onStartSeller: (config?: CliDefaults) => Promise<void>;
  onUpdateConfig: (config: ClawMarketConfig) => Promise<void>;
  onSetView: (viewId: ConsoleViewId) => void;
}) {
  const {
    currentView,
    config,
    snapshot,
    chatHistory,
    settingsError,
    actionError,
    isFocused,
    onSelectModel,
    onOpenPrompt,
    onOpenModal,
    onRequestSellerLogin,
    onActionError,
    onSettingsError,
    onAppendChat,
    onReplaceLastChat,
    onClearChat,
    onPushEvent,
    onRefresh,
    buyerStarting,
    onStartBuyer,
    sellerStarting,
    onStartSeller,
    onUpdateConfig,
    onSetView,
  } = props;

  switch (currentView) {
    case 'agent':
      return <AgentView config={config} isFocused={isFocused} onOpenPrompt={onOpenPrompt} onPushEvent={onPushEvent} />;
    case 'dashboard':
      return (
        <DashboardView
          config={config}
          snapshot={snapshot}
          isFocused={isFocused}
          actionError={actionError}
          onOpenPrompt={onOpenPrompt}
          onActionError={onActionError}
          onAppendChat={onAppendChat}
          onReplaceLastChat={onReplaceLastChat}
          onPushEvent={onPushEvent}
          onRefresh={onRefresh}
          buyerStarting={buyerStarting}
          onStartBuyer={onStartBuyer}
          sellerStarting={sellerStarting}
          onStartSeller={onStartSeller}
          onSetView={onSetView}
        />
      );
    case 'chat':
      return (
        <ChatView
          config={config}
          snapshot={snapshot}
          chatHistory={chatHistory}
          isFocused={isFocused}
          onOpenPrompt={onOpenPrompt}
          onAppendChat={onAppendChat}
          onReplaceLastChat={onReplaceLastChat}
          onClearChat={onClearChat}
          onPushEvent={onPushEvent}
        />
      );
    case 'wallet':
      return (
        <WalletView
          config={config}
          snapshot={snapshot}
          isFocused={isFocused}
          onOpenPrompt={onOpenPrompt}
          onOpenModal={onOpenModal}
          onActionError={onActionError}
          onPushEvent={onPushEvent}
          onRefresh={onRefresh}
        />
      );
    case 'network':
      return (
        <NetworkView
          snapshot={snapshot}
          isFocused={isFocused}
          onSelectModel={onSelectModel}
        />
      );
    case 'usage':
      return (
        <UsageView
          config={config}
          snapshot={snapshot}
          isFocused={isFocused}
          onPushEvent={onPushEvent}
        />
      );
    case 'seller':
      return (
        <SellerView
          config={config}
          snapshot={snapshot}
          isFocused={isFocused}
          onPushEvent={onPushEvent}
          onRefresh={onRefresh}
          onSetView={onSetView}
          onOpenPrompt={onOpenPrompt}
          onOpenModal={onOpenModal}
          onUpdateConfig={onUpdateConfig}
          onRequestSellerLogin={onRequestSellerLogin}
          onActionError={onActionError}
          sellerStarting={sellerStarting}
          onStartSeller={onStartSeller}
        />
      );
    case 'accounts':
      return (
        <AccountsView
          config={config}
          snapshot={snapshot}
          isFocused={isFocused}
          onOpenModal={onOpenModal}
          onPushEvent={onPushEvent}
          onRefresh={onRefresh}
          onUpdateConfig={onUpdateConfig}
          onRequestSellerLogin={onRequestSellerLogin}
        />
      );
    case 'claims':
      return (
        <ClaimsView
          config={config}
          snapshot={snapshot}
          isFocused={isFocused}
          onOpenModal={onOpenModal}
          onPushEvent={onPushEvent}
          onRefresh={onRefresh}
        />
      );
    case 'settings':
      return (
        <SettingsView
          config={config}
          snapshot={snapshot}
          settingsError={settingsError}
          isFocused={isFocused}
          onOpenPrompt={onOpenPrompt}
          onOpenModal={onOpenModal}
          onSettingsError={onSettingsError}
          onPushEvent={onPushEvent}
          onUpdateConfig={onUpdateConfig}
          onSelectModel={onSelectModel}
        />
      );
  }
}

function getModalTitle(modal: ModalState | null): string {
  if (!modal) {
    return 'Modal';
  }

  switch (modal.type) {
    case 'prompt':
      return modal.title;
    case 'confirm':
      return modal.title;
    case 'palette':
      return 'Command Palette';
    case 'help':
      return 'Help';
    case 'quit':
      return 'Exit';
    case 'wallet-export':
      return '导出私钥';
    case 'wallet-import':
      return '导入私钥';
  }
}

function labelForView(viewId: ConsoleViewId): string {
  return consoleNavItems.find((item) => item.id === viewId)?.label ?? 'Console';
}

function indexOfView(viewId: ConsoleViewId): number {
  const index = consoleNavItems.findIndex((item) => item.id === viewId);
  return index >= 0 ? index : 0;
}

function cycleViewIndex(current: number, delta: number): number {
  return (current + delta + consoleNavItems.length) % consoleNavItems.length;
}

function formatClock(): string {
  return new Date().toLocaleTimeString(getUiLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
