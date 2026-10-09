import { Box } from 'ink';
import { Text } from '../../i18n/Text.js';
import TextInput from 'ink-text-input';
import { useState } from 'react';

import { theme } from '../../theme.js';
import { useScrollTarget } from '../console/components/ScrollViewport.js';

export function ImportView({
  currentAddress,
  onSubmit,
}: {
  currentAddress?: string | null;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useScrollTarget(true, value);

  const submit = (next: string) => {
    const normalized = next.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
      setError('私钥格式不对，必须是 0x 开头、长度 66 的十六进制字符串。');
      return;
    }
    setError(null);
    onSubmit(normalized);
  };

  return (
    <Box flexDirection="column">
      <Text color={theme.danger}>导入会覆盖当前钱包，并先备份为 wallet.json.bak。</Text>
      {currentAddress ? (
        <Box marginTop={1}>
          <Text>当前地址：{currentAddress}</Text>
        </Box>
      ) : null}
      <Box ref={inputRef} marginTop={1}>
        <Text color={theme.primary}>{'> '}</Text>
        <TextInput
          focus
          value={value}
          placeholder="0x..."
          onChange={(next) => {
            setValue(next);
            if (error) {
              setError(null);
            }
          }}
          onSubmit={submit}
        />
      </Box>
      {error ? (
        <Box marginTop={1}>
          <Text color={theme.danger}>{error}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={theme.muted}>Enter 导入  Esc 取消</Text>
      </Box>
    </Box>
  );
}
