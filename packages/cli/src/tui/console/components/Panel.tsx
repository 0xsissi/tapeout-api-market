import { Box } from 'ink';
import { Text } from '../../../i18n/Text.js';

import { theme } from '../../../theme.js';

export function Panel({
  title,
  children,
  width,
  flexGrow,
  height,
}: {
  title: string;
  children: React.ReactNode;
  width?: number;
  flexGrow?: number;
  height?: number;
}) {
  return (
    <Box borderStyle="single" borderColor={theme.primary} paddingX={1} paddingY={0} width={width} height={height} flexGrow={flexGrow} flexBasis={flexGrow ? 0 : undefined} flexShrink={width == null ? 1 : 0} minWidth={0} overflow="hidden">
      <Box flexDirection="column" width="100%" minWidth={0}>
        <Text color={theme.primary} wrap="truncate-end">{title}</Text>
        <Box flexDirection="column" flexShrink={0}>{children}</Box>
      </Box>
    </Box>
  );
}
