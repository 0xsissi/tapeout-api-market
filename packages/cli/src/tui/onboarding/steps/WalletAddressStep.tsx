import SelectInput from '../../../i18n/SelectInput.js';
import { Box, useInput } from 'ink';
import { Text } from '../../../i18n/Text.js';
import { useState } from 'react';

import { theme } from '../../../theme.js';
import { QrCode } from '../../components/QrCode.js';
import { copyToClipboard } from '../../helpers/clipboard.js';
import { PAYMENT_NETWORK_NAME } from '@clawmarket/shared';

export function WalletAddressStep({
  address,
  description,
  continueLabel,
  onContinue,
}: {
  address: string;
  description: string;
  continueLabel: string;
  onContinue: () => void;
}) {
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  useInput((input) => {
    if (input.toLowerCase() !== 'c') {
      return;
    }

    void copyToClipboard(address).then((copied) => {
      setCopyMessage(copied ? '已复制到剪贴板。' : '复制失败，请手动复制上面的地址。');
    });
  });

  return (
    <Box flexDirection="column">
      <Text>钱包地址：{PAYMENT_NETWORK_NAME}</Text>
      <Text color={theme.primary}>  {address}</Text>
      <Box marginTop={1}>
        <QrCode value={address} />
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>{description}</Text>
      </Box>
      {copyMessage ? (
        <Box marginTop={1}>
          <Text color={copyMessage.startsWith('已复制') ? theme.primary : theme.accent}>{copyMessage}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={theme.muted}>按 c 复制地址。</Text>
      </Box>
      <Box marginTop={1}>
        <SelectInput items={[{ label: continueLabel, value: 'next' }]} onSelect={onContinue} />
      </Box>
    </Box>
  );
}
