import { Box } from 'ink';
import { Text } from '../../../i18n/Text.js';
import { useEffect, useState } from 'react';
import { PAYMENT_TOKEN, PAYMENT_AGENT_PORT, type AgentAction, type AgentPolicy } from '@clawmarket/shared';
import type { CliDefaults } from '../../../config/store.js';
import { agentStoreFor } from '../../../agent/controller.js';
import { theme } from '../../../theme.js';
import { FocusedSelectInput } from '../components/FocusedSelectInput.js';
import type { PromptModalState } from '../types.js';

const labels = { invoke: '调用 API', deposit: '自动充值', collect: '结算收入', price: '调整底价' };
type Pane = 'overview' | 'budget' | 'permissions' | 'pricing' | 'activity';
const paneLabels = { overview: '总览', budget: '预算与模型', permissions: '操作权限', pricing: '卖家调价规则', activity: '最近操作' };
export function AgentView({ config, isFocused, onOpenPrompt, onPushEvent }: { config: CliDefaults; isFocused: boolean; onOpenPrompt: (p: PromptModalState) => void; onPushEvent: (scope: string, message: string) => void }) {
  const [, setTick] = useState(0), [error, setError] = useState<string | null>(null), [pane, setPane] = useState<Pane>('overview');
  useEffect(() => { const timer = setInterval(() => setTick(x => x + 1), 3000); return () => clearInterval(timer); }, []);
  const store = agentStoreFor(config);
  let policy, budget, operations;
  try { policy = store.policy(); budget = store.budget(); operations = store.operations().slice(-5).reverse(); }
  catch (e) { return <Text color={theme.danger}>规则或操作记录不可用：{e instanceof Error ? e.message : String(e)}</Text>; }
  const update = (changes: Partial<AgentPolicy>) => { store.savePolicy({ ...store.policy(), ...changes }); setTick(x => x + 1); onPushEvent('AI 管理', '主人规则已更新。'); };
  const amountLabels = { dailySpendToken: '每日调用预算', maxCallToken: '单次调用上限', dailyDepositToken: '每日自动充值额度' };
  const items = pane === 'overview' ? [
    { label: policy.paused ? '开启已授权的自动操作' : '暂停自动操作', value: 'pause' },
    ...(['budget', 'permissions', 'pricing', 'activity'] as Pane[]).map(value => ({ label: paneLabels[value], value })),
  ] : pane === 'budget' ? [
    ...Object.entries(amountLabels).map(([value, label]) => ({ label: '设置' + label, value })), { label: '设置允许的模型', value: 'models' },
  ] : pane === 'permissions' ? (['invoke', 'deposit', 'collect', 'price'] as AgentAction[]).map(a => ({ label: (policy.allowedActions.includes(a) ? '关闭' : '允许') + ' AI ' + labels[a], value: a })) : pane === 'pricing' ? [{ label: '修改卖家调价规则', value: 'editPricing' }] : [];
  if (pane !== 'overview') items.push({ label: '返回 AI 管理总览', value: 'overview' });
  return <Box flexDirection="column">
    <Text bold>AI 管理 · {paneLabels[pane]} · {policy.paused ? '已暂停' : '已开启'}</Text>
    {pane === 'overview' ? <>
      <Text>今日已花：{budget.spentToken} · 剩余：{budget.remainingToken} {PAYMENT_TOKEN.symbol}</Text>
      <Text>进行中 / 待核对预留：{budget.reservedToken} {PAYMENT_TOKEN.symbol}</Text>
      <Text>今日自动充值：{budget.depositedToken} / {policy.dailyDepositToken} {PAYMENT_TOKEN.symbol}</Text>
      <Text>允许 AI 做：{policy.allowedActions.map(a => labels[a]).join('、') || '仅查询'}</Text>
      <Text>允许的模型：{policy.models.join('、') || '尚未设置'}</Text>
      <Text color={theme.muted}>外部 AI 发起操作，程序按规则执行；暂停只拦截新操作。</Text>
    </> : null}
    {pane === 'budget' ? <>
      <Text>每日调用预算：{policy.dailySpendToken} · 单次上限：{policy.maxCallToken} {PAYMENT_TOKEN.symbol}</Text>
      <Text>每日自动充值额度：{policy.dailyDepositToken} · 待核对充值：{budget.depositReservedToken} {PAYMENT_TOKEN.symbol}</Text>
      <Text>允许的模型：{policy.models.join('、') || '尚未设置'}</Text>
      <Text color={theme.muted}>按 UTC 日计算。未知结果保留额度；充值与消费分别限制。</Text>
    </> : null}
    {pane === 'permissions' ? <>
      <Text>先设置预算、模型和价格范围，再开启对应权限。</Text>
      <Text color={theme.muted}>修改规则不会发起交易；AI 无权修改主人规则。</Text>
    </> : null}
    {pane === 'pricing' ? <>
      <Text>卖价范围：{policy.sellerPrice.minimum}–{policy.sellerPrice.maximum} {PAYMENT_TOKEN.symbol}/百万 Token</Text>
      <Text>单次调幅最多 {policy.sellerPrice.maxChangePercent}% · 间隔至少 {policy.sellerPrice.minIntervalSeconds} 秒</Text>
      <Text color={theme.muted}>自动报价不会超过最高价；改价影响后续报价，重启恢复启动配置。</Text>
    </> : null}
    {pane === 'activity' ? <Box flexDirection="column">
      {operations.length === 0 ? <Text>还没有操作记录。</Text> : operations.map(op => <Box key={op.id} flexDirection="column">
        <Text>{new Date(op.createdAt).toLocaleTimeString()} · {labels[op.action]} · {op.message}{op.chargedToken !== '0' ? ' · ' + op.chargedToken + ' ' + PAYMENT_TOKEN.symbol : ''}</Text>
        <Text color={theme.muted}>编号：{op.id}{op.reason ? ' · 原因：' + op.reason : ''}</Text>
      </Box>)}
      <Text color={theme.muted}>结果不确定时不自动重试，请按编号核对交易记录。</Text>
    </Box> : null}
    <Box marginTop={1}><FocusedSelectInput key={pane} isFocused={isFocused} items={items} onSelect={item => {
      try {
        setError(null);
        if (['overview', 'budget', 'permissions', 'pricing', 'activity'].includes(item.value)) setPane(item.value as Pane);
        else if (item.value === 'pause') update({ paused: !policy.paused });
        else if (item.value in amountLabels) { const key = item.value as keyof typeof amountLabels; onOpenPrompt({ type: 'prompt', title: amountLabels[key] + '（' + PAYMENT_TOKEN.symbol + '）', initialValue: policy[key], description: '输入代币数量。每日额度按 UTC 日计算。', onSubmit: value => update({ [key]: value.trim() }) }); }
        else if (item.value === 'models') onOpenPrompt({ type: 'prompt', title: '允许 AI 使用的模型', initialValue: policy.models.join(','), description: '填入已上架的模型名称，用逗号分开。', onSubmit: value => update({ models: value.split(',').map(x => x.trim()).filter(Boolean) }) });
        else if (item.value === 'editPricing') onOpenPrompt({ type: 'prompt', title: '卖家调价规则', initialValue: [policy.sellerPrice.minimum, policy.sellerPrice.maximum, policy.sellerPrice.maxChangePercent, policy.sellerPrice.minIntervalSeconds].join(','), description: '依次输入：最低价,最高价,最大调幅百分比,最短间隔秒数。例如 1,10,10,60；价格单位是 ' + PAYMENT_TOKEN.symbol + '/百万 Token。', onSubmit: value => { const values = value.split(',').map(x => x.trim()); if (values.length !== 4 || values.some(x => !x)) throw new Error('请填写四个数值。'); const [minimum, maximum, maxChangePercent, minIntervalSeconds] = values.map(Number); update({ sellerPrice: { minimum: minimum!, maximum: maximum!, maxChangePercent: maxChangePercent!, minIntervalSeconds: minIntervalSeconds! } }); } });
        else { const action = item.value as AgentAction; update({ allowedActions: policy.allowedActions.includes(action) ? policy.allowedActions.filter(x => x !== action) : [...policy.allowedActions, action] }); }
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    }} /></Box>
    {error ? <Text color={theme.danger}>{error}</Text> : null}
    {pane === 'overview' ? <Box marginTop={1} flexDirection="column">
      <Text color={theme.muted}>接入：http://127.0.0.1:{PAYMENT_AGENT_PORT} · 独立启动：pnpm tam agent serve</Text>
      <Text color={theme.muted}>AI 接入令牌文件：{store.tokenDisplayPath}（无需钱包私钥）</Text>
    </Box> : null}
  </Box>;
}
