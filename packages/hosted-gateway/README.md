# Tapeout API Market (TAM) Hosted Gateway

Hosted Gateway runs one libp2p buyer node for many agents and exposes HTTPS APIs.
Agents do not run P2P locally. They sign seller-specific authorizations after the
gateway prepares a quote.

## Run

```bash
pnpm hosted-gateway:testnet
```

Common environment variables:

```bash
HOSTED_GATEWAY_PORT=8787
HOSTED_GATEWAY_PUBLIC_URL=https://gateway.tam.example
HOSTED_GATEWAY_RELAYER_PRIVATE_KEY=0x...
ESCROW_POOL_ADDRESS=0x...
RPC_URL=https://sepolia.base.org
CHAIN_ID=84532
BOOTSTRAP_PEERS=/ip4/.../p2p/...
REFRESH_MODELS=gpt-5.4,gpt-5.4-mini
```

## API

- `GET /health`
- `GET /v1/models`
- `POST /v1/claw/prepare`
- `POST /v1/chat/completions`
- `POST /v1/claw/deposit/permit`

The flow is intentionally non-custodial:

1. Agent calls `/v1/claw/prepare` with `{ buyer, request }`.
2. Gateway selects a seller and returns an unsigned bitmap authorization quote.
3. Agent signs the EIP-712 authorization with its own wallet.
4. Agent calls `/v1/chat/completions` with the same request and a Claw execute token.

`/v1/claw/deposit/permit` relays `EscrowPool.depositWithPermit(...)` when
`HOSTED_GATEWAY_RELAYER_PRIVATE_KEY` is configured. The relayer pays gas; the
buyer only signs the token permit.
