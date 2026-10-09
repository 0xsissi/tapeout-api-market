#!/usr/bin/env node
import { CLI_COMMAND, PRODUCT_NAME, PRODUCT_SHORT_NAME, PAYMENT_TOKEN, PAYMENT_NATIVE_SYMBOL, PAYMENT_AGENT_PORT, translateUiText } from '@clawmarket/shared';

import process from 'node:process';
import { getUiLanguage } from './i18n/language.js';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';

import { Command } from 'commander';

import {
  getConfigValue,
  loadCliConfig,
  parseConfigValue,
  saveCliConfig,
  setConfigValue,
  type CliDefaults,
} from './config/store.js';
import { defaultSellerModels, reconcileSellerModels, type ClawMarketRole, type SellerUpstream } from './config/schema.js';
import { getDefaultBuyerRuntimeOptions, startBuyerRuntime, stopBuyerRuntime } from './runtime/buyer-runtime.js';
import { discoverUpstreamModels, loginSellerUpstream } from './runtime/cliproxy.js';
import {
  getDefaultSellerRuntimeOptions,
  getManagedSellerRuntime,
  startSellerRuntime,
  stopSellerRuntime,
} from './runtime/seller-runtime.js';
import {
  backupAuthDir,
  clearAuthDir,
  deleteBackup,
  listAuthBackups,
  logoutCurrent,
  restoreAuthDir,
  switchToBackup,
} from './runtime/auth-manager.js';
import { inspectAuthDir } from './runtime/auth-inspector.js';
import {
  executePurchase,
  executeWithdrawCancel,
  executeWithdrawComplete,
  executeWithdrawRequest,
  loadBuyerNetworkStatus,
  loadBuyerSummary,
  requestChat,
  requestChatStream,
} from './services/buyer.js';
import { checkEndpoint, fetchJson, getServiceStatus } from './services/http.js';
import { executeFlushClaims, loadSeededNetworkStatus, loadSellerSummary } from './services/seller.js';
import { ClientUpgradeRequiredError } from './services/http.js';
import { addressFromPrivateKey, readBalances } from './services/chain.js';
import type {
  BuyerNetworkStatus,
  BuyerWalletSummary,
  BuyerWatchState,
  ChatOptions,
  SellerReachabilityPayload,
  SellerStatusPayload,
  SellerWatchState,
} from './types.js';
import {
  formatMicroUsdc,
  normalizeInterval,
  normalizeUrl,
  parseMicroUsdc,
  readPrivateKeyFromWallet,
  shortenAddress,
  sleep,
} from './utils.js';
import { runConsoleApp } from './tui/console/index.js';
import { runOnboardingWizard, shouldRunOnboarding } from './tui/onboarding/index.js';
import { checkForUpdate, type UpdateCheckResult } from './update-check.js';
import { CLI_VERSION } from './version.js';
import { AgentController, agentStoreFor, localAgentBackend, agentTools } from './agent/controller.js';
import { readFile } from 'node:fs/promises';
import type { AgentPolicy } from '@clawmarket/shared';
import { runClientUI } from './web/runtime.js';
import { prepareJoin, joinStatus, joinSignedRequest, startJoined, trustJoinedBuyer, printJoinResult, PAYMENT_AGENT_PORT as JOIN_AGENT_PORT } from './onboarding/join.js';

let cliConfig: CliDefaults;
let shuttingDown = false;

