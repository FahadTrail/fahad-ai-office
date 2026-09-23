import { ChatCompletionsCompatibleAdapter } from './chat-completions-compatible.js';

// Conservative USD ceilings derived from the published Singapore CNY rates.
export const QWEN_38_FLASH_PRICING = Object.freeze({ inputPerMillion: 0.20, cachedInputPerMillion: 0.03, outputPerMillion: 0.60 });

export class QwenChatAdapter extends ChatCompletionsCompatibleAdapter {
  constructor({ apiKey, endpoint = 'https://qwen.invalid/compatible-mode/v1/chat/completions',
    model = 'qwen3.8-flash', fetchFn = fetch, pricing = QWEN_38_FLASH_PRICING } = {}) {
    super({ name: 'qwen', apiKey, endpoint, model, fetchFn, pricing, capabilities: ['coding', 'long-context'] });
  }
}
