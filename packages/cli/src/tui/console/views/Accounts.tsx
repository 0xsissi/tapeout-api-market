import { useEffect, useState } from 'react';
import { Box } from 'ink';
import { Text } from '../../../i18n/Text.js';

import { defaultSellerModels, reconcileSellerModels, type ClawMarketConfig, type SellerUpstream } from '../../../config/schema.js';
import type { CliDefaults } from '../../../config/store.js';
import { inspectAuthDir, type AuthInspection } from '../../../runtime/auth-inspector.js';
import {
  cleanupLoggedOutAuthDirs,
  deleteBackup,
  listAuthBackups,
  logoutCurrent,
  switchToBackup,
  type AuthBackup,
} from '../../../runtime/auth-manager.js';
import { discoverUpstreamModels } from '../../../runtime/cliproxy.js';
import {
  getDefaultSellerRuntimeOptions,
  getManagedSellerRuntime,
  startSellerRuntime,
  stopSellerRuntime,
} from '../../../runtime/seller-runtime.js';
import { theme } from '../../../theme.js';
import { FocusedSelectInput } from '../components/FocusedSelectInput.js';
import type { ConsoleSnapshot, ModalState } from '../types.js';

type AccountAction =
  | { type: 'switch'; backup: AuthBackup }
  | { type: 'login'; upstream: SellerUpstream }
  | { type: 'logout' }
  | { type: 'delete'; backup: AuthBackup };

