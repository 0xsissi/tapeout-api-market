import SelectInput from '../../../i18n/SelectInput.js';
import TextInput from 'ink-text-input';
import { Box } from 'ink';
import { Text } from '../../../i18n/Text.js';
import { useState } from 'react';

import { theme } from '../../../theme.js';

type SellerWalletChoice = 'reuse' | 'generate' | 'paste';

interface SellerWalletStepProps {
  walletPath: string;
  walletExists: boolean;
  onReuse: () => void;
  onGenerate: () => void;
  onPaste: (privateKey: string) => void;
}

export function SellerWalletStep({
  walletPath,
  walletExists,
  onReuse,
  onGenerate,
  onPaste,
}: SellerWalletStepProps) {
  const [mode, setMode] = useState<SellerWalletChoice | null>(null);
  const [privateKey, setPrivateKey] = useState('');

  if (mode === 'paste') {
    return (
      <Box flexDirection="column">
        <Text>贴入一个 `0x...` 格式的私钥后按 Enter。</Text>
        <Box marginTop={1}>
          <Text color={theme.primary}>{'> '}</Text>
          <TextInput value={privateKey} onChange={setPrivateKey} onSubmit={onPaste} />
        </Box>
        <Box marginTop={1}>
          <Text color={theme.muted}>Esc 返回上一页。</Text>
        </Box>
      </Box>
    );
  }

  const items: Array<{ label: string; value: SellerWalletChoice }> = [
    ...(walletExists ? [{ label: `复用现有钱包 (${walletPath})`, value: 'reuse' as const }] : []),
    { label: `生成新钱包并保存到 ${walletPath}`, value: 'generate' },
    { label: '手动粘贴一个私钥', value: 'paste' },
  ];

  return (
    <Box flexDirection="column">
      <Text color={theme.muted}>
        {walletExists ? '检测到现有卖家钱包。' : '还没有检测到卖家钱包，建议现在生成一个。'}
      </Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === 'reuse') {
              onReuse();
              return;
            }
            if (item.value === 'generate') {
              onGenerate();
              return;
            }
            setMode('paste');
          }}
        />
      </Box>
    </Box>
  );
}
