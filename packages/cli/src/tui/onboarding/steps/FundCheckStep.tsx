import { PAYMENT_TOKEN, PAYMENT_NATIVE_SYMBOL, PAYMENT_NETWORK_NAME, PAYMENT_FUNDING_HELP, PAYMENT_FUNDING_LINKS } from '@clawmarket/shared';
import SelectInput from '../../../i18n/SelectInput.js';
import Spinner from 'ink-spinner';
import { Box, useInput } from 'ink';
import { Text } from '../../../i18n/Text.js';
import { useEffect, useState } from 'react';

import { MIN_GAS_WEI, type WalletBalances, readBalances } from '../../../services/chain.js';
import { theme } from '../../../theme.js';
import { QrCode } from '../../components/QrCode.js';

export function FundCheckStep({
  address,
  requireUsdc,
  rpcUrl,
  minGasWei = MIN_GAS_WEI,
  onContinue,
}: {
  address: `0x${string}`;
  requireUsdc: boolean;
  rpcUrl?: string;
  minGasWei?: bigint;
  onContinue: () => void;
}) {
  const [balances, setBalances] = useState<WalletBalances | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(false);
  const [history, setHistory] = useState<string[]>([]);

  const refresh = async () => {
    setStatus('loading');
    setError(null);
    try {
      const next = await readBalances(address, rpcUrl);
      setBalances(next);
      setStatus('ready');
      setHistory((current) => [
        ...current,
        (`${new Date().toLocaleTimeString()} ETH=${trimDisplay(next.ethFormatted)} USDC=${trimDisplay(next.usdcFormatted)}`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL),
      ].slice(-3));
    } catch (refreshError) {
      const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
      setError(message);
      setStatus('error');
      setHistory((current) => [...current, `${new Date().toLocaleTimeString()} 刷新失败: ${message}`].slice(-3));
    }
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 10_000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, rpcUrl]);

  useInput((input) => {
    if (input.toLowerCase() === 'r') {
      void refresh();
      return;
    }
    if (input.toLowerCase() === 's') {
      setSkipped(true);
    }
  });

  const gasOk = balances ? balances.ethWei >= minGasWei : false;
  const usdcOk = !requireUsdc || (balances ? balances.usdcMicro > 0n : false);
  const canContinue = gasOk && usdcOk;

  return (
    <Box flexDirection="column">
      <Text>钱包：{address}</Text>
      <Box marginTop={1}>
        <QrCode value={address} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <BalanceLine
          label={("ETH (gas)").replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL)}
          value={balances ? trimDisplay(balances.ethFormatted) : '读取中'}
          ok={gasOk}
          note={`阈值 ${trimDisplay(formatWeiAsEth(minGasWei))}`}
        />
        {requireUsdc ? (
          <BalanceLine
            label={("USDC").replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL)}
            value={balances ? trimDisplay(balances.usdcFormatted) : '读取中'}
            ok={usdcOk}
            note={("建议至少 1 USDC").replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL)}
          />
        ) : null}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.muted}>网络：{PAYMENT_NETWORK_NAME}</Text>
        <Text color={theme.muted}>{PAYMENT_FUNDING_HELP}</Text>
        {PAYMENT_FUNDING_LINKS.map((link) => (
          <Text key={link} color={theme.muted}>  - {link}</Text>
        ))}
      </Box>
      {status === 'loading' ? (
        <Box marginTop={1}>
          <Text color={theme.accent}><Spinner type="dots" /> 正在刷新链上余额…</Text>
        </Box>
      ) : null}
      {status === 'error' && error ? (
        <Box marginTop={1}>
          <Text color={theme.danger}>RPC 错误: {error}。检查网络后按 r 重试。</Text>
        </Box>
      ) : null}
      {history.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          {history.map((line) => (
            <Text key={line} color={theme.muted}>{line}</Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={theme.muted}>按 r 刷新，按 s 跳过；余额达标后按 Enter 继续。</Text>
      </Box>
      <Box marginTop={1}>
        <SelectInput
          items={[
            { label: canContinue ? '余额达标，继续' : skipped ? '已选择跳过，继续' : '等待余额达标或按 s 跳过', value: 'next' },
          ]}
          onSelect={() => {
            if (canContinue || skipped) {
              onContinue();
            }
          }}
        />
      </Box>
    </Box>
  );
}

function BalanceLine({ label, value, ok, note }: { label: string; value: string; ok: boolean; note: string }) {
  return (
    <Text>
      {label.padEnd(11, ' ')}: {value.padEnd(10, ' ')}{' '}
      <Text color={ok ? theme.primary : theme.danger}>{ok ? 'OK' : '不足'}</Text>{' '}
      <Text color={theme.muted}>{note}</Text>
    </Text>
  );
}

function formatWeiAsEth(value: bigint): string {
  const whole = value / 1_000_000_000_000_000_000n;
  const fraction = (value % 1_000_000_000_000_000_000n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole.toString()}${fraction ? `.${fraction}` : ''}`;
}

function trimDisplay(value: string): string {
  if (!value.includes('.')) {
    return value;
  }
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.slice(0, 6)}`.replace(/\.?0+$/, '') || '0';
}
