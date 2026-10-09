import { PAYMENT_NATIVE_SYMBOL } from '@clawmarket/shared';
import { PAYMENT_TOKEN } from '@clawmarket/shared';
import { access } from 'node:fs/promises';
import path from 'node:path';

import SelectInput from '../../i18n/SelectInput.js';
import { Box, render, useApp, useInput, useStdin } from 'ink';
import { Text } from '../../i18n/Text.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseUnits } from 'viem';

import { SELLER_MODEL_PRESETS, defaultSellerModels, type ClawMarketRole, type SellerUpstream } from '../../config/schema.js';
import { saveCliConfig, type CliDefaults } from '../../config/store.js';
import { getDefaultBuyerRuntimeOptions, startBuyerRuntime } from '../../runtime/buyer-runtime.js';
import { loginSellerUpstream, syncCodexCliAuthToCliproxy } from '../../runtime/cliproxy.js';
import { getDefaultSellerRuntimeOptions, startSellerRuntime } from '../../runtime/seller-runtime.js';
import { executePurchase, loadBuyerNetworkStatus } from '../../services/buyer.js';
import { addressFromPrivateKey, MIN_GAS_WEI, readBalances } from '../../services/chain.js';
import { loadSeededNetworkStatus } from '../../services/seller.js';
import { directoryHasRealFiles, normalizeUrl, readPrivateKeyFromWallet, shortenAddress } from '../../utils.js';
import { createStoredWallet, ensureStoredWallet, importStoredWallet } from '../../wallet/store.js';
import { theme } from '../../theme.js';
import { PriceCurvePreview } from '../components/PriceCurvePreview.js';
import { formatTxLink } from '../helpers/tx-link.js';
import { ActionStep } from './steps/ActionStep.js';
import { FundCheckStep } from './steps/FundCheckStep.js';
import { MultiSelectStep } from './steps/MultiSelectStep.js';
import { RoleStep } from './steps/RoleStep.js';
import { SellerWalletStep } from './steps/SellerWalletStep.js';
import { TextPromptStep } from './steps/TextPromptStep.js';
import { WalletAddressStep } from './steps/WalletAddressStep.js';
import { WizardFrame } from './steps/WizardFrame.js';
import { buildOnboardingStepIds, getStepTitle, shouldRunOnboarding, type OnboardingStepId } from './lib.js';

export type { OnboardingStepId } from './lib.js';
export { buildOnboardingStepIds, shouldRunOnboarding } from './lib.js';

export interface OnboardingResult {
  completed: boolean;
  openConsole: boolean;
}

type SellerLoginMode = 'browser' | 'device';

interface RunOnboardingOptions {
  config: CliDefaults;
  buyerUrl: string;
  sellerUrl: string;
  forcedRole?: ClawMarketRole | null;
}

interface OnboardingResumeState {
  stepIndex: number;
  modelOptions: string[];
  modelError: string | null;
  actionState: ActionState;
  state: WizardState;
}

interface ActionState {
  stepId: OnboardingStepId | null;
  status: 'idle' | 'running' | 'success' | 'error';
  lines: string[];
  error?: string;
  actionLabel?: string;
  recoveryStepId?: OnboardingStepId;
}

interface WizardState {
  role: ClawMarketRole | null;
  selectedModel: string;
  purchaseAmount: string;
  inputPrice: string;
  outputPrice: string;
  maxConcurrentValue: string;
  buyerWalletPath: string;
  sellerWalletPath: string;
  sellerAddress: `0x${string}` | null;
  sellerWalletExists: boolean;
  sellerUpstream: SellerUpstream;
  sellerLoginMode: SellerLoginMode;
  sellerModels: string[];
  sellerModelOptions: string[];
  completionSaved: boolean;
}

