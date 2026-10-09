import { Box } from 'ink';
import { Text } from '../../../i18n/Text.js';

import { theme } from '../../../theme.js';

export function HelpModal() {
  return (
    <Box flexDirection="column">
      <Text bold>快捷键</Text>
      <Text>Tab / Shift-Tab: 切换视图</Text>
      <Text>左侧焦点: ↑↓ 切换视图，Enter 或 → 进入右侧</Text>
      <Text>右侧焦点: ↑↓ 选择操作，Esc 或 ← 返回左侧</Text>
      <Text>PgUp / PgDn: 右侧内容翻页，不移动菜单和底栏</Text>
      <Text>L : 切换并保存界面语言</Text>
      <Text>/ : 打开命令面板</Text>
      <Text>? : 查看帮助</Text>
      <Text>q : 退出确认</Text>
      <Box marginTop={1}>
        <Text color={theme.muted}>按 Enter、Esc 或 ? 关闭。</Text>
      </Box>
    </Box>
  );
}