async function main(): Promise<void> {
  cliConfig = await loadCliConfig();
  applyGlobalUrlOverridesFromArgv(process.argv.slice(2));
  registerSignalHandlers();
  const skipUpdateCheck = hasFlag(process.argv.slice(2), '--skip-update-check');
  const updateCheckPromise = process.argv.length <= 2
    ? checkForUpdate({ skip: skipUpdateCheck })
    : undefined;
  const program = new Command();
  program
    .name(CLI_COMMAND)
    .version(CLI_VERSION, '-V, --version', 'Print CLI version')
    .description(`${PRODUCT_NAME} (${PRODUCT_SHORT_NAME}) interactive CLI`)
    .option('--buyer-url <url>', 'Buyer local server URL', cliConfig.buyer.url)
    .option('--seller-url <url>', 'Seller local status URL', cliConfig.seller.url)
    .option('--skip-update-check', 'Skip the startup update check')
    .addHelpText('after', translateUiText('\n币种选择：tam payment list | tam payment use USDC | tam payment use BEM\n单次覆盖：tam --payment-token BEM <command>（优先于环境变量和已保存选择）', getUiLanguage()))
    .addHelpText('after', getUiLanguage() === 'en' ? '\nLanguage: tam --lang en console | tam language en (save) | tam language zh\nPress L in the console to switch languages.' : '\n界面语言：tam --lang en console | tam language en（保存）| tam language zh\n控制台按 L 切换语言。')
    .showHelpAfterError();

  program
    .command('version')
    .description('Print CLI version')
    .action(() => {
      console.log(CLI_VERSION);
    });

  program
    .command('buyer')
    .description('Buyer-side actions')
    .addCommand(
      new Command('up')
        .alias('start')
        .description('Start a local buyer for me with prepared defaults')
        .option('--url <url>', 'Buyer local server URL', cliConfig.buyer.url)
        .option('--identity-path <path>', 'P2P identity path', cliConfig.buyer.identityPath)
        .option('--seed-file <path>', 'Seed providers bundle path', cliConfig.buyer.seedProvidersFile)
        .action(async (options) => {
          await startBuyer({
            url: options.url,
            identityPath: options.identityPath,
            seedFile: options.seedFile,
          });
        }),
    )
    .addCommand(
      new Command('down')
        .description('Stop a buyer process started from this CLI session')
        .action(async () => {
          const stopped = await stopBuyerRuntime();
          if (!stopped) {
            console.log('No managed buyer process is running in this CLI session.');
          }
        }),
    )
    .addCommand(
      new Command('status')
        .description('Show buyer wallet and credit status')
        .option('--url <url>', 'Buyer local server URL', cliConfig.buyer.url)
        .action(async (options) => {
          await showBuyerStatus(options.url);
        }),
    )
    .addCommand(
      new Command('credits')
        .description('Alias of buyer status')
        .option('--url <url>', 'Buyer local server URL', cliConfig.buyer.url)
        .action(async (options: { url: string }) => {
          await showBuyerStatus(options.url);
        }),
    )
    .addCommand(
      new Command('purchase')
        .description('Purchase buyer credits through the local buyer gateway')
        .requiredOption('--amount <amount>', ('USDC amount to deposit').replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL))
        .option('--url <url>', 'Buyer local server URL', cliConfig.buyer.url)
        .action(async (options) => {
          await purchaseCredits(options.url, options.amount);
        }),
    )
    .addCommand(
      new Command('withdraw')
        .description('Withdraw unused buyer credits from EscrowPool')
        .addCommand(
          new Command('request')
            .description('Start a withdrawal for unused credits')
            .requiredOption('--amount <amount>', ('USDC amount to withdraw').replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL))
            .option('--url <url>', 'Buyer local server URL', cliConfig.buyer.url)
            .action(async (options) => {
              await requestWithdraw(options.url, options.amount);
            }),
        )
        .addCommand(
          new Command('cancel')
            .description('Cancel the pending withdrawal')
            .option('--url <url>', 'Buyer local server URL', cliConfig.buyer.url)
            .action(async (options) => {
              await cancelWithdraw(options.url);
            }),
        )
        .addCommand(
          new Command('complete')
            .description('Complete the pending withdrawal after the delay')
            .option('--url <url>', 'Buyer local server URL', cliConfig.buyer.url)
            .action(async (options) => {
              await completeWithdraw(options.url);
            }),
        ),
    )
    .addCommand(
      new Command('chat')
        .description('Send a chat request through the buyer gateway')
        .argument('[prompt...]', 'Prompt to send')
        .option('--url <url>', 'Buyer local server URL', cliConfig.buyer.url)
        .option('--model <model>', 'Model to request', cliConfig.buyer.selectedModel)
        .action(async (promptParts: string[], options) => {
          const promptText = promptParts.join(' ').trim();
          await runChat({
            url: options.url,
            model: options.model,
            promptText: promptText || undefined,
          });
        }),
    )
    .addCommand(
      new Command('watch')
        .description('Watch buyer credits and spending in real time')
        .option('--url <url>', 'Buyer local server URL', cliConfig.buyer.url)
        .option('--interval <ms>', 'Polling interval in milliseconds', '3000')
        .action(async (options: { url: string; interval: string }) => {
          await watchBuyer(options.url, Number(options.interval));
        }),
    )
    .addCommand(
      new Command('guide')
        .description('Show how to connect to the local buyer API')
        .option('--url <url>', 'Buyer local server URL', cliConfig.buyer.url)
        .action(async (options: { url: string }) => {
          printBuyerQuickstart(normalizeUrl(options.url));
        }),
    );

  program
    .command('seller')
    .description('Seller-side actions')
    .addCommand(
      new Command('login')
        .alias('login-codex')
        .description('Log in an upstream account for embedded CLIProxyAPI seller mode')
        .option('--upstream <upstream>', 'codex, claude, or gemini', cliConfig.seller.upstream)
        .option('--device', 'Use device-code login instead of browser callback')
        .option('--cliproxy-source <path>', 'CLIProxyAPI source directory', cliConfig.seller.cliproxySourceDir)
        .option('--cliproxy-work-dir <path>', 'Embedded CLIProxyAPI work directory', cliConfig.seller.cliproxyWorkDir)
        .option('--cliproxy-auth-dir <path>', 'Embedded CLIProxyAPI auth directory', cliConfig.seller.cliproxyAuthDir)
        .action(async (options) => {
          await loginSellerUpstream({
            upstream: process.argv.includes('login-codex') ? 'codex' : normalizeSellerUpstreamOption(options.upstream),
            device: Boolean(options.device),
            cliproxySource: options.cliproxySource,
            cliproxyWorkDir: options.cliproxyWorkDir,
            cliproxyAuthDir: options.cliproxyAuthDir,
          });
        }),
    )
    .addCommand(
      new Command('up')
        .alias('start')
        .description('Start a local seller with prepared defaults')
        .option('--url <url>', 'Seller local status URL', cliConfig.seller.url)
        .option('--wallet-path <path>', 'Seller wallet JSON path', cliConfig.seller.walletPath)
        .option('--identity-path <path>', 'Seller P2P identity path', cliConfig.seller.identityPath)
        .option('--signing-identity-path <path>', 'Seller AIMM quote signing key path', cliConfig.seller.signingIdentityPath)
        .option('--e2ee-identity-path <path>', 'Seller E2EE identity path', cliConfig.seller.e2eeIdentityPath)
        .option('--p2p-port <port>', 'Seller P2P listen port', String(cliConfig.seller.p2pPort))
        .option('--cliproxy-source <path>', 'CLIProxyAPI source directory', cliConfig.seller.cliproxySourceDir)
        .option('--cliproxy-work-dir <path>', 'Embedded CLIProxyAPI work directory', cliConfig.seller.cliproxyWorkDir)
        .option('--cliproxy-auth-dir <path>', 'Embedded CLIProxyAPI auth directory', cliConfig.seller.cliproxyAuthDir)
        .option('--cliproxy-port <port>', 'Embedded CLIProxyAPI HTTP port', String(cliConfig.seller.cliproxyPort))
        .option('--models <models>', 'Comma-separated models to sell', cliConfig.seller.models.join(','))
        .option('--input-price <price>', ('Input price per 1M tokens in USDC').replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL), String(cliConfig.seller.pricing.input))
        .option('--output-price <price>', ('Output price per 1M tokens in USDC').replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL), String(cliConfig.seller.pricing.output))
        .option('--p0 <price>', ('AIMM base price per 1M tokens in USDC').replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL), String(cliConfig.seller.pricing.p0 ?? cliConfig.seller.pricing.input))
        .option('--alpha <value>', 'AIMM curve alpha', String(cliConfig.seller.pricing.alpha ?? 1))
        .option('--max-concurrent <count>', 'Maximum concurrent seller requests', String(cliConfig.seller.pricing.maxConcurrent ?? 5))
        .option('--background', 'Start in the background and return to the CLI')
        .action(async (options) => {
          await startSeller({
            url: options.url,
            walletPath: options.walletPath,
            identityPath: options.identityPath,
            signingIdentityPath: options.signingIdentityPath,
            e2eeIdentityPath: options.e2eeIdentityPath,
            p2pPort: String(options.p2pPort),
            cliproxySource: options.cliproxySource,
            cliproxyWorkDir: options.cliproxyWorkDir,
            cliproxyAuthDir: options.cliproxyAuthDir,
            cliproxyPort: String(options.cliproxyPort),
            models: options.models,
            inputPrice: String(options.inputPrice),
            outputPrice: String(options.outputPrice),
            p0: String(options.p0),
            alpha: String(options.alpha),
            maxConcurrent: String(options.maxConcurrent),
            background: Boolean(options.background),
          });
        }),
    )
    .addCommand(
      new Command('down')
        .description('Stop a seller process started from this CLI session')
        .action(async () => {
          const stopped = await stopSellerRuntime();
          if (!stopped) {
            console.log('No managed seller process is running in this CLI session.');
          }
        }),
    )
    .addCommand(
      new Command('status')
        .description('Show seller queue, backend, and protection status')
        .option('--url <url>', 'Seller local status URL', cliConfig.seller.url)
        .action(async (options) => {
          await showSellerStatus(options.url);
        }),
    )
    .addCommand(
      new Command('flush')
        .alias('flush-claims')
        .description('Flush pending seller claims to chain')
        .option('--url <url>', 'Seller local status URL', cliConfig.seller.url)
        .action(async (options) => {
          await flushClaims(options.url);
        }),
    )
    .addCommand(
      new Command('accounts')
        .description('Manage seller upstream auth accounts')
        .addCommand(
          new Command('list')
            .description('List current auth and restorable backups')
            .action(async () => {
              await listSellerAccounts();
            }),
        )
        .addCommand(
          new Command('switch')
            .description('Switch to an auth backup by path, basename, or index from `accounts list`')
            .argument('<backup>', 'Backup path, basename, or 1-based index')
            .action(async (backup: string) => {
              await switchSellerAccountBackup(backup);
            }),
        )
        .addCommand(
          new Command('logout')
            .description('Log out current seller upstream auth without permanently deleting it')
            .action(async () => {
              await logoutSellerAccount();
            }),
        )
        .addCommand(
          new Command('delete')
            .description('Delete an auth backup by path, basename, or index from `accounts list`')
            .argument('<backup>', 'Backup path, basename, or 1-based index')
            .action(async (backup: string) => {
              await deleteSellerAccountBackup(backup);
            }),
        ),
    )
    .addCommand(
      new Command('watch')
        .description('Watch seller earnings queue and protection state in real time')
        .option('--url <url>', 'Seller local status URL', cliConfig.seller.url)
        .option('--interval <ms>', 'Polling interval in milliseconds', '3000')
        .action(async (options: { url: string; interval: string }) => {
          await watchSeller(options.url, Number(options.interval));
        }),
    );

  program
    .command('init')
    .description('Guide a new user through buyer or seller setup')
    .option('--role <role>', 'buyer, seller, or both', 'buyer')
    .option('--buyer-url <url>', 'Buyer local server URL', cliConfig.buyer.url)
    .option('--seller-url <url>', 'Seller local status URL', cliConfig.seller.url)
    .action(async (options) => {
      await runInitCommand({
        forcedRole: normalizeRoleOption(options.role),
        buyerUrl: options.buyerUrl,
        sellerUrl: options.sellerUrl,
      });
    });

  program
    .command('console')
    .description('Open the current interactive console')
    .option('--buyer-url <url>', 'Buyer local server URL', cliConfig.buyer.url)
    .option('--seller-url <url>', 'Seller local status URL', cliConfig.seller.url)
    .action(async (options) => {
      await runInteractiveHome({
        buyerUrl: options.buyerUrl,
        sellerUrl: options.sellerUrl,
      });
    });

  program.command('ui')
    .description(translateUiText('打开可点击的本机网页客户端', getUiLanguage()))
    .option('--port <port>', 'Local browser client port', PAYMENT_TOKEN.symbol === 'BEM' ? '18501' : '18500')
    .option('--no-open', 'Start without opening a browser')
    .action(async options => { await runClientUI(cliConfig, { port: Number(options.port), open: options.open }); });

  const join = program.command('join').description(translateUiText('让 AI 准备、检查并启动买家或卖家', getUiLanguage()));
  join.command('prepare').requiredOption('--role <role>', 'buyer / seller / both').requiredOption('--model <model>', translateUiText('实际模型名', getUiLanguage()))
    .requiredOption('--max-call <amount>', translateUiText('主人指定的单次结算币上限', getUiLanguage())).requiredOption('--daily-budget <amount>', translateUiText('主人指定的每日结算币上限', getUiLanguage()))
    .option('--input-price <amount>', translateUiText('卖家输入报价 / 百万 Token', getUiLanguage())).option('--output-price <amount>', translateUiText('卖家输出报价 / 百万 Token', getUiLanguage()))
    .option('--upstream-file <path>', translateUiText('安装目录外的私有 API 配置；省略时使用已有账号登录', getUiLanguage()))
    .option('--market <origin>', translateUiText('市场 HTTPS 根地址', getUiLanguage()), 'https://shenjige.xyz')
    .action(async options => printJoinResult(await prepareJoin(cliConfig, options)));
  join.command('status').description(translateUiText('输出机器可读的接入状态、余额和下一步', getUiLanguage())).action(async () => printJoinResult(await joinStatus(cliConfig)));
  join.command('apply').requiredOption('--seller <wallet>', translateUiText('接收申请的卖家钱包', getUiLanguage())).description(translateUiText('签署非付款的买家申请；卖家审核后才有调用权限', getUiLanguage())).action(async options => printJoinResult(await joinSignedRequest(cliConfig, 'apply', options.seller)));
  join.command('claim').description(translateUiText('用当前钱包的非付款签名领取固定测试币；重跑查询原编号', getUiLanguage())).action(async () => printJoinResult(await joinSignedRequest(cliConfig, 'claim')));
  join.command('trust').requiredOption('--buyer <wallet>', translateUiText('已核实的买家钱包', getUiLanguage())).option('--hours <hours>', translateUiText('授权有效小时数 1–168', getUiLanguage()), '24').option('--revoke', translateUiText('撤销文件中的授权', getUiLanguage())).description(translateUiText('卖家主人审核后授权一个买家；AI 必须先获得主人同意', getUiLanguage())).action(async options => printJoinResult(await trustJoinedBuyer(cliConfig, options.buyer, Number(options.hours), !!options.revoke)));
  join.command('start').option('--no-open', translateUiText('不打开浏览器', getUiLanguage())).option('--headless', translateUiText('只启动节点与 AI 管理接口', getUiLanguage()))
    .option('--ui-port <port>', translateUiText('本机网页端口', getUiLanguage()), PAYMENT_TOKEN.symbol === 'BEM' ? '18501' : '18500').option('--agent-port <port>', translateUiText('无界面 AI 管理端口', getUiLanguage()), String(JOIN_AGENT_PORT))
    .action(async options => startJoined(cliConfig, { headless: options.headless, open: options.open, uiPort: Number(options.uiPort), agentPort: Number(options.agentPort) }));

  program
    .command('doctor')
    .description('Check whether local buyer and seller services look healthy')
    .option('--buyer-url <url>', 'Buyer local server URL', cliConfig.buyer.url)
    .option('--seller-url <url>', 'Seller local status URL', cliConfig.seller.url)
    .action(async (options) => {
      await runDoctor(options.buyerUrl, options.sellerUrl);
    });

  program
    .command('config')
    .description('Inspect or update ~/.clawmarket/config.json')
    .addCommand(
      new Command('path')
        .description('Print the config file path')
        .action(() => {
          console.log(cliConfig.paths.configPath);
        }),
    )
    .addCommand(
      new Command('get')
        .description('Read a config value with dot notation')
        .argument('[key]', 'Config key such as buyer.url')
        .action((key?: string) => {
          if (!key) {
            const { paths, ...config } = cliConfig;
            console.log(JSON.stringify(config, null, 2));
            return;
          }

          const value = getConfigValue(cliConfig, key);
          if (typeof value === 'undefined') {
            throw new Error(`Config key not found: ${key}`);
          }
          console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
        }),
    )
    .addCommand(
      new Command('set')
        .description('Write a config value with dot notation')
        .argument('<key>', 'Config key such as buyer.selectedModel')
        .argument('<value>', 'JSON, number, boolean, null, or string value')
        .action(async (key: string, value: string) => {
          const { paths, ...config } = cliConfig;
          const nextConfig = setConfigValue(config, key, parseConfigValue(value));
          const savedPath = await saveCliConfig(nextConfig);
          cliConfig = await loadCliConfig();
          console.log(`Updated ${key}`);
          console.log(`Config : ${savedPath}`);
        }),
    );

  const agent = program.command('agent').description(translateUiText('AI 管理：统一接口、主人规则和操作记录', getUiLanguage()));
  agent.command('serve').option('--port <port>', 'Local controller port', String(PAYMENT_AGENT_PORT)).action(async options => {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须为 1–65535。');
    const store = agentStoreFor(cliConfig), controller = new AgentController(store, localAgentBackend(cliConfig));
    console.log(translateUiText(`AI 接入地址：${await controller.start(port)}`, getUiLanguage()));
    console.log(translateUiText(`接入令牌文件：${store.tokenDisplayPath}`, getUiLanguage()));
    console.log(translateUiText('使用独立管理令牌，不需要钱包私钥。默认仅查询，主人通过控制台或 policy 命令授权。', getUiLanguage()));
  });
  agent.command('status').description(translateUiText('输出 AI 状态、预算和活动 JSON', getUiLanguage())).action(async () => console.log(JSON.stringify(await new AgentController(agentStoreFor(cliConfig), localAgentBackend(cliConfig)).status(), null, 2)));
  agent.command('tools').description(translateUiText('输出 AI 接口说明 JSON', getUiLanguage())).action(() => console.log(JSON.stringify(agentTools(), null, 2)));
  agent.command('policy').option('--file <path>', 'Owner-authored policy JSON file').action(async options => {
    const store = agentStoreFor(cliConfig);
    if (options.file) { store.savePolicy(JSON.parse(await readFile(options.file, 'utf8')) as AgentPolicy); console.log(translateUiText('主人规则已保存，没有执行交易。', getUiLanguage())); }
    else console.log(JSON.stringify(store.policy(), null, 2));
  });
  agent.command('pause').description(translateUiText('暂停后续 AI 自动操作', getUiLanguage())).action(() => { const store = agentStoreFor(cliConfig); store.savePolicy({ ...store.policy(), paused: true }); console.log(translateUiText('AI 自动操作已暂停；正在执行的操作继续等待结果。', getUiLanguage())); });

  if (process.argv.length <= 2) {
    if (!input.isTTY || !output.isTTY) {
      program.outputHelp();
      return;
    }

    if (shouldRunOnboarding(cliConfig)) {
      const onboarding = await runOnboardingWizard({
        config: cliConfig,
        buyerUrl: cliConfig.buyer.url,
        sellerUrl: cliConfig.seller.url,
      });
      cliConfig = await loadCliConfig();
      if (onboarding.completed && onboarding.openConsole) {
        await runInteractiveHome({
          buyerUrl: cliConfig.buyer.url,
          sellerUrl: cliConfig.seller.url,
        }, updateCheckPromise);
      }
      return;
    }

    await runInteractiveHome({
      buyerUrl: cliConfig.buyer.url,
      sellerUrl: cliConfig.seller.url,
    }, updateCheckPromise);
    return;
  }

  await program.parseAsync(process.argv);
}

