import { Box, useInput } from 'ink';
import { Text } from '../../i18n/Text.js';

import { theme } from '../../theme.js';

export function ExportView({
  address,
  privateKey,
  onClose,
}: {
  address: string;
  privateKey: string;
  onClose: () => void;
}) {
  useInput((input, key) => {
    if (key.escape || key.return || input.toLowerCase() === 'q') {
      onClose();
    }
  });

  return (
    <Box flexDirection="column">
      <Text color={theme.danger}>不要发给任何人，不要截图上传。</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>地址：{address}</Text>
        <Text>私钥：</Text>
        <Text color={theme.primary}>{privateKey}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>Enter / Q 返回</Text>
      </Box>
    </Box>
  );
}
