import qr from 'qrcode-terminal';
import {  } from 'ink';
import { Text } from '../../i18n/Text.js';
import { useMemo } from 'react';

export function QrCode({ value, small = true }: { value: string; small?: boolean }) {
  const art = useMemo(() => {
    let out = '';
    qr.generate(value, { small }, (code) => {
      out = code;
    });
    return out.replace(/\n$/, '');
  }, [small, value]);

  return <Text>{art}</Text>;
}
