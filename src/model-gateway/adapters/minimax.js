import { ChatCompletionsCompatibleAdapter } from './chat-completions-compatible.js';

export const MINIMAX_M2_7_PRICING = Object.freeze({ inputPerMillion: 0.30, cachedInputPerMillion: 0.06, outputPerMillion: 1.20 });

export class MiniMaxChatAdapter extends ChatCompletionsCompatibleAdapter {
  constructor({ apiKey, model = 'MiniMax-M2.7', fetchFn = fetch, pricing = MINIMAX_M2_7_PRICING } = {}) {
    super({ name: 'minimax', apiKey, endpoint: 'https://api.minimax.io/v1/chat/completions', model, fetchFn, pricing,
      capabilities: ['coding', 'long-context'] });
  }
}
