declare module 'qrcode-terminal' {
  export function generate(
    input: string,
    opts: { small?: boolean },
    cb: (code: string) => void,
  ): void;
}
