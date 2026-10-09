import TextInput from 'ink-text-input';
import { Box, useInput } from 'ink';
import { Text, useUiLanguage } from '../../../i18n/Text.js';
import { translateUiText } from '@clawmarket/shared';
import { useState } from 'react';

import { theme } from '../../../theme.js';

interface TextPromptStepProps {
  label: string;
  hint?: string;
  initialValue: string;
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (value: string) => void;
}

export function TextPromptStep({
  label,
  hint,
  initialValue,
  placeholder,
  submitLabel = '按 Enter 提交',
  onSubmit,
}: TextPromptStepProps) {
  const [value, setValue] = useState(initialValue);
  const language = useUiLanguage();

  useInput((input, key) => {
    if (key.return) {
      onSubmit(value);
    }
    if (input === 's' && !value) {
      onSubmit('');
    }
  });

  return (
    <Box flexDirection="column">
      <Text>{label}</Text>
      {hint ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>{hint}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={theme.primary}>{'> '}</Text>
        <TextInput value={value} placeholder={placeholder ? translateUiText(placeholder, language) : undefined} onChange={setValue} onSubmit={onSubmit} />
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>{submitLabel}</Text>
      </Box>
    </Box>
  );
}
