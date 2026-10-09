import { Box } from 'ink';
import { Text, useUiLanguage } from '../../../i18n/Text.js';
import { translateUiText } from '@clawmarket/shared';
import TextInput from 'ink-text-input';
import { useState } from 'react';

import { theme } from '../../../theme.js';
import { useScrollTarget } from './ScrollViewport.js';

export function PromptModal({
  title,
  description,
  placeholder,
  initialValue,
  onSubmit,
}: {
  title: string;
  description?: string;
  placeholder?: string;
  initialValue: string;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const language = useUiLanguage();
  const inputRef = useScrollTarget(true, value);

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {description ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>{description}</Text>
        </Box>
      ) : null}
      <Box ref={inputRef} marginTop={1}>
        <Text color={theme.primary}>{'> '}</Text>
        <TextInput focus value={value} placeholder={placeholder ? translateUiText(placeholder, language) : undefined} onChange={setValue} onSubmit={onSubmit} />
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>Enter 提交  Esc 取消</Text>
      </Box>
    </Box>
  );
}
