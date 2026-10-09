import { Box } from 'ink';
import Spinner from 'ink-spinner';
import { useEffect, useState } from 'react';
import { Text } from '../../../i18n/Text.js';
import { theme } from '../../../theme.js';
import { startupPhaseLabel, type StartupPhase, type StartupRole } from '../../../runtime/startup-progress.js';

export interface StartupState { phase: StartupPhase; startedAt: number; }

export function StartupProgress({ buyer, seller, compact = false }: { buyer?: StartupState | null; seller?: StartupState | null; compact?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const row = (role: StartupRole, state: StartupState) => <Text key={role} color={theme.accent} wrap="truncate-end">
    <Spinner type="dots" /> {role === 'buyer' ? '买家启动中' : '卖家启动中'} · {Math.max(0, Math.floor((now - state.startedAt) / 1000))}s · {startupPhaseLabel(role, state.phase)}
  </Text>;
  const compiling = seller?.phase === 'proxy-build' || seller?.phase === 'proxy-start';
  if (compact) return buyer ? row('buyer', buyer) : seller ? row('seller', seller) : null;
  return <Box flexDirection="column">
    {buyer ? row('buyer', buyer) : null}
    {seller ? row('seller', seller) : null}
    <Text color={theme.muted} wrap="truncate-end">{compiling ? '首次启动反代需要准备依赖，完成后后续启动会更快。' : '服务正在准备，Esc / Tab 可切换菜单，无需重复启动。'}</Text>
  </Box>;
}