async function runInteractiveHome(
  options: { buyerUrl: string; sellerUrl: string },
  updateCheckPromise?: Promise<UpdateCheckResult>,
): Promise<void> {
  let keepRunning = true;
  let pendingConsoleEvents: Array<{ scope: string; message: string }> = [];
  while (keepRunning) {
    const result = await runConsoleApp({
      config: {
        ...cliConfig,
        buyer: { ...cliConfig.buyer, url: options.buyerUrl },
        seller: { ...cliConfig.seller, url: options.sellerUrl },
      },
      initialEvents: pendingConsoleEvents,
      updateCheckPromise,
    });
    pendingConsoleEvents = [];
    cliConfig = await loadCliConfig();

    if (result.action === 'onboarding') {
      const onboarding = await runOnboardingWizard({
        config: cliConfig,
        buyerUrl: options.buyerUrl,
        sellerUrl: options.sellerUrl,
      });
      cliConfig = await loadCliConfig();
      keepRunning = onboarding.completed && onboarding.openConsole;
      continue;
    }

    if (result.action === 'seller_login') {
      if (!result.upstream) {
        console.error(translateUiText('登录请求缺少 upstream，已返回控制台。', getUiLanguage()));
        continue;
      }

      pendingConsoleEvents = await handleSellerLoginFromConsole({
        upstream: result.upstream,
        replaceAuth: result.replaceAuth ?? true,
        restartSeller: result.restartSeller ?? false,
        forceFreshLogin: result.forceFreshLogin ?? false,
        sellerUrl: options.sellerUrl,
      });
      cliConfig = await loadCliConfig();
      continue;
    }

    keepRunning = false;
  }
}

