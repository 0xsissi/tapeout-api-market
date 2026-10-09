import { Box } from 'ink';
import { Text } from '../../../i18n/Text.js';
import SelectInput, { type IndicatorProps } from 'ink-select-input';
import { createContext, useContext } from 'react';

import { theme } from '../../../theme.js';
import { useScrollTarget } from './ScrollViewport.js';
import { translateUiText } from '@clawmarket/shared';
import { useUiLanguage } from '../../../i18n/Text.js';

const SelectFocusContext = createContext(false);

type SelectItem<V> = {
  key?: string;
  label: string;
  value: V;
};

export function FocusedSelectInput<V>({
  isFocused,
  items,
  onSelect,
  limit,
  initialIndex,
}: {
  isFocused: boolean;
  items: Array<SelectItem<V>>;
  onSelect?: (item: SelectItem<V>) => void;
  limit?: number;
  initialIndex?: number;
}) {
  const language = useUiLanguage();
  const normalizedItems = items.map((item, index) => ({
    ...item,
    // ink-select-input falls back to non-unique object stringification when
    // `value` is an object, so always provide a stable explicit key.
    key: item.key ?? `${index}:${item.label}`,
    label: translateUiText(item.label, language),
  }));
  return (
    <SelectFocusContext.Provider value={isFocused}>
      <SelectInput
        isFocused={isFocused}
        items={normalizedItems}
        limit={limit}
        initialIndex={initialIndex}
        indicatorComponent={FocusIndicator}
        onSelect={onSelect}
      />
    </SelectFocusContext.Provider>
  );
}

function FocusIndicator({ isSelected = false }: IndicatorProps) {
  const isFocused = useContext(SelectFocusContext);
  const ref = useScrollTarget(isSelected && isFocused);
  return (
    <Box ref={ref} marginRight={1}>
      <Text color={isSelected ? theme.primary : undefined}>
        {isSelected ? (isFocused ? '▶' : '›') : ' '}
      </Text>
    </Box>
  );
}
