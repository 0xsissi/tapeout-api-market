import { PAYMENT_TOKEN, PAYMENT_NATIVE_SYMBOL } from '@clawmarket/shared';
import { Box, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, RawText } from '../../../i18n/Text.js';

import type { CliDefaults } from '../../../config/store.js';
import { normalizeUrl, shortenAddress } from '../../../utils.js';
import { isLocalApiUrl, readLocalApiToken } from '../../../services/local-api-token.js';
import { copyToClipboard } from '../../helpers/clipboard.js';
import { FocusedSelectInput } from '../components/FocusedSelectInput.js';
import { theme } from '../../../theme.js';
import type { ConsoleSnapshot } from '../types.js';

export function UsageView({
  config,
  snapshot,
  isFocused,
  onPushEvent,
}: {
  config: CliDefaults;
  snapshot: ConsoleSnapshot;
  isFocused: boolean;
  onPushEvent: (scope: string, message: string) => void;
}) {
  const baseUrl = `${normalizeUrl(config.buyer.url)}/v1`;
  const model = snapshot.selectedModel;
  const wallet = snapshot.buyerSummary?.address;
  const local = isLocalApiUrl(config.buyer.url);
  const unavailable = local ? '本机 API Key 暂不可用，买家启动后会自动显示。' : '当前连接的是远程买家，请使用该服务的 API Key。';
  const [keyRevision, setKeyRevision] = useState(0);
  const apiKey = useMemo(() => readLocalApiToken(config.buyer.url, config.paths.homeDir), [config.buyer.url, config.paths.homeDir, snapshot.buyerService.online, keyRevision]);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const copying = useRef(false);
  useEffect(() => {
    setCopyMessage(null);
  }, [config.buyer.url, config.paths.homeDir, snapshot.buyerService.online]);

  const copy = async (target: 'key' | 'url' | 'model') => {
    if (copying.current) return;
    const currentKey = target === 'key' ? readLocalApiToken(config.buyer.url, config.paths.homeDir) : apiKey;
    if (target === 'key') setKeyRevision(revision => revision + 1);
    const value = target === 'key' ? currentKey : target === 'url' ? baseUrl : model;
    if (!value) { setCopyMessage(unavailable); return; }
    copying.current = true;
    try {
      const copied = await copyToClipboard(value);
      const message = !copied ? '复制失败，请直接选中上面的内容复制。' : target === 'key' ? '已复制 API Key。' : target === 'url' ? '已复制 Base URL。' : '已复制模型名。';
      setCopyMessage(message); onPushEvent('API', message);
    } catch { setCopyMessage('复制失败，请直接选中上面的内容复制。'); }
    finally { copying.current = false; }
  };
  useInput(input => {
    if (input.toLowerCase() === 'k') void copy('key');
    else if (input.toLowerCase() === 'u') void copy('url');
    else if (input.toLowerCase() === 'm') void copy('model');
  }, { isActive: isFocused });

  return (
    <Box flexDirection="column">
      <Text>本机 API 已启动后，其他工具可以按 OpenAI-compatible 方式连接。</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>Base URL : {baseUrl}</Text>
        <Text>API Key  : {apiKey ? <RawText>{apiKey}</RawText> : unavailable}</Text>
        <Text>Model    : {model}</Text>
        <Text>Wallet   : {wallet ? (`${shortenAddress(wallet)} | Escrow ${snapshot.buyerSummary?.escrowAvailable ?? '0'} USDC`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL) : 'buyer 未连接'}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <FocusedSelectInput<'key' | 'url' | 'model'> isFocused={isFocused}
          items={[
            { label: '[K] 复制 API Key', value: 'key' },
            { label: '[U] 复制 Base URL', value: 'url' },
            { label: '[M] 复制模型名', value: 'model' },
          ]}
          onSelect={item => { void copy(item.value); }}
        />
        {copyMessage ? <Text color={copyMessage.startsWith('已复制') ? theme.primary : theme.accent}>{copyMessage}</Text> : null}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text>curl 测试模型列表：</Text>
        <Text color="gray">curl {baseUrl}/models -H 'Authorization: Bearer YOUR_LOCAL_API_TOKEN'</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text>curl 发起聊天：</Text>
        <Text color="gray">curl {baseUrl}/chat/completions \</Text>
        <Text color="gray">  -H 'Content-Type: application/json' \</Text>
        <Text color="gray">  -H 'Authorization: Bearer YOUR_LOCAL_API_TOKEN' \</Text>
        <Text color="gray">  -d '{"{"}"model":"{model}","messages":[{"{"}"role":"user","content":"hello"{"}"}]{"}"}'</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text>OpenAI SDK / 兼容客户端：</Text>
        <Text color="gray">baseURL = "{baseUrl}"</Text>
        <Text color="gray">apiKey  = "YOUR_LOCAL_API_TOKEN"</Text>
        <Text color="gray">model   = "{model}"</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text>常见问题：</Text>
        <Text>1. 没有模型：先到 Network 看公网 seller 数量。</Text>
        <Text>2. 余额不足：到 Wallet 充值到 Escrow。</Text>
        <Text>3. 请求超时：先等几秒刷新；仍不行再重启 buyer。</Text>
        <Text>4. 需要日志：~/.clawmarket/logs/buyer.log 和 seller.log。</Text>
      </Box>
    </Box>
  );
}
