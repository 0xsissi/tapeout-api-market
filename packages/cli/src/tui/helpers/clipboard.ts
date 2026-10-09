import { spawn } from 'node:child_process';

export async function copyToClipboard(value: string): Promise<boolean> {
  const command = process.platform === 'darwin'
    ? 'pbcopy'
    : process.platform === 'win32'
      ? 'clip.exe'
      : process.env.WAYLAND_DISPLAY
        ? 'wl-copy'
        : 'xclip';
  const args = process.platform === 'linux' && command === 'xclip' ? ['-selection', 'clipboard'] : [];

  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
    child.stdin.on('error', () => resolve(false));
    child.stdin.end(value);
  });
}
