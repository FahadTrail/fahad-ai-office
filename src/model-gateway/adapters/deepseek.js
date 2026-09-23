import { ResponsesCompatibleAdapter } from './responses-compatible.js';

// Peak PAYG rates keep budget enforcement conservative even during discounts.
export const DEEPSEEK_FLASH_PEAK_PRICING = Object.freeze({
  inputPerMillion: 0.30,
  cachedInputPerMillion: 0.006,
  outputPerMillion: 1.20,
});

export class DeepSeekResponsesAdapter extends ResponsesCompatibleAdapter {
  constructor({ apiKey, model = 'deepseek-flash', fetchFn = fetch, pricing = DEEPSEEK_FLASH_PEAK_PRICING } = {}) {
    super({
      name: 'deepseek', apiKey, endpoint: 'https://api.deepseek.com/responses', model, fetchFn, pricing,
      // DeepSeek Responses is stateless. Omitting Office metadata minimizes third-party data exposure.
      includeStore: false, includeMetadata: false,
    });
  }
}
