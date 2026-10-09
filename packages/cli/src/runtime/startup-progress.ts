export type StartupRole = 'buyer' | 'seller';
export type StartupPhase = 'checking' | 'wallet' | 'settlement' | 'account' | 'clock' | 'network' | 'listening' | 'verifying' | 'proxy-build' | 'proxy-start' | 'reachability' | 'ready';
export type StartupReporter = (phase: StartupPhase) => void;

export function abortableStartup<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
const phases = new Set<StartupPhase>(['checking', 'wallet', 'settlement', 'account', 'clock', 'network', 'listening', 'verifying', 'proxy-build', 'proxy-start', 'reachability', 'ready']);

/** Parse only our bounded stage markers, never arbitrary logs, credentials or upstream output. */
export function createStartupMonitor(role: StartupRole, report?: StartupReporter): (chunk: Buffer | string) => void {
  let pending = '';
  return chunk => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/); pending = (lines.pop() ?? '').slice(-512);
    for (const line of lines) {
      const match = /^\[TAM_STARTUP\] (buyer|seller) ([a-z-]+)$/.exec(line);
      if (match?.[1] === role && phases.has(match[2] as StartupPhase)) report?.(match[2] as StartupPhase);
    }
  };
}

export function startupPhaseLabel(role: StartupRole, phase: StartupPhase): string {
  const labels: Record<StartupPhase, string> = {
    checking: '检查已有服务', wallet: '准备本机钱包与身份', settlement: '核对 BSC 测试网和结算合约', account: '检查模型账号登录',
    clock: '核对本机时间', network: '启动 P2P 网络', listening: role === 'buyer' ? '启动本机 API' : '启动卖家状态服务',
    verifying: '核对服务配置', 'proxy-build': '准备反代依赖和编译缓存', 'proxy-start': '启动模型反代', reachability: '检查公网连接',
    ready: role === 'buyer' ? '本机买家已就绪，卖家发现继续在后台运行' : '卖家服务已就绪',
  };
  return labels[phase];
}
