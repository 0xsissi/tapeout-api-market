import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';

import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setUiLanguage } from '../../i18n/language.js';

import { getCliDefaults } from '../../config/store.js';

vi.mock('../../runtime/seller-runtime.js', async () => {
  const actual = await vi.importActual<typeof import('../../runtime/seller-runtime.js')>('../../runtime/seller-runtime.js');
  return {
    ...actual,
    startSellerRuntime: vi.fn(async (options: { report?: (line: string) => void }) => {
      options.report?.('Starting local seller...');
      options.report?.('Seller is ready at http://127.0.0.1:8787.');
    }),
  };
});

import { startSellerRuntime } from '../../runtime/seller-runtime.js';
import { OnboardingApp } from './index.js';

describe('OnboardingApp seller start action', () => {
  beforeEach(() => setUiLanguage('zh'));
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('transitions seller_start from running to success instead of staying stuck on spinner', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-onboarding-'));
    const config = getCliDefaults({ homeDir: root, cwd: '/fixture/clawmarket-v2/packages/cli' });
    await mkdir(config.seller.cliproxyAuthDir, { recursive: true });
    await writeFile(path.join(config.seller.cliproxyAuthDir, 'codex-user@example.com-plus.json'), '{"type":"codex"}\n', 'utf8');

    const app = render(
      <OnboardingApp
        config={config}
        buyerUrl={config.buyer.url}
        sellerUrl={config.seller.url}
        forcedRole="seller"
        resumeState={{
          stepIndex: 9,
          modelOptions: [],
          modelError: null,
          actionState: { stepId: null, status: 'idle', lines: [] },
          state: {
            role: 'seller',
            selectedModel: config.buyer.selectedModel,
            purchaseAmount: '',
            inputPrice: String(config.seller.pricing.input),
            outputPrice: String(config.seller.pricing.output),
            maxConcurrentValue: String(config.seller.pricing.maxConcurrent ?? 5),
            buyerWalletPath: path.join(root, 'wallet.json'),
            sellerWalletPath: config.seller.walletPath,
            sellerAddress: null,
            sellerWalletExists: true,
            sellerUpstream: 'codex',
            sellerLoginMode: 'browser',
            sellerModels: ['gpt-5.4'],
            sellerModelOptions: ['gpt-5.4'],
            completionSaved: false,
          },
        }}
      />,
    );

    await vi.waitFor(() => {
      expect(startSellerRuntime).toHaveBeenCalledTimes(1);
      expect(app.lastFrame()).toContain('完成。按 Enter 继续。');
      expect(app.lastFrame()).toContain('Seller is ready at http://127.0.0.1:8787.');
    });

    app.unmount();
  });
});
