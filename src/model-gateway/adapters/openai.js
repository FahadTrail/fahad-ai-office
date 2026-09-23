import { ResponsesCompatibleAdapter } from './responses-compatible.js';

export class OpenAIResponsesAdapter extends ResponsesCompatibleAdapter {
  constructor({ apiKey, model = 'gpt-5.3-codex', fetchFn = fetch, pricing = null } = {}) {
    super({
      name: 'openai', apiKey, endpoint: 'https://api.openai.com/v1/responses', model, fetchFn, pricing,
      includeStore: true, includeMetadata: true,
    });
  }
}
