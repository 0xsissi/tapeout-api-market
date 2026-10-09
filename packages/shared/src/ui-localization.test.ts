import { describe, expect, it } from 'vitest';
import dictionary from './locales/en.json' with { type: 'json' };
import { createUiTranslator } from './ui-translation.js';
import { translateUiText as t } from './ui-localization.js';

describe('interface translations', () => {
  it('preserves Chinese, unknown data and surrounding whitespace', () => {
    expect(t('余额与充值', 'zh')).toBe('余额与充值');
    expect(t('  余额与充值\n', 'en')).toBe('  Wallet & funds\n');
    for (const value of ['', ' ', 'gpt-6-luna', '0x1234', '用户自己的内容：保留原文']) expect(t(value, 'en')).toBe(value);
  });
  it('substitutes template slots and known nested UI fragments', () => {
    const translator = createUiTranslator({ '价格：{0} {1}': 'Price: {0} {1}', '连接：{0}': 'Connection: {0}', '已启动': 'Running' });
    expect(translator('价格：0.02 USDC', 'en')).toBe('Price: 0.02 USDC');
    expect(translator('价格：0.02 BEM', 'en')).toBe('Price: 0.02 BEM');
    expect(translator('连接：已启动', 'en')).toBe('Connection: Running');
    expect(translator('连接：我的模型名字', 'en')).toBe('Connection: 我的模型名字');
    expect(t('无法连接 buyer gateway（127.0.0.1:9087）：服务还没启动，或者刚刚已经退出。', 'en')).toBe('Cannot connect to buyer gateway (127.0.0.1:9087): The service has not started, or has just exited.');
  });
  it('keeps every interpolation slot and has no Chinese in English translations', () => {
    for (const [source, target] of Object.entries(dictionary)) {
      expect(typeof target, source).toBe('string');
      expect(target, source).not.toMatch(/[\u3400-\u9fff]/);
      expect([...target.matchAll(/\{\d+\}/g)].map(m => m[0]).sort(), source).toEqual([...source.matchAll(/\{\d+\}/g)].map(m => m[0]).sort());
    }
  });
  it('does not mutate a dictionary when adding currency variants', () => {
    const dict = Object.freeze({ '余额 USDC，Gas ETH': 'Balance USDC, Gas ETH' });
    const translator = createUiTranslator(dict);
    expect(translator('余额 BEM，Gas tBNB', 'en')).toBe('Balance BEM, Gas tBNB');
    expect(Object.keys(dict)).toHaveLength(1);
  });
});
