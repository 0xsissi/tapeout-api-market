export interface MockUsageRecord {
  timestamp: number;
  authIndex: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  failed: boolean;
}

export class MockCliproxy {
  private readonly records: MockUsageRecord[] = [];

  record(record: MockUsageRecord): void {
    this.records.push(record);
  }

  async fetchRecentRecords(sinceMs: number): Promise<MockUsageRecord[]> {
    return this.records.filter((record) => record.timestamp >= sinceMs);
  }

  clear(): void {
    this.records.length = 0;
  }
}
