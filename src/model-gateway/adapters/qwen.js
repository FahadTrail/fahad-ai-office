import { ChatCompletionsCompatibleAdapter } from './chat-completions-compatible.js';

// Conservative USD ceilings derived from the published Singapore CNY rates.
export const QWEN_CODER_FLASH_PRICING = Object.freeze({ inputPerMillion: 0.35, cachedInputPerMillion: 0.35, outputPerMillion: 1.75 });

export class QwenChatAdapter extends ChatCompletionsCompatibleAdapter {
  constructor({ apiKey, endpoint = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    model = 'qwen3-coder-flash', fetchFn = fetch, pricing = QWEN_CODER_FLASH_PRICING } = {}) {
    super({ name: 'qwen', apiKey, endpoint, model, fetchFn, pricing, capabilities: ['coding', 'long-context'] });
  }
}