export async function runOnboardingWizard(options: RunOnboardingOptions): Promise<OnboardingResult> {
  let resumeState: OnboardingResumeState | null = null;

  while (true) {
    const app = render(<OnboardingApp {...options} resumeState={resumeState} />);
    try {
      const result = await app.waitUntilExit();
      app.unmount();

      const next = (result as OnboardingResult | { action: 'seller_login'; resumeState: OnboardingResumeState } | undefined)
        ?? { completed: false, openConsole: false };
      if (!('action' in next && next.action === 'seller_login')) {
        return next as OnboardingResult;
      }

      try {
        const { sellerUpstream: upstream, sellerLoginMode } = next.resumeState.state;
        const loginResult = await loginSellerUpstream({
          upstream,
          device: sellerLoginMode === 'device',
          cliproxySource: options.config.seller.cliproxySourceDir,
          cliproxyWorkDir: options.config.seller.cliproxyWorkDir,
          cliproxyAuthDir: options.config.seller.cliproxyAuthDir,
        });
        const loginLine = loginResult.mode === 'reused-codex-cli'
          ? '已复用本机 Codex 登录状态。'
          : loginResult.mode === 'existing-auth-dir'
            ? '检测到现有 seller 登录状态。'
            : `${sellerUpstreamLabel(upstream)} 登录完成（${sellerLoginModeLabel(sellerLoginMode)}）。`;
        resumeState = {
          ...next.resumeState,
          state: next.resumeState.state,
          actionState: {
            stepId: 'seller_login',
            status: 'success',
            lines: [
              loginLine,
              '下一步继续选择要出售的模型；当前先使用默认候选模型，避免在这里卡住。',
            ],
          },
        };
      } catch (error) {
        resumeState = {
          ...next.resumeState,
          actionState: {
            stepId: 'seller_login',
            status: 'error',
            lines: next.resumeState.actionState.lines,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    } catch (error) {
      app.unmount();
      if (!error) {
        return { completed: false, openConsole: false };
      }
      throw error;
    }
  }
}

export function OnboardingApp({ config, buyerUrl, sellerUrl, forcedRole, resumeState }: RunOnboardingOptions & { resumeState?: OnboardingResumeState | null }) {
  const { exit } = useApp();
  useStdin();
  const [stepIndex, setStepIndex] = useState(resumeState?.stepIndex ?? 0);
  const [modelOptions, setModelOptions] = useState<string[]>(resumeState?.modelOptions ?? []);
  const [modelError, setModelError] = useState<string | null>(resumeState?.modelError ?? null);
  const [actionState, setActionState] = useState<ActionState>(resumeState?.actionState ?? { stepId: null, status: 'idle', lines: [] });
  const [actionAttempt, setActionAttempt] = useState(0);
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);
  const [walletNotice, setWalletNotice] = useState<{ address: `0x${string}` } | null>(null);
  const actionRunIdRef = useRef(0);
  const [state, setState] = useState<WizardState>(resumeState?.state ?? {
    role: forcedRole ?? null,
    selectedModel: config.buyer.selectedModel,
    purchaseAmount: '',
    inputPrice: String(config.seller.pricing.p0 ?? config.seller.pricing.input),
    outputPrice: String(config.seller.pricing.alpha ?? 1),
    maxConcurrentValue: String(config.seller.pricing.maxConcurrent ?? 5),
    buyerWalletPath: config.paths.walletPath,
    sellerWalletPath: config.seller.walletPath,
    sellerAddress: null,
    sellerWalletExists: false,
    sellerUpstream: config.seller.upstream,
    sellerLoginMode: defaultSellerLoginMode(config.seller.upstream),
    sellerModels: config.seller.models.length > 0 ? config.seller.models : defaultSellerModels(config.seller.upstream),
    sellerModelOptions: config.seller.models.length > 0 ? config.seller.models : SELLER_MODEL_PRESETS[config.seller.upstream],
      completionSaved: false,
  });

  const buyerAddress = state.sellerAddress;

  const stepIds = useMemo(
    () => buildOnboardingStepIds(state.role, !forcedRole),
    [forcedRole, state.role],
  );
  const currentStepId = stepIds[Math.min(stepIndex, Math.max(0, stepIds.length - 1))] ?? 'role';
  const totalSteps = Math.max(1, stepIds.length);
  const stepNumber = Math.min(stepIndex + 1, totalSteps);

  useInput((_input, key) => {
    if (!key.escape || stepIndex <= 0) {
      return;
    }

    if (actionState.status === 'running') {
      setShowAbortConfirm(true);
      return;
    }

    setStepIndex((current) => Math.max(0, current - 1));
  });

  useEffect(() => {
    if (state.sellerWalletPath !== config.paths.walletPath) {
      return;
    }

    void ensureStoredWallet({
      walletPath: state.sellerWalletPath,
      legacyWalletPath: config.paths.legacySellerWalletPath,
    })
      .then((result) => {
        setState((current) => ({
          ...current,
          sellerWalletExists: true,
          sellerAddress: result.wallet.address,
        }));
        if (result.created) {
          setWalletNotice({ address: result.wallet.address });
        }
      })
      .catch(() => {
        setState((current) => ({ ...current, sellerWalletExists: false, sellerAddress: null }));
      });
  }, [config.paths.legacySellerWalletPath, config.paths.walletPath, state.sellerWalletPath]);

  useEffect(() => {
    if (currentStepId !== 'seller_wallet') {
      return;
    }

    if (state.sellerWalletPath === config.paths.walletPath) {
      return;
    }

    void access(state.sellerWalletPath)
      .then(() => {
        setState((current) => ({ ...current, sellerWalletExists: true }));
        return readPrivateKeyFromWallet(state.sellerWalletPath, 'seller wallet');
      })
      .then((privateKey) => {
        setState((current) => ({ ...current, sellerAddress: addressFromPrivateKey(privateKey) }));
      })
      .catch(() => {
        setState((current) => ({ ...current, sellerWalletExists: false, sellerAddress: null }));
      });
  }, [config.paths.walletPath, currentStepId, state.sellerWalletPath]);

  useEffect(() => {
    if (currentStepId !== 'buyer_model') {
      return;
    }
    if (modelOptions.length > 0 || modelError) {
      return;
    }

    void (async () => {
      try {
        const live = await loadBuyerNetworkStatus(buyerUrl);
        const models = Array.from(
          new Set(live.models.filter((item) => item.providerCount > 0 || item.bestProvider).map((item) => item.model)),
        );
        if (models.length > 0) {
          setModelOptions(models);
          return;
        }
      } catch {
        // Fall through to seed config.
      }

      const seeded = await loadSeededNetworkStatus(config.buyer.seedProvidersFile, state.selectedModel);
      const models = Array.from(new Set(seeded?.models.map((item) => item.model) ?? [state.selectedModel]));
      setModelOptions(models);
      if (!seeded) {
        setModelError('还没有从 buyer 或 seed 文件发现 seller，先用当前配置模型继续。');
      }
    })();
  }, [buyerUrl, config.buyer.seedProvidersFile, currentStepId, modelError, modelOptions.length, state.selectedModel]);

  useEffect(() => {
    if (currentStepId !== 'complete' || state.completionSaved) {
      return;
    }

    void (async () => {
      const { paths, ...configBody } = config;
      await saveCliConfig({
        ...configBody,
        onboarding: {
          completedAt: new Date().toISOString(),
          role: state.role,
        },
        buyer: {
          ...configBody.buyer,
          url: buyerUrl,
          selectedModel: state.selectedModel,
        },
        seller: {
          ...configBody.seller,
          url: sellerUrl,
          walletPath: state.sellerWalletPath,
          upstream: state.sellerUpstream,
          models: state.sellerModels,
          pricing: {
            input: Number(state.inputPrice),
            output: Number(state.inputPrice),
            p0: Number(state.inputPrice),
            alpha: Number(state.outputPrice),
            maxConcurrent: Number(state.maxConcurrentValue),
          },
        },
      });
      setState((current) => ({ ...current, completionSaved: true }));
    })();
  }, [buyerUrl, config, currentStepId, sellerUrl, state.completionSaved, state.inputPrice, state.maxConcurrentValue, state.outputPrice, state.role, state.selectedModel, state.sellerModels, state.sellerUpstream, state.sellerWalletPath]);

  useEffect(() => {
    if (!['buyer_start', 'seller_login', 'seller_start'].includes(currentStepId)) {
      return;
    }
    if (actionState.stepId === currentStepId && actionState.status !== 'idle') {
      return;
    }

    const runId = actionRunIdRef.current + 1;
    actionRunIdRef.current = runId;
    let disposed = false;

    const updateActionState = (nextState: ActionState | ((current: ActionState) => ActionState)) => {
      if (disposed || actionRunIdRef.current !== runId) {
        return;
      }
      setActionState(nextState);
    };

    setShowAbortConfirm(false);
    updateActionState({
      stepId: currentStepId,
      status: 'running',
      lines: currentStepId === 'seller_login'
        ? [
            `Auth 目录：${config.seller.cliproxyAuthDir}`,
            '正在检查现有登录状态…',
          ]
        : [],
    });

    void (async () => {
      try {
        if (currentStepId === 'buyer_start') {
          const lines: string[] = [];
          await startBuyerRuntime({
            ...getDefaultBuyerRuntimeOptions(config),
            url: buyerUrl,
            report: (line) => {
              lines.push(line);
              updateActionState({
                stepId: 'buyer_start',
                status: 'running',
                lines: [...lines],
              });
            },
          });
          updateActionState({
            stepId: 'buyer_start',
            status: 'success',
            lines,
          });
          return;
        }

        if (currentStepId === 'seller_login') {
          const alreadyLoggedIn = await directoryHasRealFiles(config.seller.cliproxyAuthDir);
          if (alreadyLoggedIn) {
            const lines = [
              `检测到现有 auth 目录：${config.seller.cliproxyAuthDir}`,
              '已跳过模型探测，下一步直接选择要出售的模型。',
            ];
            updateActionState({
              stepId: 'seller_login',
              status: 'success',
              lines,
            });
            return;
          }

          const synced = await syncCodexCliAuthToCliproxy(state.sellerUpstream, config.seller.cliproxyAuthDir);
          if (synced) {
            const lines = [
              `已复用本机 Codex 登录：${synced.sourceAuthPath}`,
              `已写入 seller auth：${synced.targetAuthPath}`,
              '已跳过模型探测，下一步直接选择要出售的模型。',
            ];
            updateActionState({
              stepId: 'seller_login',
              status: 'success',
              lines,
            });
            return;
          }

          exit({
            action: 'seller_login',
            resumeState: {
              stepIndex,
              modelOptions,
              modelError,
              state,
              actionState: {
                stepId: 'seller_login',
                status: 'running',
                  lines: [
                    `Auth 目录：${config.seller.cliproxyAuthDir}`,
                    `即将启动 ${sellerUpstreamLabel(state.sellerUpstream)} ${sellerLoginModeLabel(state.sellerLoginMode)}流程。`,
                  ],
                },
              },
          });
          return;
        }

        if (currentStepId === 'seller_start') {
          const hasAuth = await directoryHasRealFiles(config.seller.cliproxyAuthDir);
          if (!hasAuth) {
            updateActionState({
              stepId: 'seller_start',
              status: 'error',
              lines: [
                `Auth 目录：${config.seller.cliproxyAuthDir}`,
                `当前没有可用的 ${sellerUpstreamLabel(state.sellerUpstream)} 登录文件。`,
                '请先返回上一步重新登录，完成后再继续启动 seller。',
              ],
              error: `没有检测到 ${sellerUpstreamLabel(state.sellerUpstream)} 登录状态，本机 seller 还不能启动。`,
              actionLabel: `返回 ${sellerUpstreamLabel(state.sellerUpstream)} 登录`,
              recoveryStepId: 'seller_login',
            });
            return;
          }
        }

        const lines: string[] = [];
        await startSellerRuntime({
          ...getDefaultSellerRuntimeOptions(config),
          url: sellerUrl,
          walletPath: state.sellerWalletPath,
          upstream: state.sellerUpstream,
          models: state.sellerModels.join(','),
          inputPrice: state.inputPrice,
          outputPrice: state.outputPrice,
          p0: state.inputPrice,
          alpha: state.outputPrice,
          maxConcurrent: state.maxConcurrentValue,
          report: (line) => {
            lines.push(line);
            updateActionState({
              stepId: 'seller_start',
              status: 'running',
              lines: [...lines],
            });
          },
        });
        updateActionState({
          stepId: 'seller_start',
          status: 'success',
          lines,
        });
      } catch (error) {
        if (currentStepId === 'seller_start' && isMissingSellerAuthError(error)) {
          updateActionState({
            stepId: 'seller_start',
            status: 'error',
            lines: [
              `Auth 目录：${config.seller.cliproxyAuthDir}`,
              `seller 启动前没有找到 ${sellerUpstreamLabel(state.sellerUpstream)} 登录文件。`,
              '请先重新登录上游账号，再回来继续。',
            ],
            error: error instanceof Error ? error.message : String(error),
            actionLabel: `返回 ${sellerUpstreamLabel(state.sellerUpstream)} 登录`,
            recoveryStepId: 'seller_login',
          });
          return;
        }

        updateActionState((current) => ({
          ...current,
          stepId: currentStepId,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    })();

    return () => {
      disposed = true;
    };
  }, [actionAttempt, buyerUrl, config, currentStepId, exit, modelError, modelOptions, sellerUrl, state, stepIndex]);

  const nextStep = () => {
    setShowAbortConfirm(false);
    setActionState({ stepId: null, status: 'idle', lines: [] });
    setStepIndex((current) => Math.min(current + 1, stepIds.length - 1));
  };

  const jumpToStep = (targetStepId: OnboardingStepId) => {
    setShowAbortConfirm(false);
    setActionState({ stepId: null, status: 'idle', lines: [] });
    const targetIndex = stepIds.indexOf(targetStepId);
    setStepIndex(targetIndex >= 0 ? targetIndex : 0);
  };

  const restartAction = () => {
    setShowAbortConfirm(false);
    setActionState({ stepId: null, status: 'idle', lines: [] });
    setActionAttempt((current) => current + 1);
  };

  const abortCurrentStep = () => {
    actionRunIdRef.current += 1;
    setShowAbortConfirm(false);
    setActionState({ stepId: null, status: 'idle', lines: [] });
    setStepIndex((current) => Math.max(0, current - 1));
  };

  const title = getStepTitle(currentStepId);
  const footer = stepIndex > 0 ? 'Esc 返回上一步 / 放弃当前步骤  Enter 继续/提交  Ctrl+C 退出' : 'Enter 继续/提交  Ctrl+C 退出';

  let body: React.ReactNode;
  let subtitle: string | undefined;

  switch (currentStepId) {
    case 'role':
      subtitle = '第一次使用时先确定你要配置 buyer、seller，还是两者都要。';
      body = (
        <RoleStep
          onSelect={(role) => {
            setState((current) => ({ ...current, role }));
            setStepIndex((current) => current + 1);
          }}
        />
      );
      break;
    case 'buyer_wallet':
      subtitle = '买家和卖家共用一个轻量钱包文件；这里会自动生成并保存在本机。';
      body = buyerAddress ? (
        <WalletAddressStep
          address={buyerAddress}
          description={("手机扫码即可复制地址。后面步骤需要给这个地址充值 USDC 和少量 ETH 做 gas。").replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL)}
          continueLabel="继续启动 buyer"
          onContinue={nextStep}
        />
      ) : (
        <Text color={theme.accent}>正在准备本地钱包…</Text>
      );
      break;
    case 'buyer_start':
      subtitle = `目标地址：${normalizeUrl(buyerUrl)}/v1`;
      body = (
        <ActionStep
          status={actionState.status}
          description="正在启动或检查本地 buyer 节点。"
          lines={actionState.lines}
          error={actionState.error}
          actionLabel={actionState.status === 'error' ? '重试启动 buyer' : '继续选择模型'}
          onAction={actionState.status === 'error' ? restartAction : nextStep}
          showAbortConfirm={showAbortConfirm}
          onAbortConfirm={abortCurrentStep}
          onAbortCancel={() => setShowAbortConfirm(false)}
        />
      );
      break;
    case 'buyer_fund':
      subtitle = '充值后会每 10 秒自动刷新，也可以按 r 手动刷新；余额不足时后续购买会被拦截。';
      body = (
        buyerAddress ? (
          <FundCheckStep
            address={buyerAddress}
            requireUsdc
            minGasWei={parseGasThreshold(config.buyer.minGasWei)}
            onContinue={nextStep}
          />
        ) : (
          <Text color={theme.accent}>正在准备本地钱包…</Text>
        )
      );
      break;
    case 'buyer_model':
      subtitle = '这里会把默认模型写入 config.json，之后 `buyer chat` 和外部客户端都可以直接复用。';
      body = modelOptions.length > 0 ? (
        <Box flexDirection="column">
          {modelError ? <Text color={theme.muted}>{modelError}</Text> : null}
          <Box marginTop={1}>
            <SelectInput
              items={modelOptions.map((model) => ({ label: model, value: model }))}
              onSelect={(item) => {
                setState((current) => ({ ...current, selectedModel: item.value }));
                nextStep();
              }}
            />
          </Box>
        </Box>
      ) : (
        <Text color={theme.accent}>正在从网络读取可用模型…</Text>
      );
      break;
    case 'buyer_purchase':
      subtitle = '可直接回车跳过，之后也能用 `buyer purchase` 再充。';
      body = (
        <TextPromptStep
          label={("输入要预充值的 USDC 数量。留空直接跳过。").replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL)}
          hint="例如输入 `0.05`。如果留空，向导只会保存配置，不会发起充值。"
          initialValue={state.purchaseAmount}
          placeholder="0.05"
          submitLabel="Enter 提交，留空则跳过。"
          onSubmit={async (value) => {
            const trimmed = value.trim();
            setState((current) => ({ ...current, purchaseAmount: trimmed }));
            if (!trimmed) {
              nextStep();
              return;
            }

            if (!buyerAddress) {
              setActionState({
                stepId: 'buyer_purchase',
                status: 'error',
                lines: [],
                error: '钱包还没准备好，请稍等几秒再试。',
              });
              return;
            }

            const balances = await readBalances(buyerAddress);
            if (balances.ethWei < parseGasThreshold(config.buyer.minGasWei)) {
              setActionState({
                stepId: 'buyer_purchase',
                status: 'error',
                lines: [],
                error: ('ETH 不足支付 gas，请返回上一步充值。').replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL),
              });
              return;
            }
            if (balances.usdcMicro < parseUnits(trimmed, PAYMENT_TOKEN.decimals)) {
              setActionState({
                stepId: 'buyer_purchase',
                status: 'error',
                lines: [],
                error: (`USDC 余额 ${balances.usdcFormatted} 不够 ${trimmed}，请返回上一步充值。`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL),
              });
              return;
            }

            const result = await executePurchase(buyerUrl, trimmed);
            setActionState({
              stepId: 'buyer_purchase',
              status: 'success',
              lines: [(`已充值 ${result.amountUsd} USDC`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL), `交易: ${formatTxLink(result.depositTx)}`],
            });
            nextStep();
          }}
        />
      );
      break;
    case 'seller_wallet':
      subtitle = state.sellerAddress
        ? ('卖家钱包只需要少量 ETH 做 gas，不需要 USDC。').replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL)
        : '卖家需要一个本地钱包 JSON。你可以复用已有文件，也可以现在生成一个新的。';
      body = state.sellerAddress ? (
        <WalletAddressStep
          address={state.sellerAddress}
          description={("卖家钱包用来签 claim，只需要少量 ETH 做 gas；不需要充值 USDC。").replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL)}
          continueLabel="继续选择上游账号"
          onContinue={nextStep}
        />
      ) : (
        <SellerWalletStep
          walletPath={state.sellerWalletPath}
          walletExists={state.sellerWalletExists}
          onReuse={async () => {
            const privateKey = await readPrivateKeyFromWallet(state.sellerWalletPath, 'seller wallet');
            setState((current) => ({
              ...current,
              sellerWalletExists: true,
              sellerAddress: addressFromPrivateKey(privateKey),
            }));
          }}
          onGenerate={async () => {
            const wallet = await createStoredWallet(state.sellerWalletPath);
            setState((current) => ({
              ...current,
              sellerWalletExists: true,
              sellerAddress: wallet.address,
            }));
            setWalletNotice({ address: wallet.address });
          }}
          onPaste={async (privateKey) => {
            const normalized = privateKey.trim();
            if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
              setActionState({
                stepId: 'seller_wallet',
                status: 'error',
                lines: [],
                error: '私钥格式不对，必须是 0x 开头的 64 位十六进制字符串。',
              });
              return;
            }
            const result = await importStoredWallet(normalized, {
              walletPath: state.sellerWalletPath,
              backupExisting: false,
            });
            setState((current) => ({
              ...current,
              sellerWalletExists: true,
              sellerAddress: result.wallet.address,
            }));
          }}
        />
      );
      break;
    case 'seller_upstream':
      subtitle = '选择本机 seller 要反代的上游账号。';
      body = (
        <SelectInput
          items={[
            { label: 'Codex (OpenAI ChatGPT)', value: 'codex' as const },
            { label: 'Claude (Anthropic Claude Code)', value: 'claude' as const },
            { label: 'Gemini (Google Gemini CLI)', value: 'gemini' as const },
          ]}
          onSelect={(item) => {
            const presets = SELLER_MODEL_PRESETS[item.value];
            setState((current) => ({
              ...current,
              sellerUpstream: item.value,
              sellerLoginMode: defaultSellerLoginMode(item.value),
              sellerModels: defaultSellerModels(item.value),
              sellerModelOptions: presets,
            }));
            nextStep();
          }}
        />
      );
      break;
    case 'seller_login_method':
      subtitle = sellerLoginMethodSubtitle(state.sellerUpstream);
      body = (
        <SelectInput
          items={sellerLoginModeItems(state.sellerUpstream)}
          onSelect={(item) => {
            setState((current) => ({ ...current, sellerLoginMode: item.value }));
            nextStep();
          }}
        />
      );
      break;
    case 'seller_login':
      subtitle = `${sellerLoginSubtitle(state.sellerUpstream, state.sellerLoginMode)}；如果还没有 auth 文件，这一步会暂时离开 Ink 界面。`;
      body = (
        <ActionStep
          status={actionState.status}
          description={`检查并准备 seller 的 ${sellerUpstreamLabel(state.sellerUpstream)} 登录状态。`}
          lines={actionState.lines}
          error={actionState.error}
          actionLabel={actionState.status === 'error' ? '重试登录' : '继续选择模型'}
          onAction={actionState.status === 'error' ? restartAction : nextStep}
        />
      );
      break;
    case 'seller_models':
      subtitle = `${sellerUpstreamLabel(state.sellerUpstream)} 候选模型，可多选；至少保留 1 个。`;
      body = (
        <MultiSelectStep
          options={state.sellerModelOptions.length > 0 ? state.sellerModelOptions : SELLER_MODEL_PRESETS[state.sellerUpstream]}
          initialSelected={state.sellerModels}
          onSubmit={(selected) => {
            setState((current) => ({ ...current, sellerModels: selected }));
            nextStep();
          }}
        />
      );
      break;
    case 'seller_input_price':
      subtitle = `${pricingScopeSubtitle(state.sellerModels)}；这里设置的是底价 p0，不是最终忙时成交价。`;
      body = (
        <Box flexDirection="column">
          <Text>AIMM 会在闲时接近底价，忙时自动涨价保护你的额度。</Text>
          <Text color={theme.muted}>底价必须大于 0，推荐从 2 开始。</Text>
          <TextPromptStep
            label={("设置卖家底价 p0（USDC / 1M tokens）").replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL)}
            initialValue={state.inputPrice}
            placeholder="2"
            onSubmit={(value) => {
              const trimmed = value.trim() || state.inputPrice;
              const parsed = Number(trimmed);
              if (!Number.isFinite(parsed) || parsed <= 0) {
                setActionState({
                  stepId: 'seller_input_price',
                  status: 'error',
                  lines: [],
                  error: '底价必须大于 0，比如 2 或 2.5',
                });
                return;
              }
              setState((current) => ({ ...current, inputPrice: trimmed }));
              nextStep();
            }}
          />
          <PriceCurvePreview p0={Number(state.inputPrice) || 2} alpha={Number(state.outputPrice) || 1} />
        </Box>
      );
      break;
    case 'seller_output_price':
      subtitle = 'alpha 控制涨价速度：0 = 固定价，1 = 默认，2 = 更激进。';
      body = (
        <Box flexDirection="column">
          <TextPromptStep
            label="设置斜率 alpha"
            initialValue={state.outputPrice}
            placeholder="1"
            onSubmit={(value) => {
              const trimmed = value.trim() || state.outputPrice;
              const parsed = Number(trimmed);
              if (!Number.isFinite(parsed) || parsed < 0) {
                setActionState({
                  stepId: 'seller_output_price',
                  status: 'error',
                  lines: [],
                  error: 'alpha 必须是大于等于 0 的数字，比如 0、1 或 1.5',
                });
                return;
              }
              setState((current) => ({ ...current, outputPrice: trimmed }));
              nextStep();
            }}
          />
          <PriceCurvePreview p0={Number(state.inputPrice) || 2} alpha={Number(state.outputPrice) || 1} />
        </Box>
      );
      break;
    case 'seller_max_concurrent':
      subtitle = '最大并发只做本地 admission gate，不进入 CUC 定价公式。';
      body = (
        <Box flexDirection="column">
          <TextPromptStep
            label="设置最大并发请求数"
            initialValue={state.maxConcurrentValue}
            placeholder="5"
            onSubmit={(value) => {
              const trimmed = value.trim() || state.maxConcurrentValue;
              const parsed = Number(trimmed);
              if (!Number.isInteger(parsed) || parsed <= 0) {
                setActionState({
                  stepId: 'seller_max_concurrent',
                  status: 'error',
                  lines: [],
                  error: '最大并发必须是正整数，比如 5',
                });
                return;
              }
              setState((current) => ({ ...current, maxConcurrentValue: trimmed }));
              nextStep();
            }}
          />
          <Text color={theme.muted}>推荐值：5。机器比较弱时可以设成 2-3。</Text>
        </Box>
      );
      break;
    case 'seller_gas_check':
      subtitle = ('claim 上链需要卖家钱包有少量 ETH；这里只检查 ETH，不需要 USDC。').replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL);
      body = state.sellerAddress ? (
        <FundCheckStep
          address={state.sellerAddress}
          requireUsdc={false}
          minGasWei={parseGasThreshold(config.seller.minGasWei)}
          onContinue={nextStep}
        />
      ) : (
        <Text color={theme.danger}>还没有可用的卖家钱包地址，请按 Esc 返回钱包步骤。</Text>
      );
      break;
    case 'seller_start':
      subtitle = `状态地址：${normalizeUrl(sellerUrl)}/v1/seller/status`;
      body = (
        <ActionStep
          status={actionState.status}
          description="正在启动或检查本机 seller。"
          lines={actionState.lines}
          error={actionState.error}
          actionLabel={actionState.status === 'error' ? actionState.actionLabel ?? '重试启动 seller' : '完成向导'}
          onAction={
            actionState.status === 'error'
              ? () => {
                  if (actionState.recoveryStepId) {
                    jumpToStep(actionState.recoveryStepId);
                    return;
                  }
                  restartAction();
                }
              : nextStep
          }
          showAbortConfirm={showAbortConfirm}
          onAbortConfirm={abortCurrentStep}
          onAbortCancel={() => setShowAbortConfirm(false)}
        />
      );
      break;
    case 'complete':
      subtitle = state.completionSaved ? 'onboarding 已写入 config.json。' : '正在保存配置…';
      body = state.completionSaved ? (
        <Box flexDirection="column">
          <Text color={theme.primary}>配置完成。</Text>
          <Box marginTop={1} flexDirection="column">
            <Text>Role: {state.role}</Text>
            <Text>Buyer API: {normalizeUrl(buyerUrl)}/v1</Text>
            <Text>Buyer model: {state.selectedModel}</Text>
            {(state.role === 'seller' || state.role === 'both') ? (
              <>
                <Text>Seller wallet: {state.sellerWalletPath}</Text>
                <Text>
                  Seller AIMM: p0={state.inputPrice} alpha={state.outputPrice} maxConcurrent={state.maxConcurrentValue}
                </Text>
                <Text>
                  Seller upstream: {sellerUpstreamLabel(state.sellerUpstream)} · Models: {state.sellerModels.join(', ') || 'none'}
                </Text>
              </>
            ) : null}
          </Box>
          <Box marginTop={1}>
            <Text color={theme.muted}>外部客户端可直接把 Base URL 指向 buyer `/v1` 接口。</Text>
          </Box>
          <Box marginTop={1}>
            <SelectInput
              items={[
                { label: '进入控制台', value: 'console' },
                { label: '先退出', value: 'exit' },
              ]}
              onSelect={(item) => {
                exit({ completed: true, openConsole: item.value === 'console' });
              }}
            />
          </Box>
        </Box>
      ) : (
        <Text color={theme.accent}>正在保存 `~/.clawmarket/config.json`…</Text>
      );
      break;
  }

  return (
    <WizardFrame
      step={stepNumber}
      totalSteps={totalSteps}
      title={title}
      subtitle={subtitle}
      footer={footer}
    >
      {walletNotice ? (
        <Box marginBottom={1} flexDirection="column">
          <Text color={theme.primary}>✓ 钱包已创建：{shortenAddress(walletNotice.address)}</Text>
          <Text color={theme.accent}>  按 E 导出私钥备份。机器丢了 = 钱没了。</Text>
        </Box>
      ) : null}
      {body}
      {actionState.status === 'error' && !['buyer_start', 'seller_login', 'seller_start'].includes(currentStepId) ? (
        <Box marginTop={1}>
          <Text color={theme.danger}>错误: {actionState.error}</Text>
        </Box>
      ) : null}
    </WizardFrame>
  );
}

