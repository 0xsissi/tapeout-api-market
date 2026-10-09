// Current TAM pilot: select its independent BSC test profile before runtime imports.
const network = process.env.CLAWMARKET_PAYMENT_NETWORK;
if (network && network !== 'bsc-testnet') throw new Error('当前 TAM 内测只使用 BSC 测试网。请清除其他网络覆盖，使用 bsc-testnet。');
if (process.env.CHAIN_ID && Number(process.env.CHAIN_ID) !== 97) throw new Error('当前 TAM 内测的 CHAIN_ID 必须为 97。');
process.env.CLAWMARKET_PAYMENT_NETWORK = 'bsc-testnet';
if (process.env.CLAWMARKET_AUTH_NONCE_MODE && process.env.CLAWMARKET_AUTH_NONCE_MODE !== 'bitmap') throw new Error('当前 BSC 交付确认结算需要 bitmap 授权模式。');
process.env.CLAWMARKET_AUTH_NONCE_MODE = 'bitmap';