async function handleSellerLoginFromConsole(args: {
  upstream: SellerUpstream;
  replaceAuth: boolean;
  restartSeller: boolean;
  forceFreshLogin: boolean;
  sellerUrl: string;
}): Promise<Array<{ scope: string; message: string }>> {
  const events: Array<{ scope: string; message: string }> = [];
  const emitSellerEvent = (message: string) => {
    events.push({ scope: '卖家', message });
    console.log(message);
  };
  const sellerUrl = normalizeUrl(args.sellerUrl);
  const wasRunning = (await getServiceStatus(`${sellerUrl}/health`, 'seller')).online;
  const canAutoRestart = Boolean(getManagedSellerRuntime());
  if (wasRunning && canAutoRestart) {
    emitSellerEvent('正在停止 seller 以便释放 CLIProxyAPI ...');
    await stopSellerRuntime((line) => console.log(line));
  } else if (wasRunning) {
    emitSellerEvent('检测到 seller 正在运行，但不是当前 CLI 会话启动的；登录完成后需要手动重启 seller 才会切到新账号。');
  }

  const authDir = cliConfig.seller.cliproxyAuthDir;
  let backupPath: string | null = null;
  if (args.replaceAuth) {
    backupPath = await backupAuthDir(authDir, cliConfig.seller.upstream);
    if (backupPath) {
      console.log(translateUiText(`已备份当前登录到：${backupPath}`, getUiLanguage()));
    }
  }

  try {
    emitSellerEvent(`正在登录 ${upstreamLabel(args.upstream)} ...`);
    await loginSellerUpstream({
      upstream: args.upstream,
      device: false,
      cliproxySource: cliConfig.seller.cliproxySourceDir,
      cliproxyWorkDir: cliConfig.seller.cliproxyWorkDir,
      cliproxyAuthDir: authDir,
      allowReuseLocalCodexAuth: !args.forceFreshLogin,
    });
  } catch (error) {
    const message = `登录失败：${error instanceof Error ? error.message : String(error)}`;
    events.push({ scope: '卖家', message });
    console.error(message);
    if (backupPath) {
      console.log(translateUiText('正在恢复之前的登录文件 ...', getUiLanguage()));
      await restoreAuthDir(authDir, backupPath);
      console.log(translateUiText('已恢复之前的登录文件。', getUiLanguage()));
      events.push({ scope: '卖家', message: '已恢复之前的登录文件。' });
    } else if (args.replaceAuth) {
      await clearAuthDir(authDir);
    }
    return events;
  }

  emitSellerEvent(`${upstreamLabel(args.upstream)} 登录成功。`);
  events.push(...await refreshSellerModelsFromCliproxy(args.upstream, 8_000));
  cliConfig = await loadCliConfig();

  if ((args.restartSeller || wasRunning) && canAutoRestart) {
    emitSellerEvent('正在重启 seller 应用新账号 ...');
    await startSellerRuntime({
      ...getDefaultSellerRuntimeOptions(cliConfig),
      url: sellerUrl,
      report: (line) => console.log(line),
    });
    emitSellerEvent('已重启 seller，应用新账号。');
  } else if (args.restartSeller || wasRunning) {
    emitSellerEvent('新账号已写入 auth 目录，但当前 seller 需要你手动重启后才会真正生效。');
  }

  events.push({ scope: '系统', message: '已返回 Console。' });
  return events;
}