function sellerUpstreamLabel(upstream: SellerUpstream): string {
  switch (upstream) {
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude';
    case 'gemini':
      return 'Gemini';
  }
}

function sellerLoginSubtitle(upstream: SellerUpstream, mode: SellerLoginMode): string {
  switch (upstream) {
    case 'codex':
      return mode === 'device' ? '使用 Codex device-code 登录' : '使用 Codex 浏览器登录';
    case 'claude':
      return '使用 Claude Code OAuth 登录';
    case 'gemini':
      return '使用 Google 账号登录 Gemini CLI';
  }
}

function sellerLoginMethodSubtitle(upstream: SellerUpstream): string {
  switch (upstream) {
    case 'codex':
      return '选择 Codex 登录方式。浏览器登录更直观；device-code 适合远程终端。';
    case 'claude':
      return 'Claude 当前使用浏览器 OAuth 登录。';
    case 'gemini':
      return 'Gemini 当前使用浏览器/Google 账号登录。';
  }
}

function sellerLoginModeItems(upstream: SellerUpstream): Array<{ label: string; value: SellerLoginMode }> {
  switch (upstream) {
    case 'codex':
      return [
        { label: '浏览器登录（推荐）', value: 'browser' },
        { label: 'Device Code 登录', value: 'device' },
      ];
    case 'claude':
      return [{ label: '浏览器 OAuth 登录', value: 'browser' }];
    case 'gemini':
      return [{ label: '浏览器 / Google 登录', value: 'browser' }];
  }
}

function defaultSellerLoginMode(upstream: SellerUpstream): SellerLoginMode {
  switch (upstream) {
    case 'codex':
      return 'browser';
    case 'claude':
    case 'gemini':
      return 'browser';
  }
}

function sellerLoginModeLabel(mode: SellerLoginMode): string {
  switch (mode) {
    case 'browser':
      return '浏览器登录';
    case 'device':
      return 'device-code 登录';
  }
}

function pricingScopeSubtitle(models: string[]): string {
  const scope = models.length > 0 ? models.join(', ') : '尚未选择模型';
  return `将对你选择的 ${models.length} 个模型生效（${scope}）。每个模型共享同一组价格；后续版本会支持分模型定价。`;
}

function isMissingSellerAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('没有找到') && message.includes('登录文件');
}

function parseGasThreshold(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return MIN_GAS_WEI;
  }
}
