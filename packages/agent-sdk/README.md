# Tapeout API Market (TAM) Agent SDK

TypeScript and Python clients for the Hosted Gateway.

Use `TAM` or `TapeoutAPIMarket` as the client name. The package import paths and the legacy `ClawMarket` client remain compatible; see [naming and compatibility](../../docs/branding.md).

## TypeScript

```ts
import { TAM } from '@clawmarket/agent-sdk';

const client = new TAM({
  baseURL: 'https://gateway.tam.example',
  apiKey: process.env.BUYER_PRIVATE_KEY as `0x${string}`,
  escrowPoolAddress: '0x...',
  rpcUrl: 'https://sepolia.base.org',
  chainId: 84532,
});

const completion = await client.chat.completions.create({
  model: 'gpt-5.4',
  messages: [{ role: 'user', content: 'hello' }],
});
```

Gasless first deposit through the hosted relayer:

```ts
await client.depositWithPermit({
  tokenAddress: '0x...',
  amount: '5.0',
  tokenName: 'USD Coin',
});
```

## Python

```python
from clawmarket_agent_sdk import TAM

client = TAM(
    base_url="https://gateway.tam.example",
    api_key="0x...",
    escrow_pool_address="0x...",
    chain_id=84532,
)

completion = client.chat.completions.create(
    model="gpt-5.4",
    messages=[{"role": "user", "content": "hello"}],
)
```

The SDK signs the Hosted Gateway authorization locally. The gateway never
receives the buyer private key.

## Future model provenance verification

The TypeScript client accepts `modelProvenance` (`off`, `optional`, or `required`)
and `modelProvenanceVerifier`. Required verification runs locally before signing
the collectible delivery payment. Missing or rejected evidence prevents settlement;
required mode without an installed verifier prevents client construction.
There is no built-in zkTLS verifier, and the default remains unverified.
Python integrations retain the existing trust model. See [adapter interfaces and
integration requirements](../../docs/model-provenance-zktls.md).
