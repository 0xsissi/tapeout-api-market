import { Box } from 'ink';
import { Text } from '../../../i18n/Text.js';

import { theme } from '../../../theme.js';
import type { ConsoleEvent } from '../types.js';

export function EventsBar({
  events,
  limit,
}: {
  events: ConsoleEvent[];
  limit: number;
}) {
  const visible = events.slice(-Math.max(1, limit));

  if (visible.length === 0) {
    return <Text color={theme.muted}>暂无事件。</Text>;
  }

  return (
    <Box flexDirection="column">
      {visible.map((event, index) => (
        <Text key={`${event.time}-${event.scope}-${index}`} wrap="truncate-end">
          <Text color={theme.muted}>{event.time}</Text> {event.scope} {event.message.replace(/\s+/g, ' ')}
        </Text>
      ))}
    </Box>
  );
}