async function refreshSellerModelsFromCliproxy(
  upstream: SellerUpstream,
  timeoutMs = 20_000,
): Promise<Array<{ scope: string; message: string }>> {
  const events: Array<{ scope: string; message: string }> = [];
  const currentConfig = await loadCliConfig();
  const { paths, ...body } = currentConfig;
  let models = currentConfig.seller.upstream === upstream && currentConfig.seller.models.length > 0
    ? currentConfig.seller.models
    : defaultSellerModels(upstream);

  try {
    console.log(translateUiText(`正在发现 ${upstreamLabel(upstream)} 可卖模型 ...`, getUiLanguage()));
    events.push({ scope: '卖家', message: `正在发现 ${upstreamLabel(upstream)} 可卖模型 ...` });
    const discovered = await discoverUpstreamModels({
      upstream,
      cliproxySource: currentConfig.seller.cliproxySourceDir,
      cliproxyWorkDir: currentConfig.seller.cliproxyWorkDir,
      cliproxyAuthDir: currentConfig.seller.cliproxyAuthDir,
      timeoutMs,
    });
    if (discovered.length > 0) {
      models = reconcileSellerModels(upstream, models, discovered);
      console.log(translateUiText(`已发现 ${discovered.length} 个可卖模型：${discovered.join(', ')}`, getUiLanguage()));
      events.push({ scope: '卖家', message: `已发现 ${discovered.length} 个可卖模型。` });
    } else {
      console.log(translateUiText(`警告：${upstreamLabel(upstream)} 的 CLIProxyAPI 没返回任何模型，使用当前/默认模型：${models.join(', ')}`, getUiLanguage()));
      events.push({ scope: '卖家', message: '模型发现未返回结果，已使用当前/默认模型。' });
    }
  } catch (error) {
    console.log(translateUiText(`模型发现失败，使用当前/默认模型：${error instanceof Error ? error.message : String(error)}`, getUiLanguage()));
    events.push({ scope: '卖家', message: '模型发现失败，已使用当前/默认模型。' });
  }

  await saveCliConfig({
    ...body,
    seller: {
      ...body.seller,
      upstream,
      models,
    },
  });
  console.log(translateUiText(`已写入 seller 配置：${upstreamLabel(upstream)} / ${models.join(', ') || 'none'}`, getUiLanguage()));
  events.push({ scope: '卖家', message: `已写入 seller 配置：${upstreamLabel(upstream)} / ${models.join(', ') || 'none'}` });
  return events;
}

async function showBuyerStatus(url: string): Promise<void> {
  const [health, wallet] = await loadBuyerSummary(url);

  console.log('');
  console.log('Buyer Status');
  console.log('------------');
  console.log(`Gateway : ${normalizeUrl(url)}`);
  console.log(`Health  : ${health.status}`);
  console.log(`Address : ${wallet.address}`);
  console.log(`Port    : ${health.port}`);
  console.log((`Gas     : ${wallet.nativeBalance ?? 'unknown'} ETH`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL));
  console.log((`Wallet  : ${wallet.usdcBalance} USDC`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL));
  console.log((`Credits : ${wallet.escrowAvailable} USDC`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL));
  console.log(`Pool    : ${wallet.escrowPool}`);
  console.log(`Token   : ${wallet.tokenAddress}`);
  console.log('');
  printBuyerQuickstart(normalizeUrl(url));
}

async function showSellerStatus(url: string): Promise<void> {
  const status = await loadSellerSummary(url);

  console.log('');
  console.log('Seller Status');
  console.log('-------------');
  console.log(`Gateway       : ${normalizeUrl(url)}`);
  console.log(`Wallet        : ${status.seller.walletAddress}`);
  console.log(`Peer ID       : ${status.seller.peerId}`);
  console.log(`Backend       : ${status.backend.mode} -> ${status.backend.url}`);
  console.log(`Models        : ${status.backend.models.map((item) => item.model).join(', ') || 'none'}`);
  console.log(`Reachability  : ${formatReachabilityLabel(status.reachability)}`);
  if (status.reachability) {
    console.log(`Connect hint  : ${status.reachability.summary}`);
    const addressLines = formatReachabilityAddresses(status.reachability, 3);
    if (addressLines.length > 0) {
      console.log('Connect addrs :');
      for (const line of addressLines) {
        console.log(`  - ${line}`);
      }
    }
  }
  console.log((`Queued claims : ${status.claims.queuedCount} (${status.claims.queuedAmountUsdc} USDC)`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL));
  console.log(
    `Protection    : ${status.protection.offline ? 'offline' : 'online'} | ${status.protection.currentConcurrent}/${status.protection.maxConcurrent} concurrent`,
  );
  console.log(
    `Daily spend   : ${status.protection.dailySpendUsd}/${status.protection.dailyLimitUsd} ${PAYMENT_TOKEN.symbol}`,
  );
  if (status.clock?.skewMs != null) {
    console.log(`Clock skew    : ${status.clock.skewMs} ms`);
  }
  if (status.metrics) {
    console.log(
      `AIMM metrics  : quotes=${status.metrics.quotesBroadcastTotal} ok=${status.metrics.requestsInboundTotal.ok} reject=${status.metrics.requestsInboundTotal.reject} error=${status.metrics.requestsInboundTotal.error}`,
    );
    console.log(
      `AIMM util     : concurrent=${status.metrics.utilizationConcurrent.toFixed(2)} window=${status.metrics.utilizationWindow.toFixed(2)} cooling=${status.metrics.coolingAccounts} circuit=${status.metrics.circuitOpenAccounts}`,
    );
  }
  console.log(
    `Mining        : ${status.mining.status}${status.mining.rewardsAddress ? ` | ${status.mining.rewardsAddress}` : ''}`,
  );

  if (status.claims.preview.length > 0) {
    console.log('Claim preview :');
    for (const claim of status.claims.preview.slice(0, 5)) {
      console.log((`  - ${claim.amountUsdc} USDC from ${shortenAddress(claim.buyer)} nonce=${claim.nonce}`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL));
    }
  }

  console.log('');
  printSellerQuickstart(normalizeUrl(url));
}

async function purchaseCredits(url: string, amountUsd: string | number): Promise<void> {
  const result = await executePurchase(url, amountUsd);

  console.log('');
  console.log('Credits Purchased');
  console.log('-----------------');
  console.log((`Amount     : ${result.amountUsd} USDC`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL));
  console.log(`EscrowPool : ${result.escrowPool}`);
  console.log(`ApprovalTx : ${result.approvalTx ?? 'not needed'}`);
  console.log(`DepositTx  : ${result.depositTx}`);
}

