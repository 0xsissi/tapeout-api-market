# Mock Seller Platform

Lightweight local mock sellers and scenario runner for scheduler validation.

## Commands

Build:

```bash
corepack pnpm --filter @clawmarket/mock-seller build
```

Start a cluster:

```bash
corepack pnpm --filter @clawmarket/mock-seller cluster -- --count 20 --preset mixed
```

Run a scenario:

```bash
corepack pnpm --filter @clawmarket/mock-seller scenario-runner baseline
corepack pnpm --filter @clawmarket/mock-seller scenario-runner seller-failover
corepack pnpm --filter @clawmarket/mock-seller scenario-runner session-stickiness
```

Notes:

- Default scenario sizes are tuned for local development and CI stability.
- You can scale them up with `MOCK_SCENARIO_SELLERS`, `MOCK_SCENARIO_DURATION_MS`, and `MOCK_SCENARIO_CONCURRENCY`.
- Use `MOCK_SCENARIO_BASE_PORT` to pin ports, or let the runner choose an isolated port block automatically.

Implemented scenarios:

- `baseline`
- `seller-failover`
- `load-spike`
- `session-stickiness`
- `dht-stale`
