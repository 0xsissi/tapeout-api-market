import SelectInput from '../../../i18n/SelectInput.js';
import Spinner from 'ink-spinner';
import { Box } from 'ink';
import { Text } from '../../../i18n/Text.js';

import { theme } from '../../../theme.js';

interface ActionStepProps {
  status: 'idle' | 'running' | 'success' | 'error';
  description: string;
  lines: string[];
  error?: string;
  actionLabel?: string;
  onAction: () => void;
  showAbortConfirm?: boolean;
  onAbortConfirm?: () => void;
  onAbortCancel?: () => void;
}

export function ActionStep({
  status,
  description,
  lines,
  error,
  actionLabel = '继续',
  onAction,
  showAbortConfirm = false,
  onAbortConfirm,
  onAbortCancel,
}: ActionStepProps) {
  return (
    <Box flexDirection="column">
      <Text>{description}</Text>
      <Box marginTop={1} flexDirection="column">
        {lines.map((line, index) => (
          <Text key={`${index}-${line}`} color={theme.muted}>
            {line}
          </Text>
        ))}
      </Box>
      {status === 'running' ? (
        showAbortConfirm ? (
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.accent}>放弃当前步骤？</Text>
            <Box marginTop={1}>
              <SelectInput
                items={[
                  { label: '放弃并返回上一步', value: 'abort' },
                  { label: '继续等待', value: 'resume' },
                ]}
                onSelect={(item) => {
                  if (item.value === 'abort') {
                    onAbortConfirm?.();
                    return;
                  }
                  onAbortCancel?.();
                }}
              />
            </Box>
          </Box>
        ) : (
          <Box marginTop={1}>
            <Text color={theme.accent}>
              <Spinner type="dots" /> 正在处理，请稍候…
            </Text>
          </Box>
        )
      ) : null}
      {status === 'error' && error ? (
        <Box marginTop={1}>
          <Text color={theme.danger}>错误: {error}</Text>
        </Box>
      ) : null}
      {status === 'success' ? (
        <Box marginTop={1}>
          <Text color={theme.primary}>完成。按 Enter 继续。</Text>
        </Box>
      ) : null}
      {(status === 'success' || status === 'error') ? (
        <Box marginTop={1}>
          <SelectInput items={[{ label: actionLabel, value: 'next' }]} onSelect={() => onAction()} />
        </Box>
      ) : null}
    </Box>
  );
}
