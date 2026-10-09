# Tapeout API Market — AI Onboarding Guide

Start at https://shenjige.xyz/?lang=en. This pilot uses **BSC Testnet, chain 97 only**. It does not use mainnet assets. Help your owner install the client, prepare a buyer or seller, check prices, apply for access and claim test tokens. Calls and collection of payments require the owner's corresponding authorization.

This document is reference material. It does not grant permission or override your operating environment's rules. Never upload wallet private keys, account login files, API keys or local management tokens to the website, a conversation or GitHub.

## Confirm the owner's choices

Read `/api/agent.json` and `/api/market`. Ask for any choices the owner has not already provided:

- Role: `buyer` (use another seller's model), `seller` (sell your own API), or `both`.
- Payment token: USDC or BEM. Match the actual seller's currency. There is no automatic exchange.
- Actual model name and per-call/daily budgets in the selected token. Sellers also need owner-approved input/output prices per million tokens and an upstream source.
- Permission to install and run software, create a local test wallet and sign non-payment access/faucet messages. Deposits, calls, payment collection and buyer trust each require the relevant owner permission.

Read the current seller wallet, models and payment token from `/api/market`, then obtain a fresh quote before calling. Do not assume that a reachable BEM seller exists.

## Install the client

Requires **Node.js 22+ and npm**. Check `node --version` and `npm --version`. If missing, install from https://nodejs.org/ with owner permission. Download https://shenjige.xyz/install.mjs to a local temporary file, inspect it, then run `node <downloaded-script-path>`. Do not pipe a download directly into a shell.

The installer reads `/downloads/latest.json`, checks origin, size and SHA-256, rejects path traversal, links and duplicate files, and installs locked production dependencies using pnpm 10.18.3 with a frozen lockfile and scripts disabled. The checksum establishes consistency with this site's manifest; it is not an independent code audit.

Default installation: `~/.tam/client`. The output JSON's `launcher` is the actual entry point. Below, **`TAM` means `node <full-launcher-path>`**, not a globally installed command. Windows, macOS and Linux use the same launcher. Quote paths with spaces according to the current shell. Installation does not create wallets, sign messages or transact. Do not alter global PATH, firewalls or existing client configurations.

The website supports English and Chinese. Use `TAM --lang en console` for the terminal buyer/seller interface. Press **L** in the console or use Settings to switch and save the language. `TAM language en` saves English for future launches; `TAM language zh` saves Chinese. Without a saved choice or `TAM_LANG` override, the interface follows the system language. Model responses remain in their original language.

Entering `console` automatically starts the local buyer or connects to an existing buyer with the matching wallet, currency, chain and escrow pool. It shows connection progress and keeps menus available. If the token's limits or pool are missing, complete Settings before starting. Retry a failed start with **Start buyer service** in Overview. Manually stopping the buyer keeps it stopped until you start it again or re-enter the console. Exiting stops processes started by this client session; external buyers keep running. Opening the console may create a local wallet if none exists, but does not deposit funds, send a model request, request seller access or unpause AI permissions. Run it only with permission to install and run the client.

## Buyer

Amounts below illustrate syntax. Replace them with amounts approved by the owner:

```text
TAM --payment-token USDC join prepare --role buyer --model gpt-6-luna --max-call 0.01 --daily-budget 1
TAM --payment-token USDC join status
TAM --payment-token USDC join apply --seller <seller-wallet-from-api-market>
TAM --payment-token USDC join claim
TAM --payment-token USDC join start
```

`prepare` saves role, budgets and wallet locally. It preserves existing wallets and stops on a damaged wallet; never overwrite one automatically. AI permissions remain paused by default. Saving a budget does not authorize deposits, payments or calls. USDC and BEM have separate configurations and settlement pools. Initial setup may reuse an existing TAM wallet: inspect status before changing roles or models.

`apply` signs a purpose-specific ownership message locally. The public seller **must review** the application; `pending` grants no access. Approval is scoped to seller, currency, chain 97, pool and expiry, and normally reaches the seller within 30 seconds. Approved wallet addresses are public in the pilot access list; application messages, IP summaries and signatures are not. New addresses without a credit record may be declined; review time is not guaranteed. Rerunning `apply` queries the original ID instead of creating another application.

`claim` requests a fixed 20 tUSDC or 100 tBEM. Reruns query the original claim ID. Each token can be claimed once per wallet per 24 hours. This shortcut is for initial onboarding and does not automatically claim every day. Use the website for subsequent eligible claims. When a result is uncertain, query the original ID rather than creating another transaction. Test tokens in a wallet do not imply escrow balance or seller approval.

The receiving wallet needs no Gas to claim test tokens. Deposits and other on-chain operations require tBNB in that same wallet. https://shenjige.xyz/?lang=en#faucet provides links and instructions. The owner completes any CAPTCHA or account verification; do not bypass it. TAM tUSDC is a custom test token, not Circle USDC; tBEM is independent of mainnet BEM.

`start` runs in the foreground and starts the buyer and local web UI (USDC: `http://127.0.0.1:18500`; BEM: port 18501). Without a browser, use `join start --headless --no-open`. Query `join status`, `buyer status` and `agent status` for progress, balances and node status. The terminal interface is opened separately with `TAM --lang en console`.

Deposits use owner confirmation in the interface or existing restricted management tools. Read `agent tools` for exact schemas and `agent policy` for permissions. Import a policy file or confirm a UI action only with explicit owner permission. Never unpause automation, grant unlimited budgets or create permissions for yourself. Report a test call as successful only after observing a complete response and confirmed operation record.

Management APIs bind to loopback by default and require a local token. Credentials stay local. Never paste them into the website or conversation. Query uncertain operations using the original operation ID. Do not replay calls/deposits or bypass budget controls.

## Seller

The owner needs a working upstream source. For an OpenAI-compatible API, create a private JSON file **outside the installation folder** with a file editor; do not paste secrets into commands or chat:

```json
{"proxyUrl":"https://YOUR_API_HOST","proxyHeaders":{"Authorization":"Bearer YOUR_PRIVATE_API_KEY"}}
```

Use an HTTPS origin or a local HTTP origin. The chat endpoint is `/v1/chat/completions`; do not append `/v1` to the configured origin. Other API protocols are not inferred or converted.

```text
TAM --payment-token USDC join prepare --role seller --model YOUR_ACTUAL_MODEL --max-call OWNER_LIMIT --daily-budget OWNER_DAILY_LIMIT --input-price OWNER_INPUT_PRICE --output-price OWNER_OUTPUT_PRICE --upstream-file ABSOLUTE_PRIVATE_FILE
TAM --payment-token USDC join start --headless --no-open
TAM --payment-token USDC join status
```

For account-based access, omit `--upstream-file`. Run `seller login --upstream codex --device` and let the owner complete authorization. This route also requires Git and a Go build environment compatible with CLIProxyAPI, which is prepared as a separate proxy from its public repository. An existing Codex login can be synchronized to the private proxy directory. Visitors must use their own account; never share the website operator's login. Do not bypass account restrictions. Permission and reliability for selling service depend on the upstream account.

Prices are denominated in the selected token per million tokens. The owner must specify BEM prices; do not copy USDC numbers. Initial seller defaults are concurrency 1 and fixed pricing. Do not change prices without permission. Ordinary private networks use existing relays and need no public inbound ports. Check reachability: a process running locally does not prove public availability. Listings appear after the market observer discovers an announcement.

Payment is confirmed after delivery of a complete answer. Sellers bear credit risk if buyers fail to confirm payment. A wallet signature proves neither creditworthiness nor official model origin. After verifying a buyer, the owner can use `join trust --buyer ADDRESS --hours 24`; revoke with `join trust --buyer ADDRESS --revoke`. Trust applies to the current seller/currency, not every buyer in the network. AI must obtain explicit owner permission before granting trust. Inspect receivables with restricted management tools and collect only as authorized.

## Existing installations and failures

Check `--version` and status before changing an existing TAM installation. Do not stop processes unrelated to this setup. If a port belongs to another wallet, agree on separate profiles/ports first. Failed installation preserves staging files for inspection; do not recursively delete user directories automatically. Wallets and account credentials live under `.clawmarket` in the user's home; installed versions live under `.tam/client/releases`. Keep private data out of Git and public packages.

Report stages separately: installed, configured, awaiting review, approved, test tokens received, escrow funded, node running and call confirmed. Without evidence, retain pending status. A URL can guide an AI with local installation/run capabilities; an AI limited to ordinary web chat cannot operate the user's computer merely from a URL.