export function AccountsView({
  config,
  snapshot,
  isFocused,
  onOpenModal,
  onPushEvent,
  onRefresh,
  onUpdateConfig,
  onRequestSellerLogin,
}: {
  config: CliDefaults;
  snapshot: ConsoleSnapshot;
  isFocused: boolean;
  onOpenModal: (modal: ModalState) => void;
  onPushEvent: (scope: string, message: string) => void;
  onRefresh: () => Promise<void>;
  onUpdateConfig: (config: ClawMarketConfig) => Promise<void>;
  onRequestSellerLogin: (request: { upstream: SellerUpstream; replaceAuth: boolean; restartSeller: boolean; forceFreshLogin?: boolean }) => void;
}) {
  const [currentAuth, setCurrentAuth] = useState<AuthInspection | null>(null);
  const [backups, setBackups] = useState<AuthBackup[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    setError(null);
    try {
      const [inspection, backupList] = await Promise.all([
        inspectAuthDir(config.seller.cliproxyAuthDir),
        listAuthBackups(config.seller.cliproxyAuthDir),
      ]);
      setCurrentAuth(inspection);
      setBackups(backupList);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  };

  useEffect(() => {
    void reload();
    void cleanupLoggedOutAuthDirs(config.seller.cliproxyAuthDir).then((removed) => {
      if (removed.length > 0) {
        onPushEvent('账号', `已清理 ${removed.length} 个过期登出备份。`);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.seller.cliproxyAuthDir]);

  const actions: Array<{ label: string; value: AccountAction }> = [
    ...backups.map((backup) => ({
      label: `切换到 ${backupActionLabel(backup)}`,
      value: { type: 'switch' as const, backup },
    })),
    { label: '登录新的 Codex 账号', value: { type: 'login', upstream: 'codex' } },
    { label: '登录新的 Claude 账号', value: { type: 'login', upstream: 'claude' } },
    { label: '登录新的 Gemini 账号', value: { type: 'login', upstream: 'gemini' } },
    { label: '登出当前账号', value: { type: 'logout' } },
    ...backups.map((backup) => ({
      label: `删除备份 ${backupActionLabel(backup)}`,
      value: { type: 'delete' as const, backup },
    })),
  ];

  return (
    <Box flexDirection="column">
      <Text>当前使用：{currentAuth?.upstream ? upstreamLabel(currentAuth.upstream) : upstreamLabel(config.seller.upstream)} · {currentAuth?.identity ?? (currentAuth?.hasAuth ? 'unknown (auth 文件存在)' : '未登录')}</Text>
      <Text>状态：{currentAuth?.hasAuth ? `登录文件存在 · 上次使用 ${formatTime(currentAuth.lastUsedAt)}` : '未发现登录文件'}</Text>
      <Text>登录文件：{config.seller.cliproxyAuthDir}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>备份（可恢复）：</Text>
        {backups.length > 0 ? backups.slice(0, 6).map((backup) => (
          <Text key={backup.path}>  - {backupLabel(backup)} · {formatTime(backup.savedAt)}</Text>
        )) : <Text color={theme.muted}>  暂无备份。</Text>}
      </Box>
      <Box marginTop={1}>
        <FocusedSelectInput
          isFocused={isFocused}
          items={actions}
          onSelect={(item) => {
            const action = item.value;
            if (action.type === 'login') {
              onRequestSellerLogin({
                upstream: action.upstream,
                replaceAuth: true,
                restartSeller: true,
                forceFreshLogin: action.upstream === 'codex',
              });
              return;
            }
            if (action.type === 'switch') {
              confirmSwitchBackup(action.backup);
              return;
            }
            if (action.type === 'logout') {
              confirmLogout();
              return;
            }
            confirmDelete(action.backup);
          }}
        />
      </Box>
      {error ? (
        <Box marginTop={1}>
          <Text color={theme.danger}>错误: {error}</Text>
        </Box>
      ) : null}
    </Box>
  );

  function confirmSwitchBackup(backup: AuthBackup) {
    onOpenModal({
      type: 'confirm',
      title: `切换到 ${backupLabel(backup)}？`,
      description: '当前登录会先自动备份，然后恢复所选备份；如果 seller 正在运行，会自动重启。',
      confirmLabel: '切换',
      cancelLabel: '取消',
      onConfirm: async () => {
        const currentUpstream = currentAuth?.upstream ?? config.seller.upstream;
        if (backup.identity === currentAuth?.identity && backup.upstream === currentUpstream) {
          onPushEvent('账号', '所选备份与当前账号相同，未执行切换。');
          return;
        }

        const wasRunning = snapshot.sellerService.online;
        const canAutoRestart = Boolean(getManagedSellerRuntime());
        if (wasRunning && canAutoRestart) {
          await stopSellerRuntime((line) => onPushEvent('卖家', line));
        }
        const currentBackup = await switchToBackup({
          authDir: config.seller.cliproxyAuthDir,
          backupPath: backup.path,
          currentUpstream: config.seller.upstream,
        });
        if (currentBackup) {
          onPushEvent('账号', `已备份当前账号到 ${currentBackup}`);
        }
        const inspection = await inspectAuthDir(config.seller.cliproxyAuthDir);
        const upstream = inspection.upstream ?? backup.upstream ?? config.seller.upstream;
        const models = await discoverModelsOrPreset(config, upstream);
        const { paths, ...configBody } = config;
        const nextConfig: ClawMarketConfig = {
          ...configBody,
          seller: {
            ...configBody.seller,
            upstream,
            models,
          },
        };
        await onUpdateConfig(nextConfig);
        if (wasRunning && canAutoRestart) {
          await startSellerRuntime({
            ...getDefaultSellerRuntimeOptions({ ...config, ...nextConfig }),
            report: (line) => onPushEvent('卖家', line),
          });
        } else if (wasRunning) {
          onPushEvent('卖家', '已切换 auth，但当前 seller 不是这个 CLI 会话启动的；请手动重启 seller 后再测试。');
        }
        onPushEvent('账号', `已切换到 ${upstreamLabel(upstream)}：${inspection.identity ?? 'unknown'}`);
        await reload();
        await onRefresh();
      },
    });
  }

  function confirmLogout() {
    onOpenModal({
      type: 'confirm',
      title: '登出当前账号？',
      description: '当前 auth 会移动到 loggedout 备份目录并保留 7 天；seller 会停止，配置中的上游保持不变。',
      confirmLabel: '登出',
      cancelLabel: '取消',
      onConfirm: async () => {
        if (snapshot.sellerService.online) {
          await stopSellerRuntime((line) => onPushEvent('卖家', line));
        }
        const logoutPath = await logoutCurrent(config.seller.cliproxyAuthDir);
        onPushEvent('账号', logoutPath ? `已登出，旧登录保存在 ${logoutPath}` : '当前没有可登出的 auth。');
        await reload();
        await onRefresh();
      },
    });
  }

  function confirmDelete(backup: AuthBackup) {
    onOpenModal({
      type: 'confirm',
      title: `删除备份 ${backupLabel(backup)}？`,
      description: `将永久删除：${backup.path}`,
      confirmLabel: '删除',
      cancelLabel: '取消',
      onConfirm: async () => {
        await deleteBackup(backup.path);
        onPushEvent('账号', `已删除备份 ${backupLabel(backup)}`);
        await reload();
      },
    });
  }
}

async function discoverModelsOrPreset(config: CliDefaults, upstream: SellerUpstream): Promise<string[]> {
  try {
    const discovered = await discoverUpstreamModels({
      upstream,
      cliproxySource: config.seller.cliproxySourceDir,
      cliproxyWorkDir: config.seller.cliproxyWorkDir,
      cliproxyAuthDir: config.seller.cliproxyAuthDir,
    });
    return reconcileSellerModels(upstream, config.seller.upstream === upstream ? config.seller.models : [], discovered);
  } catch {
    return config.seller.upstream === upstream && config.seller.models.length ? config.seller.models : defaultSellerModels(upstream);
  }
}

function backupLabel(backup: AuthBackup): string {
  return `${upstreamLabel(backup.upstream)} (${backup.identity ?? 'unknown'})`;
}

function backupActionLabel(backup: AuthBackup): string {
  return `${backupLabel(backup)} · ${formatTime(backup.savedAt)}`;
}

function upstreamLabel(upstream: SellerUpstream | null): string {
  switch (upstream) {
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude';
    case 'gemini':
      return 'Gemini';
    default:
      return 'Unknown';
  }
}

function formatTime(value: string | null): string {
  if (!value) {
    return 'unknown';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}
