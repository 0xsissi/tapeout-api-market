import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

vi.mock('qrcode-terminal', () => ({
  default: {
    generate: vi.fn((_value: string, _options: { small?: boolean }, cb: (code: string) => void) => {
      cb('qr-art\n');
    }),
  },
}));

describe('QrCode', () => {
  it('renders generated qr art', async () => {
    const { QrCode } = await import('./QrCode.js');

    const view = render(<QrCode value="0xabc" />);

    expect(view.lastFrame()).toContain('qr-art');
  });
});
