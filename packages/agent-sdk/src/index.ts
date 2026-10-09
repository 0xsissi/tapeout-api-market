import {
  AuthorizationSigner,
  BITMAP_AUTHORIZATION_TYPES,
  getDefaultAuthorizationDomain,
  assertModelProvenanceReady,
  modelProvenanceRequestBinding,
  ModelProvenanceTextDigest,
  ModelProvenanceError,
  verifyModelProvenance,
} from '@clawmarket/crypto';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  HostedGatewayDepositResponse,
  HostedGatewayExecuteToken,
  HostedGatewayPermitDepositRequest,
  HostedGatewayPrepareResponse,
  SignedAuthorization,
  SignedInferenceIntent,
  TokenUsage,
  ModelProvenancePolicy,
  ModelProvenanceVerifier,
  ModelProvenanceVerification,
} from '@clawmarket/shared';
import { settlementAmount, lockedPrices, tokenCost, inputTokenBudget, validateChatRequest } from '@clawmarket/shared';
import { resolvePaymentToken, PAYMENT_TOKEN, PAYMENT_NETWORK, parsePaymentAmount, assertPaymentDeployment, type PaymentToken, type PaymentNetwork } from '@clawmarket/shared';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  parseAbi,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

export interface ClawMarketClientConfig {
  modelProvenance?: ModelProvenancePolicy;
  modelProvenanceVerifier?: ModelProvenanceVerifier;
  inputOverheadTokens?: number;
  paymentToken?: 'USDC' | 'BEM';
  paymentNetwork?: PaymentNetwork;
  maxRequestCostToken?: number;
  baseURL: string;
  gatewayToken?: string;
  maxRequestCostUsd?: number;
  apiKey?: `0x${string}`;
  privateKey?: `0x${string}`;
  escrowPoolAddress: `0x${string}`;
  rpcUrl: string;
  chainId?: number;
  fetch?: typeof fetch;
  maxRetries?: number;
}

export interface PermitDepositOptions {
  tokenAddress: `0x${string}`;
  amount: string | number | bigint;
  tokenName?: string;
  deadlineSeconds?: number;
}