async function requestWithdraw(url: string, amountUsd: string | number): Promise<void> {
  const result = await executeWithdrawRequest(url, amountUsd);

  console.log('');
  console.log('Withdraw Requested');
  console.log('------------------');
  console.log((`Amount     : ${result.amountUsd ?? amountUsd} USDC`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL));
  console.log(`EscrowPool : ${result.escrowPool ?? 'unknown'}`);
  console.log(`Tx         : ${result.tx}`);
  console.log('Next       : wait for the contract delay, then run `buyer withdraw complete`.');
}

async function cancelWithdraw(url: string): Promise<void> {
  const result = await executeWithdrawCancel(url);

  console.log('');
  console.log('Withdraw Canceled');
  console.log('-----------------');
  console.log(`Tx: ${result.tx}`);
}

async function completeWithdraw(url: string): Promise<void> {
  const result = await executeWithdrawComplete(url);

  console.log('');
  console.log('Withdraw Completed');
  console.log('------------------');
  console.log(`Tx: ${result.tx}`);
}

async function flushClaims(url: string): Promise<void> {
  const result = await executeFlushClaims(url);

  console.log('');
  console.log('Seller Claims Flush');
  console.log('-------------------');
  console.log(`Flushed     : ${result.flushed ? 'yes' : 'no'}`);
  console.log(`Tx Hash     : ${result.txHash ?? 'none'}`);
  console.log(`Queue count : ${result.claims.queuedCount}`);
  console.log((`Queue amount: ${result.claims.queuedAmountUsdc} USDC`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL));
}

async function listSellerAccounts(): Promise<void> {
  const current = await inspectAuthDir(cliConfig.seller.cliproxyAuthDir);
  const backups = await listAuthBackups(cliConfig.seller.cliproxyAuthDir);

  console.log('');
  console.log('Seller Accounts');
  console.log('---------------');
  console.log(`Current auth : ${formatAccountLabel(current.upstream ?? cliConfig.seller.upstream, current.identity, current.hasAuth)}`);
  console.log(`Auth dir     : ${cliConfig.seller.cliproxyAuthDir}`);
  console.log(`Last used    : ${current.lastUsedAt ?? 'unknown'}`);
  console.log('');
  console.log('Backups');
  if (backups.length === 0) {
    console.log('  none');
    return;
  }
  backups.forEach((backup, index) => {
    console.log(`  ${index + 1}. ${formatAccountLabel(backup.upstream, backup.identity, true)} | ${backup.savedAt}`);
    console.log(`     ${backup.path}`);
  });
}

async function switchSellerAccountBackup(backupRef: string): Promise<void> {
  const backup = await resolveBackupRef(backupRef);
  const wasRunning = (await getServiceStatus(`${normalizeUrl(cliConfig.seller.url)}/health`, 'seller')).online;
  if (wasRunning) {
    console.log('Stopping seller before switching auth...');
    await stopSellerRuntime((line) => console.log(line));
  }

  const currentBackup = await switchToBackup({
    authDir: cliConfig.seller.cliproxyAuthDir,
    backupPath: backup.path,
    currentUpstream: cliConfig.seller.upstream,
  });
  if (currentBackup) {
    console.log(`Backed up previous auth: ${currentBackup}`);
  }

  const current = await inspectAuthDir(cliConfig.seller.cliproxyAuthDir);
  await refreshSellerModelsFromCliproxy(current.upstream ?? backup.upstream ?? cliConfig.seller.upstream);
  cliConfig = await loadCliConfig();
  console.log(`Switched to ${formatAccountLabel(current.upstream ?? cliConfig.seller.upstream, current.identity, true)}`);

  if (wasRunning) {
    console.log('Restarting seller...');
    await startSellerRuntime({
      ...getDefaultSellerRuntimeOptions(cliConfig),
      report: (line) => console.log(line),
    });
  }
}

async function logoutSellerAccount(): Promise<void> {
  const wasRunning = (await getServiceStatus(`${normalizeUrl(cliConfig.seller.url)}/health`, 'seller')).online;
  if (wasRunning) {
    console.log('Stopping seller before logout...');
    await stopSellerRuntime((line) => console.log(line));
  }

  const logoutPath = await logoutCurrent(cliConfig.seller.cliproxyAuthDir);
  console.log(logoutPath ? `Logged out. Previous auth saved at: ${logoutPath}` : 'No current auth to log out.');
}

async function deleteSellerAccountBackup(backupRef: string): Promise<void> {
  const backup = await resolveBackupRef(backupRef);
  await deleteBackup(backup.path);
  console.log(`Deleted backup: ${backup.path}`);
}

async function resolveBackupRef(backupRef: string): Promise<Awaited<ReturnType<typeof listAuthBackups>>[number]> {
  const backups = await listAuthBackups(cliConfig.seller.cliproxyAuthDir);
  const trimmed = backupRef.trim();
  const index = Number(trimmed);
  if (Number.isInteger(index) && index >= 1 && index <= backups.length) {
    return backups[index - 1]!;
  }

  const resolved = backups.find((backup) => backup.path === trimmed || path.basename(backup.path) === trimmed);
  if (!resolved) {
    throw new Error(`Auth backup not found: ${backupRef}`);
  }
  return resolved;
}

function formatAccountLabel(upstream: SellerUpstream | null, identity: string | null, hasAuth: boolean): string {
  if (!hasAuth) {
    return `${upstream ? upstreamLabel(upstream) : 'Unknown'} · not logged in`;
  }
  return `${upstream ? upstreamLabel(upstream) : 'Unknown'} · ${identity ?? 'unknown (auth 文件存在)'}`;
}

async function runChat(options: ChatOptions): Promise<void> {
  console.log('');
  console.log('Assistant Reply');
  console.log('---------------');
  let wroteContent = false;
  const response = await requestChatStream(options, {
    onDelta(delta) {
      process.stdout.write(delta);
      wroteContent = true;
    },
  });
  if (!wroteContent) {
    const content = response.choices?.[0]?.message?.content?.trim() || '(empty response)';
    console.log(content);
  } else {
    console.log('');
  }

  if (response.usage) {
    console.log('');
    console.log(
      `Usage: prompt=${response.usage.prompt_tokens} completion=${response.usage.completion_tokens} total=${response.usage.total_tokens}`,
    );
  }
}

