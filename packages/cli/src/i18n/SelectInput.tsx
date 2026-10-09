import SelectInput from 'ink-select-input';
import { translateUiText } from '@clawmarket/shared';
import { useUiLanguage } from './Text.js';

export default function LocalizedSelectInput<V>(props: Parameters<typeof SelectInput<V>>[0]) {
  const language = useUiLanguage();
  return <SelectInput {...props} items={props.items?.map((item, index) => ({ ...item, key: item.key ?? `${index}:${item.label}`, label: translateUiText(item.label, language) }))} />;
}