const ERC20_PERMIT_ABI = [
  {
    type: 'function',
    name: 'nonces',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export class ClawMarket {
  readonly chat: {
    completions: {
      create: (request: ChatCompletionRequest) => Promise<ChatCompletionResponse | AsyncIterable<unknown>>;
    };
  };
  readonly models: {
    list: () => Promise<unknown>;
  };

  private readonly gatewayToken?: string;
  private readonly maxRequestCostUsd: number;
  private readonly paymentToken: PaymentToken;
  private deploymentCheck?: Promise<void>;
  private readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;
  private readonly signer: AuthorizationSigner;
  private readonly privateKey: `0x${string}`;
  private readonly escrowPoolAddress: `0x${string}`;
  private readonly rpcUrl: string;
  private readonly chainId: number;
  private readonly maxRetries: number;
  private readonly inputOverheadTokens: number;
  private readonly provenancePolicy: ModelProvenancePolicy;
  private readonly provenanceVerifier?: ModelProvenanceVerifier;

  constructor(config: ClawMarketClientConfig) {
    this.provenancePolicy = structuredClone(config.modelProvenance ?? { mode: 'off' });
    this.provenanceVerifier = config.modelProvenanceVerifier;
    assertModelProvenanceReady(this.provenancePolicy, this.provenanceVerifier);
    const privateKey = config.privateKey ?? config.apiKey;
    if (!privateKey) {
      throw new Error('Tapeout API Market (TAM) requires a buyer private key as privateKey or apiKey');
    }
    this.privateKey = privateKey;
    this.gatewayToken = config.gatewayToken;
    this.paymentToken = resolvePaymentToken(config.paymentToken ?? PAYMENT_TOKEN.symbol, config.paymentNetwork ?? PAYMENT_NETWORK);
    if (this.paymentToken.symbol === 'BEM' && config.maxRequestCostToken == null) throw new Error('maxRequestCostToken is required in BEM units');
    this.maxRequestCostUsd = config.maxRequestCostToken ?? config.maxRequestCostUsd ?? 0.1;
    if (!Number.isFinite(this.maxRequestCostUsd) || this.maxRequestCostUsd <= 0) throw new Error('Invalid payment budget');
    this.baseURL = config.baseURL.replace(/\/+$/, '');
    this.fetchImpl = config.fetch ?? fetch;
    this.escrowPoolAddress = config.escrowPoolAddress;
    this.rpcUrl = config.rpcUrl;
    this.chainId = config.chainId ?? this.paymentToken.chainId;
    if ((this.paymentToken.symbol === 'BEM' || this.paymentToken.chainId === 97 || this.chainId === 97) && this.chainId !== this.paymentToken.chainId) throw new Error(`${this.paymentToken.symbol} requires chain ${this.paymentToken.chainId} for the selected payment network`);
    this.maxRetries = config.maxRetries ?? 1;
    this.inputOverheadTokens = config.inputOverheadTokens ?? 512;
    inputTokenBudget({ model: '', messages: [] }, this.inputOverheadTokens);
    this.signer = new AuthorizationSigner(
      privateKey,
      config.escrowPoolAddress,
      config.rpcUrl,
      this.chainId,
    );

    this.chat = {
      completions: {
        create: (request) => this.createChatCompletion(request),
      },
    };
    this.models = {
      list: () => this.requestJson('/v1/models'),
    };
  }

  get buyerAddress(): `0x${string}` {
    return this.signer.address;
  }

  async prepareChatCompletion(request: ChatCompletionRequest): Promise<HostedGatewayPrepareResponse> {
    const prepared = await this.requestJson<HostedGatewayPrepareResponse>('/v1/claw/prepare', {
      method: 'POST',
      body: JSON.stringify({
        buyer: this.buyerAddress,
        request,
      }),
    });
    this.validatePaymentToken(prepared);
    return prepared;
  }

  async createExecutionToken(prepare: HostedGatewayPrepareResponse): Promise<string> {
    this.validatePaymentToken(prepare);
    if (BigInt(prepare.authorization.amount) <= 0n || BigInt(prepare.authorization.amount) > parsePaymentAmount(this.maxRequestCostUsd, this.paymentToken)) throw new Error('Request exceeds configured payment budget');
    this.deploymentCheck ??= assertPaymentDeployment(this.escrowPoolAddress, this.rpcUrl, this.chainId, this.paymentToken);
    await this.deploymentCheck;
    if (prepare.typedData.domain.name !== 'ClawInferenceIntent' || prepare.typedData.domain.chainId !== this.chainId ||
        prepare.typedData.domain.verifyingContract.toLowerCase() !== this.escrowPoolAddress.toLowerCase()) throw new Error('Unsafe hosted payment domain');
    const authorization = await this.signer.signInferenceIntent(this.parseIntent(prepare.authorization));
    const token: HostedGatewayExecuteToken = {
      preparedRequestId: prepare.preparedRequestId,
      authorization: {
        ...prepare.authorization,
        signature: authorization.signature,
      },
    };
    return `claw_${Buffer.from(JSON.stringify(token), 'utf8').toString('base64url')}`;
  }

  async estimateCost(request: ChatCompletionRequest): Promise<HostedGatewayPrepareResponse> {
    return this.prepareChatCompletion(request);
  }

  async depositWithPermit(options: PermitDepositOptions): Promise<HostedGatewayDepositResponse> {
    if (this.paymentToken.symbol === 'BEM') throw new Error('Use depositWithApproval for BEM; permit support has not been verified');
    if (options.tokenAddress.toLowerCase() !== this.paymentToken.address.toLowerCase()) throw new Error('Deposit token does not match the selected payment network');
    await assertPaymentDeployment(this.escrowPoolAddress, this.rpcUrl, this.chainId, this.paymentToken);
    const permit = await this.signDepositPermit(options);
    return this.requestJson('/v1/claw/deposit/permit', {
      method: 'POST',
      body: JSON.stringify(permit),
    });
  }

  /** Token amount as a decimal string; approval is limited to this deposit. Buyer pays gas. */
  async depositWithApproval(amountToken: string): Promise<HostedGatewayDepositResponse> {
    const amount = parsePaymentAmount(amountToken, this.paymentToken);
    if (amount <= 0n) throw new Error('Deposit must be positive');
    await assertPaymentDeployment(this.escrowPoolAddress, this.rpcUrl, this.chainId, this.paymentToken);
    const account = privateKeyToAccount(this.privateKey), chain = chainFor(this.chainId, this.rpcUrl);
    const client = createPublicClient({ chain, transport: http(this.rpcUrl) });
    const wallet = createWalletClient({ account, chain, transport: http(this.rpcUrl) });
    const abi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)', 'function allowance(address owner, address spender) view returns (uint256)']);
    const allowance = await client.readContract({ address: this.paymentToken.address, abi, functionName: 'allowance', args: [account.address, this.escrowPoolAddress] });
    if (allowance < amount) {
      const approval = await wallet.writeContract({ address: this.paymentToken.address, abi, functionName: 'approve', args: [this.escrowPoolAddress, amount] });
      if ((await client.waitForTransactionReceipt({ hash: approval })).status !== 'success') throw new Error('Token approval failed');
    }
    const txHash = await wallet.writeContract({ address: this.escrowPoolAddress, abi: parseAbi(['function deposit(uint256 amount)']), functionName: 'deposit', args: [amount] });
    if ((await client.waitForTransactionReceipt({ hash: txHash })).status !== 'success') throw new Error('Token deposit failed');
    return { txHash };
  }

  private validatePaymentToken(prepare: HostedGatewayPrepareResponse): void {
    const token = prepare.paymentToken;
    if (!token && this.paymentToken.symbol === 'USDC' && this.paymentToken.chainId === 84532) return; // legacy Base Sepolia USDC gateway
    if (!token || token.symbol !== this.paymentToken.symbol || token.address.toLowerCase() !== this.paymentToken.address.toLowerCase() ||
        token.decimals !== this.paymentToken.decimals || token.chainId !== this.paymentToken.chainId || token.minimumAmount !== this.paymentToken.minimumAmount) {
      throw new Error('Hosted gateway settlement currency does not match buyer configuration');
    }
  }

  private async createChatCompletion(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse | AsyncIterable<unknown>> {
    request = structuredClone(request);
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const prepared = await this.prepareChatCompletion(request);
      validateChatRequest(request);
      this.validatePaymentToken(prepared);
      const prices = lockedPrices(prepared.provider.pricing, undefined, this.paymentToken);
      const quote = prepared.authorization;
      if (quote.buyer.toLowerCase() !== this.buyerAddress.toLowerCase() || quote.seller.toLowerCase() !== prepared.provider.walletAddress.toLowerCase() ||
          quote.requestId !== prepared.requestId || quote.poolId.toLowerCase() !== ('0x' + this.escrowPoolAddress.slice(2).padStart(64, '0')).toLowerCase() ||
          quote.maxInputTokens !== inputTokenBudget(request, this.inputOverheadTokens) || quote.maxOutputTokens !== (request.max_tokens ?? 1024) ||
          BigInt(quote.inputPrice) !== prices.inputPrice || BigInt(quote.outputPrice) !== prices.outputPrice ||
          BigInt(quote.amount) !== tokenCost(quote.maxInputTokens, quote.maxOutputTokens, prices.inputPrice, prices.outputPrice, this.paymentToken)) throw new Error('Hosted intent does not match request budget');
      if (BigInt(quote.amount) > parsePaymentAmount(this.maxRequestCostUsd, this.paymentToken)) throw new Error('Request exceeds configured payment budget');
      const executeToken = await this.createExecutionToken(prepared);
      const response = await this.fetchImpl(`${this.baseURL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${executeToken}`,
        },
        body: JSON.stringify(request),
      });

      if (response.ok) {
        if (request.stream === true) {
          const client = this;
          return (async function* () {
            let content = '', settled = false;
            const digest = new ModelProvenanceTextDigest();
            for await (const chunk of streamSse(response)) {
              const value = chunk as any;
              if (value.error) throw new Error(value.error.message ?? 'Hosted delivery failed');
              if (settled) throw new Error('Hosted stream continued after settlement');
              if (client.provenancePolicy.mode !== 'off' && value.choices?.length > 1) throw new ModelProvenanceError('unsupported_response');
              const delta = value.choices?.[0]?.delta?.content ?? '';
              content += delta; digest.update(delta);
              if (value.clawSettlement) {
                if (settled) throw new Error('Duplicate delivery confirmation');
                if (!content.trim()) throw new Error('Cannot confirm an empty response');
                const tamProvenance = await client.confirmDelivery(prepared, value.usage, value.clawSettlement, request, digest.digest(), value.modelProvenanceProof);
                settled = true;
                const { clawSettlement: _, tamProvenance: _untrusted, ...completion } = value;
                yield { id: prepared.requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), ...completion,
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], tamProvenance };
              } else {
                const { tamProvenance: _untrusted, ...deltaChunk } = value;
                // Older gateways emit stop before settlement metadata. Keep it provisional.
                yield { ...deltaChunk, choices: value.choices?.map((choice: any) => ({ ...choice, finish_reason: null })) };
              }
            }
            if (!settled) throw new Error('Stream ended without delivery confirmation');
          })();
        }
        const result = await response.json() as ChatCompletionResponse & { clawSettlement?: { preparedRequestId: string } };
        if (this.provenancePolicy.mode !== 'off' && result.choices?.length !== 1) throw new ModelProvenanceError('unsupported_response');
        if (!result.choices?.[0]?.message?.content?.trim() || !result.clawSettlement) throw new Error('Missing complete delivery or settlement metadata');
        const digest = new ModelProvenanceTextDigest(); digest.update(result.choices[0].message.content);
        result.tamProvenance = await this.confirmDelivery(prepared, result.usage, result.clawSettlement, request, digest.digest(), result.modelProvenanceProof);
        delete result.clawSettlement;
        return result;
      }

      const errorText = await response.text();
      lastError = new Error(errorText);
      if (!shouldRetryHostedError(response.status, errorText) || attempt >= this.maxRetries) {
        throw lastError;
      }
    }

    throw lastError ?? new Error('Hosted Gateway request failed');
  }

  private parseIntent(quote: HostedGatewayPrepareResponse['authorization']): Omit<SignedInferenceIntent, 'signature'> {
    return { ...quote, amount: BigInt(quote.amount), nonce: BigInt(quote.nonce), inputPrice: BigInt(quote.inputPrice), outputPrice: BigInt(quote.outputPrice) };
  }

  private async confirmDelivery(prepared: HostedGatewayPrepareResponse, usage: TokenUsage, metadata: { preparedRequestId: string }, request: ChatCompletionRequest, responseHash: string, proof: unknown): Promise<ModelProvenanceVerification> {
    if (metadata.preparedRequestId !== prepared.preparedRequestId) throw new Error('Settlement request mismatch');
    const intent = this.parseIntent(prepared.authorization);
    const amount = settlementAmount({ ...intent, signature: '0x' }, usage, this.paymentToken);
    const expected = { ...modelProvenanceRequestBinding(request, { ...intent, signature: '0x' }, this.chainId), responseHash, usage };
    const verification = await verifyModelProvenance(proof, expected, this.provenancePolicy, this.provenanceVerifier);
    const { buyer, seller, nonce, expiresAt, poolId, nonceMode } = intent;
    const authorization = await this.signer.signAuthorization({ buyer, seller, amount, nonce, expiresAt, poolId, nonceMode });
    const { signature } = authorization;
    await this.requestJson('/v1/claw/settle', { method: 'POST', body: JSON.stringify({ preparedRequestId: prepared.preparedRequestId,
      authorization: { buyer, seller, amount: amount.toString(), nonce: nonce.toString(), expiresAt, poolId, nonceMode, signature } }) });
    return verification;
  }

  private async signDepositPermit(options: PermitDepositOptions): Promise<HostedGatewayPermitDepositRequest> {
    const account = privateKeyToAccount(this.privateKey);
    const chain = chainFor(this.chainId, this.rpcUrl);
    const publicClient = createPublicClient({ chain, transport: http(this.rpcUrl) });
    const walletClient = createWalletClient({ account, chain, transport: http(this.rpcUrl) });
    const amount = normalizePermitAmount(options.amount);
    const deadline = Math.floor(Date.now() / 1000) + (options.deadlineSeconds ?? 10 * 60);
    const nonce = await publicClient.readContract({
      address: options.tokenAddress,
      abi: ERC20_PERMIT_ABI,
      functionName: 'nonces',
      args: [account.address],
    });

    const signature = await walletClient.signTypedData({
      account,
      domain: {
        name: options.tokenName ?? (this.paymentToken.chainId === 97 ? 'TAM Test USDC' : 'USD Coin'),
        version: '1',
        chainId: this.chainId,
        verifyingContract: options.tokenAddress,
      },
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'Permit',
      message: {
        owner: account.address,
        spender: this.escrowPoolAddress,
        value: amount,
        nonce,
        deadline: BigInt(deadline),
      },
    });
    const { r, s, v } = splitSignature(signature);
    return {
      buyer: account.address,
      amount: amount.toString(),
      deadline,
      v,
      r,
      s,
    };
  }

  private async requestJson<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseURL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(this.gatewayToken ? { Authorization: `Bearer ${this.gatewayToken}` } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return response.json() as Promise<T>;
  }
}

