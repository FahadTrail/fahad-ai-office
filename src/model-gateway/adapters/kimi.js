import { ChatCompletionsCompatibleAdapter } from './chat-completions-compatible.js';

export const KIMI_K2_7_CODE_PRICING = Object.freeze({ inputPerMillion: 0.95, cachedInputPerMillion: 0.19, outputPerMillion: 4 });

export class KimiChatAdapter extends ChatCompletionsCompatibleAdapter {
  constructor({ apiKey, model = 'kimi-k2.7-code', fetchFn = fetch, pricing = KIMI_K2_7_CODE_PRICING } = {}) {
    super({ name: 'kimi', apiKey, endpoint: 'https://api.moonshot.ai/v1/chat/completions', model, fetchFn, pricing,
      maxTokensField: 'max_completion_tokens', capabilities: ['coding', 'long-context'] });
  }
}