async function runDoctor(buyerUrl: string, sellerUrl: string): Promise<void> {
  const normalizedBuyerUrl = normalizeUrl(buyerUrl);
  const normalizedSellerUrl = normalizeUrl(sellerUrl);
  const buyerHealth = await checkEndpoint(`${normalizedBuyerUrl}/health`);
  const sellerHealth = await checkEndpoint(`${normalizedSellerUrl}/health`);
  const buyerCredits = buyerHealth.ok
    ? await checkEndpoint(`${normalizedBuyerUrl}/v1/credits`)
    : { ok: false, message: 'skipped because /health failed' };
  const buyerMetrics = buyerHealth.ok
    ? await checkEndpoint(`${normalizedBuyerUrl}/metrics`)
    : { ok: false, message: 'skipped because /health failed' };
  const sellerStatus = sellerHealth.ok
    ? await checkEndpoint(`${normalizedSellerUrl}/v1/seller/status`)
    : { ok: false, message: 'skipped because /health failed' };
  const sellerMetrics = sellerHealth.ok
    ? await checkEndpoint(`${normalizedSellerUrl}/metrics`)
    : { ok: false, message: 'skipped because /health failed' };
  const sellerSummary = sellerHealth.ok
    ? await fetchJson<SellerStatusPayload>(`${normalizedSellerUrl}/v1/seller/status`).catch(() => null)
    : null;

  console.log('');
  console.log('Doctor');
  console.log('------');
  printDoctorLine('Buyer /health', buyerHealth);
  printDoctorLine('Buyer /v1/credits', buyerCredits);
  printDoctorLine('Buyer /metrics', buyerMetrics);
  printDoctorLine('Seller /health', sellerHealth);
  printDoctorLine('Seller /v1/seller/status', sellerStatus);
  printDoctorLine('Seller /metrics', sellerMetrics);
  console.log('');
  console.log(`Seller upstream : ${cliConfig.seller.upstream}`);
  console.log(`Seller models   : ${cliConfig.seller.models.join(', ') || 'none'}`);
  console.log(`Seller pricing  : input=${cliConfig.seller.pricing.input} output=${cliConfig.seller.pricing.output} p0=${cliConfig.seller.pricing.p0 ?? cliConfig.seller.pricing.input} alpha=${cliConfig.seller.pricing.alpha ?? 1}`);
  if (sellerSummary?.metrics) {
    console.log(
      `AIMM metrics    : quotes=${sellerSummary.metrics.quotesBroadcastTotal} ok=${sellerSummary.metrics.requestsInboundTotal.ok} reject=${sellerSummary.metrics.requestsInboundTotal.reject} error=${sellerSummary.metrics.requestsInboundTotal.error}`,
    );
    console.log(
      `AIMM util       : concurrent=${sellerSummary.metrics.utilizationConcurrent.toFixed(2)} window=${sellerSummary.metrics.utilizationWindow.toFixed(2)} cooling=${sellerSummary.metrics.coolingAccounts} circuit=${sellerSummary.metrics.circuitOpenAccounts}`,
    );
  }
  if (sellerSummary?.clock?.skewMs != null) {
    console.log(`Clock skew    : ${sellerSummary.clock.skewMs} ms`);
  }
  await printDoctorBalances(buyerUrl);

  if (!buyerHealth.ok || !sellerHealth.ok) {
    console.log('');
    console.log('Hint: start the buyer or seller process first, then rerun `tam doctor`.');
  }
}

async function runInitCommand(options: {
  forcedRole: ClawMarketRole | null;
  buyerUrl: string;
  sellerUrl: string;
}): Promise<void> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error('`tam init` requires an interactive TTY.');
  }

  const result = await runOnboardingWizard({
    config: cliConfig,
    forcedRole: options.forcedRole,
    buyerUrl: options.buyerUrl,
    sellerUrl: options.sellerUrl,
  });
  cliConfig = await loadCliConfig();

  if (result.completed && result.openConsole) {
    await runInteractiveHome({
      buyerUrl: cliConfig.buyer.url,
      sellerUrl: cliConfig.seller.url,
    });
  }
}

async function startBuyer(options: {
  url: string;
  identityPath: string;
  seedFile: string;
  report?: (message: string) => void;
}): Promise<void> {
  await startBuyerRuntime({
    ...getDefaultBuyerRuntimeOptions(cliConfig),
    ...options,
  });
}

async function startSeller(options: {
  url: string;
  walletPath: string;
  identityPath: string;
  signingIdentityPath: string;
  e2eeIdentityPath: string;
  p2pPort: string;
  cliproxySource: string;
  cliproxyWorkDir: string;
  cliproxyAuthDir: string;
  cliproxyPort: string;
  models: string;
  inputPrice: string;
  outputPrice: string;
  p0: string;
  alpha: string;
  maxConcurrent: string;
  background: boolean;
  report?: (message: string) => void;
}): Promise<void> {
  await startSellerRuntime({
    ...getDefaultSellerRuntimeOptions(cliConfig),
    ...options,
  });
}

async function watchBuyer(url: string, intervalMs: number): Promise<void> {
  const targetUrl = normalizeUrl(url);
  const interval = normalizeInterval(intervalMs);
  let previous: BuyerWatchState | null = null;

  console.log('');
  console.log(`Watching buyer at ${targetUrl} every ${interval}ms. Press Ctrl+C to stop.`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const [health, wallet] = await loadBuyerSummary(targetUrl);

      const current: BuyerWatchState = {
        online: health.status === 'ok',
        address: wallet.address,
        creditsMicro: parseMicroUsdc(wallet.escrowAvailable),
      };

      if (previous == null || !previous.online) {
        console.log('');
        console.log((`Buyer online | ${current.address} | credits ${wallet.escrowAvailable} USDC`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL));
        printBuyerQuickstart(targetUrl);
      } else {
        const diff = current.creditsMicro - previous.creditsMicro;
        if (diff > 0n) {
          console.log((`[buyer] Credits increased by ${formatMicroUsdc(diff)} USDC | available ${wallet.escrowAvailable} USDC`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL));
        } else if (diff < 0n) {
          console.log((`[buyer] Spent ${formatMicroUsdc(-diff)} USDC | remaining ${wallet.escrowAvailable} USDC`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL));
        }
      }

      previous = current;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (previous == null || previous.online) {
        console.log(`[buyer] Offline: ${message}`);
      }
      previous = previous
        ? { ...previous, online: false }
        : { online: false, address: 'unknown', creditsMicro: 0n };
    }

    await sleep(interval);
  }
}

async function watchSeller(url: string, intervalMs: number): Promise<void> {
  const targetUrl = normalizeUrl(url);
  const interval = normalizeInterval(intervalMs);
  let previous: SellerWatchState | null = null;

  console.log('');
  console.log(`Watching seller at ${targetUrl} every ${interval}ms. Press Ctrl+C to stop.`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const status = await loadSellerSummary(targetUrl);
      const current: SellerWatchState = {
        online: status.status === 'ok',
        queuedCount: status.claims.queuedCount,
        queuedAmountMicro: BigInt(status.claims.queuedAmountMicroUsdc),
        protectionOffline: status.protection.offline,
      };

      if (previous == null || !previous.online) {
        console.log('');
        console.log(
          `Seller online | ${status.seller.walletAddress} | models ${status.backend.models.map((item) => item.model).join(', ') || 'none'}`,
        );
        printSellerQuickstart(targetUrl);
      } else {
        const amountDiff = current.queuedAmountMicro - previous.queuedAmountMicro;
        if (current.queuedCount > previous.queuedCount && amountDiff > 0n) {
          console.log(
            (`[seller] New earnings queued: +${formatMicroUsdc(amountDiff)} USDC | queue ${status.claims.queuedCount} claim(s), ${status.claims.queuedAmountUsdc} USDC`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL),
          );
        } else if (current.queuedCount < previous.queuedCount || amountDiff < 0n) {
          console.log(
            (`[seller] Claim queue decreased | queue ${status.claims.queuedCount} claim(s), ${status.claims.queuedAmountUsdc} USDC`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL),
          );
        }

        if (current.protectionOffline !== previous.protectionOffline) {
          console.log(`[seller] Protection state changed: ${current.protectionOffline ? 'offline' : 'online'}`);
        }
      }

      previous = current;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (previous == null || previous.online) {
        console.log(`[seller] Offline: ${message}`);
      }
      previous = previous
        ? { ...previous, online: false }
        : { online: false, queuedCount: 0, queuedAmountMicro: 0n, protectionOffline: false };
    }

    await sleep(interval);
  }
}