export const ClawMarketAgentSDK = ClawMarket;
// Branded entry points share the existing client implementation for compatibility.
export { ClawMarket as TAM, ClawMarket as TapeoutAPIMarket };
export type TAMClientConfig = ClawMarketClientConfig;
export { TAMAgentClient } from './agent.js';
export { BITMAP_AUTHORIZATION_TYPES, getDefaultAuthorizationDomain };

function normalizePermitAmount(amount: string | number | bigint): bigint {
  if (typeof amount === 'bigint') {
    return amount;
  }
  if (typeof amount === 'number') {
    return parseUnits(amount.toFixed(6), 6);
  }
  if (/^\d+$/.test(amount)) {
    return BigInt(amount);
  }
  return parseUnits(amount, 6);
}

function splitSignature(signature: `0x${string}`): { r: `0x${string}`; s: `0x${string}`; v: number } {
  const hex = signature.slice(2);
  return {
    r: `0x${hex.slice(0, 64)}`,
    s: `0x${hex.slice(64, 128)}`,
    v: Number.parseInt(hex.slice(128, 130), 16),
  };
}

function shouldRetryHostedError(status: number, body: string): boolean {
  if (status === 429) {
    return true;
  }
  try {
    const parsed = JSON.parse(body) as { error?: { type?: string } };
    return parsed.error?.type === 'backpressure_soft_reject';
  } catch {
    return false;
  }
}

async function* streamSse(response: Response): AsyncIterable<unknown> {
  if (!response.body) {
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    if (buffer.length > 2_097_152) throw new Error('Hosted SSE event exceeds size limit');
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find((item) => item.startsWith('data: '));
      if (!line) {
        continue;
      }
      const data = line.slice('data: '.length);
      if (data === '[DONE]') {
        return;
      }
      yield JSON.parse(data);
    }
  }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function chainFor(chainId: number, rpcUrl: string): Chain {
  if (chainId === baseSepolia.id) {
    return baseSepolia;
  }
  return {
    id: chainId,
    name: `Chain ${chainId}`,
    nativeCurrency: { name: chainId === 97 ? 'tBNB' : chainId === 56 ? 'BNB' : 'ETH', symbol: chainId === 97 ? 'tBNB' : chainId === 56 ? 'BNB' : 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}
