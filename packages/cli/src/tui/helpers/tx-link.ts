import { PAYMENT_EXPLORER_URL } from '@clawmarket/shared';

export function formatTxUrl(hash: string): string {
  return `${PAYMENT_EXPLORER_URL}/tx/${hash}`;
}

export function formatTxLink(hash: string, label = '[点击查看]'): string {
  const url = formatTxUrl(hash);
  return supportsOsc8Hyperlinks() ? `${url}  ${osc8(url, label)}` : url;
}

function supportsOsc8Hyperlinks(): boolean {
  if (process.env.CLAW_DISABLE_OSC8 === '1' || process.env.TERM === 'dumb') {
    return false;
  }

  return Boolean(
    process.env.WEZTERM_PANE
      || process.env.KITTY_WINDOW_ID
      || process.env.ITERM_SESSION_ID
      || process.env.TERM_PROGRAM === 'iTerm.app'
      || process.env.TERM_PROGRAM === 'WezTerm',
  );
}

function osc8(url: string, label: string): string {
  return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
}
