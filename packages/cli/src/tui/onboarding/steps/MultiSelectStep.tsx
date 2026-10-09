import { Box, useInput } from 'ink';
import { Text } from '../../../i18n/Text.js';
import { useState } from 'react';

import { theme } from '../../../theme.js';

export function MultiSelectStep({
  options,
  initialSelected,
  onSubmit,
}: {
  options: string[];
  initialSelected: string[];
  onSubmit: (selected: string[]) => void;
}) {
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(() => new Set(initialSelected.filter((item) => options.includes(item))));
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((current) => Math.min(options.length - 1, current + 1));
      return;
    }
    if (input === ' ') {
      const value = options[cursor];
      if (!value) {
        return;
      }
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(value)) {
          next.delete(value);
        } else {
          next.add(value);
        }
        return next;
      });
      setError(null);
      return;
    }
    if (key.return) {
      const values = options.filter((option) => selected.has(option));
      if (values.length === 0) {
        setError('至少选择 1 个模型。');
        return;
      }
      onSubmit(values);
    }
  });

  return (
    <Box flexDirection="column">
      {options.map((option, index) => {
        const checked = selected.has(option);
        const active = index === cursor;
        return (
          <Text key={option} color={active ? theme.primary : undefined}>
            {active ? '>' : ' '} [{checked ? 'x' : ' '}] {option}
          </Text>
        );
      })}
      {error ? (
        <Box marginTop={1}>
          <Text color={theme.danger}>{error}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={theme.muted}>↑↓ 移动  空格 切换  Enter 确认</Text>
      </Box>
    </Box>
  );
}
