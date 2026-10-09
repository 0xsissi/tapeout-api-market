import { describe, expect, it } from 'vitest';

import { consoleNavItems, filterConsoleCommands, hasHealthyP2p, isCompactConsole } from './lib.js';

describe('console helpers', () => {
  it('keeps primary nav views in order', () => {
    expect(consoleNavItems.map((item) => item.id)).toEqual([
      'dashboard',
      'wallet',
      'chat',
      'network',
      'usage',
      'seller',
      'accounts',
      'claims',
      'agent',
      'settings',
    ]);
  });

  it('detects compact mode for narrow terminals', () => {
    expect(isCompactConsole(79)).toBe(true);
    expect(isCompactConsole(80)).toBe(false);
  });

  it('filters commands by label and keywords', () => {
    const commands = [
      { id: 'purchase', label: 'Purchase credits', keywords: ['buyer', 'deposit'] },
      { id: 'flush', label: 'Flush claims', keywords: ['seller', 'claim'] },
      { id: 'login', label: 'Login Codex', keywords: ['seller', 'auth'] },
    ];

    expect(filterConsoleCommands(commands, 'claim')[0]?.id).toBe('flush');
    expect(filterConsoleCommands(commands, 'deposit')[0]?.id).toBe('purchase');
    expect(filterConsoleCommands(commands, 'login')[0]?.id).toBe('login');
  });

  it('treats reachable local seller as healthy p2p even without selected provider', () => {
    expect(hasHealthyP2p({
      networkSummary: null,
      selectedModel: 'gpt-5.4',
      sellerSummary: {
        reachability: {
          status: 'relay',
        },
      } as never,
    })).toBe(true);
  });

  it('finds a Chinese-source command using its displayed English label without changing its ID', () => {
    const commands = [{ id: 'wallet', label: '余额与充值', keywords: [] }];
    expect(filterConsoleCommands(commands, 'wallet')[0]).toBe(commands[0]);
    expect(filterConsoleCommands(commands, '余额')[0]).toBe(commands[0]);
  });
});
