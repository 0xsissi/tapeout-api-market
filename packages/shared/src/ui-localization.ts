import dictionary from './locales/en.json' with { type: 'json' };
import { createUiTranslator } from './ui-translation.js';

export const translateUiText = createUiTranslator(dictionary);
export { createUiTranslator, type UiDictionary, type UiLanguage } from './ui-translation.js';