function printDoctorLine(label: string, result: { ok: boolean; message: string }): void {
  console.log(`${label.padEnd(25, ' ')} ${result.ok ? 'OK' : 'FAIL'}  ${result.message}`);
}

async function printDoctorBalances(buyerUrl: string): Promise<void> {
  try {
    const [, wallet] = await loadBuyerSummary(buyerUrl);
    console.log((`Buyer balance   : ${wallet.usdcBalance} USDC wallet, ${wallet.nativeBalance ?? 'unknown'} ETH gas`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL));
  } catch {
    console.log('Buyer balance   : unavailable');
  }

  try {
    const privateKey = await readPrivateKeyFromWallet(cliConfig.seller.walletPath, 'seller wallet');
    const balances = await readBalances(addressFromPrivateKey(privateKey));
    console.log((`Seller gas      : ${balances.ethFormatted} ETH`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL));
  } catch {
    console.log('Seller gas      : unavailable');
  }
}

function printBuyerQuickstart(url: string): void {
  const baseUrl = `${url}/v1`;
  console.log('Buyer Quickstart');
  console.log('----------------');
  console.log(`OpenAI-compatible API : ${baseUrl}`);
  console.log(`Models endpoint       : ${baseUrl}/models`);
  console.log(`Credits endpoint      : ${url}/v1/credits`);
  console.log('Local API auth        : Bearer token from ~/.clawmarket/api-token; CLI reads it automatically.');
  console.log('API token is a local access credential, never your wallet private key.');
  console.log('Examples:');
  console.log(translateUiText(`  corepack pnpm tam buyer chat --model ${cliConfig.buyer.selectedModel} --url ${url} "回复一个 ok"`, getUiLanguage()));
  console.log(`  curl ${baseUrl}/models -H 'Authorization: Bearer YOUR_LOCAL_API_TOKEN'`);
  console.log(
    translateUiText(`  curl ${baseUrl}/chat/completions -H 'Authorization: Bearer YOUR_LOCAL_API_TOKEN' -H 'Content-Type: application/json' -d '{"model":"${cliConfig.buyer.selectedModel}","messages":[{"role":"user","content":"回复一个 ok"}]}'`, getUiLanguage()),
  );
  console.log(`  corepack pnpm cli -- buyer purchase --amount 0.01 --url ${url}`);
  console.log(`  corepack pnpm cli -- buyer withdraw request --amount 0.01 --url ${url}`);
  console.log(`  corepack pnpm cli -- buyer watch --url ${url}`);
}

function printSellerQuickstart(url: string): void {
  console.log('Seller Quickstart');
  console.log('-----------------');
  console.log(`Status endpoint : ${url}/v1/seller/status`);
  console.log(`Health endpoint : ${url}/health`);
  console.log('Examples:');
  console.log(`  curl ${url}/v1/seller/status`);
  console.log(`  corepack pnpm cli -- seller flush-claims --url ${url}`);
  console.log(`  corepack pnpm cli -- seller watch --url ${url}`);
}

function formatReachabilityLabel(reachability: SellerReachabilityPayload | undefined): string {
  if (!reachability) {
    return 'checking';
  }

  switch (reachability.status) {
    case 'public_direct':
    case 'relay':
    case 'not_reachable':
      return reachability.label;
    default:
      return 'checking';
  }
}

function formatReachabilityAddresses(reachability: SellerReachabilityPayload, limit: number): string[] {
  const tagged = (scope: string, values: string[]) => values.map((value) => `${scope}: ${value}`);
  const direct = tagged('public', reachability.publicDirectMultiaddrs).slice(0, limit);
  const relay = tagged('relay', reachability.relayMultiaddrs).slice(0, Math.max(0, limit - direct.length));
  const remaining = Math.max(0, limit - direct.length - relay.length);
  const fallback = remaining > 0 ? tagged('private', reachability.privateMultiaddrs).slice(0, remaining) : [];
  return [...direct, ...relay, ...fallback];
}

function logError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
}

function normalizeRoleOption(value: string): ClawMarketRole | null {
  const normalized = value.trim().toLowerCase();
  return normalized === 'buyer' || normalized === 'seller' || normalized === 'both' ? normalized : null;
}

function normalizeSellerUpstreamOption(value: string): SellerUpstream {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'claude' || normalized === 'gemini') {
    return normalized;
  }
  throw new Error('--upstream must be one of: codex, claude, gemini');
}

function upstreamLabel(upstream: SellerUpstream): string {
  switch (upstream) {
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude';
    case 'gemini':
      return 'Gemini';
  }
}

main().catch((error) => {
  if (error instanceof ClientUpgradeRequiredError) {
    printUpgradeRequiredError(error);
    process.exitCode = 2;
    return;
  }
  logError(error);
  process.exitCode = 1;
});

function applyGlobalUrlOverridesFromArgv(argv: string[]): void {
  const buyerUrl = findOptionValue(argv, '--buyer-url');
  const sellerUrl = findOptionValue(argv, '--seller-url');

  if (buyerUrl) {
    cliConfig = {
      ...cliConfig,
      buyer: {
        ...cliConfig.buyer,
        url: buyerUrl,
      },
    };
  }

  if (sellerUrl) {
    cliConfig = {
      ...cliConfig,
      seller: {
        ...cliConfig.seller,
        url: sellerUrl,
      },
    };
  }
}

function findOptionValue(argv: string[], optionName: string): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }
    if (token === optionName) {
      return argv[index + 1] ?? null;
    }
    if (token.startsWith(`${optionName}=`)) {
      return token.slice(optionName.length + 1);
    }
  }
  return null;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function registerSignalHandlers(): void {
  const handleSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void shutdown(signal);
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  try {
    await Promise.allSettled([
      stopBuyerRuntime(),
      stopSellerRuntime(),
    ]);
  } finally {
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    if (input.isTTY) {
      input.setRawMode(false);
    }
    process.exit();
  }
}

function printUpgradeRequiredError(error: ClientUpgradeRequiredError): void {
  console.error(error.message);
  if (error.details.recommendedVersion) {
    console.error(translateUiText(`建议版本: v${error.details.recommendedVersion}`, getUiLanguage()));
  }
  if (error.details.minClientVersion) {
    console.error(translateUiText(`最低版本: v${error.details.minClientVersion}`, getUiLanguage()));
  }
  if (error.details.upgradeCommand) {
    console.error(translateUiText(`升级命令: ${error.details.upgradeCommand}`, getUiLanguage()));
  }
  if (error.details.upgradeUrl) {
    console.error(`Release: ${error.details.upgradeUrl}`);
  }
}
