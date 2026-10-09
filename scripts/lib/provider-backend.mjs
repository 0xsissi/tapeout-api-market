import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { readOptionalEnv } from './env.mjs';
import { parseModels } from './testnet-runtime.mjs';

const DEFAULT_MODEL_PRICE = 80;

function parseHeaders(raw, label) {
  if (!raw?.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} must decode to a JSON object`);
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseOptionalNumber(raw, label) {
  if (!raw?.trim()) {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a finite number`);
  }
  return parsed;
}

function withBearer(headers, apiKey) {
  if (!apiKey?.trim()) {
    return headers;
  }

  return {
    ...(headers ?? {}),
    Authorization: headers?.Authorization ?? `Bearer ${apiKey.trim()}`,
  };
}

function buildSingleModel(model, inputPer1m, outputPer1m) {
  if (!model?.trim()) {
    return null;
  }

  return [
    {
      model: model.trim(),
      inputPer1m: inputPer1m ?? DEFAULT_MODEL_PRICE,
      outputPer1m: outputPer1m ?? DEFAULT_MODEL_PRICE,
    },
  ];
}

function parseOptionalCsv(raw) {
  if (!raw?.trim()) {
    return [];
  }

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function buildOpenAiModelsUrl(baseUrl) {
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL('v1/models', normalized).toString();
}

async function discoverOpenAiCompatibleModels({
  backendUrl,
  backendHeaders,
  inputPer1m,
  outputPer1m,
  label,
  allowlist = [],
}) {
  const response = await fetch(buildOpenAiModelsUrl(backendUrl), {
    headers: backendHeaders,
  });
  if (!response.ok) {
    throw new Error(`${label} model discovery failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  const modelIds = Array.isArray(payload?.data)
    ? payload.data
        .map((item) => item?.id)
        .filter((value) => typeof value === 'string' && value.trim())
    : [];
  const allowed = allowlist.length > 0 ? new Set(allowlist) : null;
  const seen = new Set();
  const models = [];

  for (const modelId of modelIds) {
    if (allowed && !allowed.has(modelId)) {
      continue;
    }
    if (seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    models.push({
      model: modelId,
      inputPer1m: inputPer1m ?? DEFAULT_MODEL_PRICE,
      outputPer1m: outputPer1m ?? DEFAULT_MODEL_PRICE,
    });
  }

  return models;
}

async function loadSellerProfile(profilePath) {
  try {
    const raw = await readFile(profilePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function resolveProviderBackend(env = process.env) {
  const explicitModels = env.MODELS_JSON?.trim() ? parseModels(env.MODELS_JSON) : undefined;
  const explicitDailyLimitUsd = parseOptionalNumber(env.DAILY_LIMIT_USD, 'DAILY_LIMIT_USD');
  const explicitRegion = readOptionalEnv('PROVIDER_REGION', env);

  const explicitProxyUrl = env.PROXY_URL?.trim();
  if (explicitProxyUrl) {
    const proxyHeaders = parseHeaders(env.PROXY_HEADERS_JSON, 'PROXY_HEADERS_JSON');
    const proxyInputPer1m = parseOptionalNumber(env.PROXY_INPUT_PER_1M, 'PROXY_INPUT_PER_1M');
    const proxyOutputPer1m = parseOptionalNumber(env.PROXY_OUTPUT_PER_1M, 'PROXY_OUTPUT_PER_1M');
    const proxyModels =
      explicitModels ??
      await discoverOpenAiCompatibleModels({
        backendUrl: explicitProxyUrl,
        backendHeaders: proxyHeaders,
        inputPer1m: proxyInputPer1m,
        outputPer1m: proxyOutputPer1m,
        label: 'PROXY_URL',
        allowlist: parseOptionalCsv(env.PROXY_EXPOSE_MODELS ?? env.EXPOSE_MODELS),
      }).catch(() => null) ??
      parseModels(undefined);

    return {
      backendMode: 'proxy-url',
      backendUrl: explicitProxyUrl,
      backendHeaders: proxyHeaders,
      models: proxyModels,
      dailyLimitUsd: explicitDailyLimitUsd ?? 1000,
      region: explicitRegion ?? 'base-sepolia',
    };
  }

  const upstreamBaseUrl = env.UPSTREAM_BASE_URL?.trim() || env.API_BASE_URL?.trim();
  if (upstreamBaseUrl) {
    const upstreamHeaders = withBearer(
      parseHeaders(env.UPSTREAM_HEADERS_JSON, 'UPSTREAM_HEADERS_JSON'),
      env.UPSTREAM_API_KEY?.trim() || env.API_KEY?.trim(),
    );
    const upstreamInputPer1m = parseOptionalNumber(env.UPSTREAM_INPUT_PER_1M, 'UPSTREAM_INPUT_PER_1M');
    const upstreamOutputPer1m = parseOptionalNumber(env.UPSTREAM_OUTPUT_PER_1M, 'UPSTREAM_OUTPUT_PER_1M');
    const upstreamModels =
      explicitModels ??
      buildSingleModel(
        env.UPSTREAM_MODEL?.trim() || env.MODEL?.trim(),
        upstreamInputPer1m,
        upstreamOutputPer1m,
      ) ??
      await discoverOpenAiCompatibleModels({
        backendUrl: upstreamBaseUrl,
        backendHeaders: upstreamHeaders,
        inputPer1m: upstreamInputPer1m,
        outputPer1m: upstreamOutputPer1m,
        label: 'UPSTREAM_BASE_URL',
        allowlist: parseOptionalCsv(env.UPSTREAM_EXPOSE_MODELS ?? env.EXPOSE_MODELS),
      }).catch(() => null) ??
      parseModels(undefined);

    return {
      backendMode: 'openai-compatible-direct',
      backendUrl: upstreamBaseUrl,
      backendHeaders: upstreamHeaders,
      models: upstreamModels,
      dailyLimitUsd: explicitDailyLimitUsd ?? 1000,
      region: explicitRegion ?? 'base-sepolia',
    };
  }

  const sellerProfilePath =
    env.SELLER_PROFILE_PATH?.trim() || path.join((env.TAM_HOME ?? env.HOME ?? process.env.TAM_HOME ?? process.env.HOME ?? os.homedir()), '.clawmarket', 'seller.json');
  const sellerProfile = await loadSellerProfile(sellerProfilePath);
  if (!sellerProfile) {
    throw new Error(
      'PROXY_URL, UPSTREAM_BASE_URL, or a valid SELLER_PROFILE_PATH is required for seller backend configuration',
    );
  }

  const profileBaseUrl = sellerProfile.apiBaseUrl?.trim();
  if (!profileBaseUrl) {
    throw new Error(`seller profile at ${sellerProfilePath} is missing apiBaseUrl`);
  }

  const profileHeaders = withBearer(undefined, sellerProfile.apiKey?.trim());
  const profileInputPer1m = sellerProfile.pricing?.inputPer1m;
  const profileOutputPer1m = sellerProfile.pricing?.outputPer1m;
  const profileModels =
    explicitModels ??
    buildSingleModel(
      sellerProfile.model?.trim(),
      profileInputPer1m,
      profileOutputPer1m,
    ) ??
    await discoverOpenAiCompatibleModels({
      backendUrl: profileBaseUrl,
      backendHeaders: profileHeaders,
      inputPer1m: profileInputPer1m,
      outputPer1m: profileOutputPer1m,
      label: `SELLER_PROFILE_PATH (${sellerProfilePath})`,
      allowlist: parseOptionalCsv(env.SELLER_PROFILE_EXPOSE_MODELS ?? env.EXPOSE_MODELS),
    }).catch(() => null) ??
    parseModels(undefined);

  return {
    backendMode: 'seller-profile',
    backendUrl: profileBaseUrl,
    backendHeaders: profileHeaders,
    models: profileModels,
    dailyLimitUsd: explicitDailyLimitUsd ?? sellerProfile.dailyLimitUsd ?? 1000,
    region: explicitRegion ?? sellerProfile.region ?? 'base-sepolia',
    sellerProfilePath,
  };
}
