import SelectInput from '../../../i18n/SelectInput.js';
import { Box } from 'ink';
import { Text } from '../../../i18n/Text.js';

import type { ClawMarketRole } from '../../../config/schema.js';
import { theme } from '../../../theme.js';

interface RoleStepProps {
  onSelect: (role: ClawMarketRole) => void;
}

const items: Array<{ label: string; value: ClawMarketRole }> = [
  { label: '买家: 购买并使用 API', value: 'buyer' },
  { label: '卖家: 出售本机 Codex 额度', value: 'seller' },
  { label: '两者都要: 同时配置 buyer + seller', value: 'both' },
];

export function RoleStep({ onSelect }: RoleStepProps) {
  return (
    <Box flexDirection="column">
      <Text color={theme.muted}>上下键选择，回车继续。</Text>
      <Box marginTop={1}>
        <SelectInput items={items} onSelect={(item) => onSelect(item.value)} />
      </Box>
    </Box>
  );
}
