export interface UsageRecord {
  timestamp: number;
  authIndex: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  failed: boolean;
}

export class CliproxyUsageClient {
  constructor(
    private readonly managementUrl: string,
  ) {}

  async fetchRecentRecords(sinceMs: number): Promise<UsageRecord[]> {
    let response: Response;
    try {
      response = await fetch(`${this.managementUrl}/management/usage`);
    } catch (error) {
      console.warn('[CliproxyUsageClient] usage fetch failed', error);
      return [];
    }

    if (!response.ok) {
      console.warn(`[CliproxyUsageClient] usage endpoint returned ${response.status}`);
      return [];
    }

    let data: {
      usage?: {
        apis?: Record<string, {
          models?: Record<string, {
            details?: Array<{
              timestamp?: string;
              auth_index?: string;
              failed?: boolean;
              tokens?: {
                input_tokens?: number;
                output_tokens?: number;
                total_tokens?: number;
              };
            }>;
          }>;
        }>;
      };
    };
    try {
      data = await response.json() as typeof data;
    } catch (error) {
      console.warn('[CliproxyUsageClient] usage endpoint returned non-JSON', error);
      return [];
    }

    const records: UsageRecord[] = [];
    for (const apiKey of Object.keys(data.usage?.apis ?? {})) {
      const models = data.usage?.apis?.[apiKey]?.models ?? {};
      for (const model of Object.keys(models)) {
        for (const detail of models[model]?.details ?? []) {
          const timestamp = detail.timestamp ? new Date(detail.timestamp).getTime() : Number.NaN;
          if (!Number.isFinite(timestamp) || timestamp < sinceMs) {
            continue;
          }
          records.push({
            timestamp,
            authIndex: detail.auth_index ?? apiKey,
            model,
            inputTokens: detail.tokens?.input_tokens ?? 0,
            outputTokens: detail.tokens?.output_tokens ?? 0,
            totalTokens: detail.tokens?.total_tokens ?? 0,
            failed: detail.failed === true,
          });
        }
      }
    }
    return records;
  }
}
