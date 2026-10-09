import { Text as InkText, type TextProps } from 'ink';
import { Children, useSyncExternalStore } from 'react';
import { translateUiText } from '@clawmarket/shared';
import { getUiLanguage, subscribeUiLanguage } from './language.js';

export function useUiLanguage() { return useSyncExternalStore(subscribeUiLanguage, getUiLanguage, getUiLanguage); }
export const RawText = InkText;
export { getUiLocale } from './language.js';
export function Text({ children, ...props }: TextProps) {
  const language = useUiLanguage();
  return <InkText {...props}>{Children.map(children, child => typeof child === 'string' ? translateUiText(child, language) : child)}</InkText>;
}
