import { Box } from 'ink';
import { Text } from '../../../i18n/Text.js';

import { theme } from '../../../theme.js';
import { FocusedSelectInput } from './FocusedSelectInput.js';

export function ConfirmModal({
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  isFocused = true,
}: {
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  isFocused?: boolean;
}) {
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {description ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>{description}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <FocusedSelectInput isFocused={isFocused}
          items={[
            { label: confirmLabel, value: 'confirm' },
            { label: cancelLabel, value: 'cancel' },
          ]}
          onSelect={(item) => {
            if (item.value === 'confirm') {
              onConfirm();
              return;
            }
            onCancel();
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>Enter 确认  Esc 取消</Text>
      </Box>
    </Box>
  );
}
