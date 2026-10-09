import { Box } from 'ink';
import { Text } from '../../../i18n/Text.js';

import { theme } from '../../../theme.js';
import { FocusedSelectInput } from './FocusedSelectInput.js';

export function QuitModal({
  quitting,
  onCancel,
  onConfirm,
}: {
  quitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (quitting) {
    return (
      <Box flexDirection="column">
        <Text bold>正在退出控制台…</Text>
        <Text color={theme.muted}>正在清理当前 console 会话里启动的 buyer/seller 子进程。</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>退出控制台？</Text>
      <Text color={theme.muted}>只有在这里确认退出时，才会清理这次 console 会话里启动的 buyer/seller 子进程。</Text>
      <Box marginTop={1}>
        <FocusedSelectInput isFocused
          items={[
            { label: '退出', value: 'exit' },
            { label: '取消', value: 'cancel' },
          ]}
          onSelect={(item) => {
            if (item.value === 'exit') {
              onConfirm();
              return;
            }
            onCancel();
          }}
        />
      </Box>
    </Box>
  );
}
