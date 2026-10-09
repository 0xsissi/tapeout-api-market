import { Box } from 'ink';
import { Text } from '../../../i18n/Text.js';
import TextInput from 'ink-text-input';

import { theme } from '../../../theme.js';
import type { ConsoleCommand } from '../lib.js';
import { useScrollTarget } from './ScrollViewport.js';

export function CommandPalette({
  query,
  commands,
  selectedIndex,
  onChange,
  onRun,
}: {
  query: string;
  commands: ConsoleCommand[];
  selectedIndex: number;
  onChange: (value: string) => void;
  onRun: (commandId: string) => Promise<void>;
}) {
  const inputRef = useScrollTarget(selectedIndex === 0, query);
  return (
    <Box flexDirection="column">
      <Text bold>Command Palette</Text>
      <Box ref={inputRef} marginTop={1}>
        <Text color={theme.primary}>{'/ '}</Text>
        <TextInput
          focus
          value={query}
          placeholder="search commands"
          onChange={onChange}
          onSubmit={async () => {
            const selected = commands[selectedIndex] ?? commands[0];
            if (selected) {
              await onRun(selected.id);
            }
          }}
        />
      </Box>
      <Box marginTop={1} flexDirection="column">
        {commands.length > 0 ? commands.map((command, index) => (
          <CommandRow key={command.id} command={command} index={index} selected={index === selectedIndex} />
        )) : (
          <Text color={theme.muted}>没有匹配命令。</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>↑↓ 选择  Enter 执行  1-8 快捷执行  Esc 关闭</Text>
      </Box>
    </Box>
  );
}

function CommandRow({ command, index, selected }: { command: ConsoleCommand; index: number; selected: boolean }) {
  const ref = useScrollTarget(selected);
  return <Box ref={ref}><Text color={selected ? theme.primary : undefined}>{selected ? '› ' : '  '}{index + 1}. {command.label}</Text></Box>;
}
