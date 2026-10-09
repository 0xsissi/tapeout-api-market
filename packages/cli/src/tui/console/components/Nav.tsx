import { Box } from 'ink';
import { Text } from '../../../i18n/Text.js';

import { theme } from '../../../theme.js';
import type { ConsoleViewId } from '../lib.js';

export function Nav({
  items,
  currentView,
  compact,
  isFocused,
}: {
  items: Array<{ id: ConsoleViewId; label: string }>;
  currentView: ConsoleViewId;
  compact: boolean;
  isFocused: boolean;
}) {
  if (compact) {
    const index = items.findIndex(item => item.id === currentView);
    return (
      <Text color={theme.primary} wrap="truncate-end">{isFocused ? '▶' : '›'} {index + 1}/{items.length} {items[index]?.label} · Tab 切换菜单</Text>
    );
  }

  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <Text key={item.id} color={item.id === currentView ? theme.primary : undefined} wrap="truncate-end">
          {item.id === currentView ? (isFocused ? '▶ ' : '› ') : '  '}
          {item.label}
        </Text>
      ))}
    </Box>
  );
}
