import { HttpResponseError } from './http.js';

/** Friendly connection guidance; unrelated payment/authentication errors keep their original meaning. */
export function friendlyChatError(error: unknown, model: string, beforeRequest = false): Error {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof HttpResponseError ? error.details?.code : undefined;
  let hint: string | undefined;
  if (code === 'no_provider' || code === 'no_candidate_after_filter' || /^No provider available for model /i.test(message)) {
    hint = `当前没有可用卖家提供 ${model}。请到“服务市场”选择其他模型，或等待卖家上线后重试。`;
  } else if (code === 'transport_unreachable') {
    hint = '已发现卖家，但暂时无法连接。请检查网络，或到“服务市场”选择其他模型后重试。';
  } else if (code === 'backpressure' || code === 'model_cooldown') {
    hint = '当前卖家暂时不可用。请到“服务市场”选择其他模型，或稍后重试。';
  } else if (/无法连接 buyer gateway|^fetch failed$/i.test(message) || (error instanceof Error && (error.cause as { code?: string })?.code === 'ECONNREFUSED')) {
    hint = beforeRequest ? '买家服务尚未连接。请到“总览”启动买家服务，再发送消息。'
      : '与买家的连接中断。请先核对调用结果和余额，再到“总览”重新连接买家服务。';
  } else if (code === 'timeout' || error instanceof Error && error.name === 'AbortError') {
    hint = '等待卖家回答超时。请先核对调用结果和余额，再决定是否重试；也可到“服务市场”更换模型。';
  }
  return hint ? new Error(hint) : error instanceof Error ? error : new Error(message);
}
