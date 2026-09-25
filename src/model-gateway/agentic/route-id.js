// A route id has the form `provider:model`. The model part may itself
// contain colons (`openrouter:qwen/qwen3-coder:free`), so only the first
// colon separates provider from model.

export function parseRouteId(id) {
  if (typeof id !== 'string') throw new TypeError('route id must be a string');
  const index = id.indexOf(':');
  if (index <= 0 || index === id.length - 1) {
    throw new TypeError(`invalid route id: ${JSON.stringify(id)}`);
  }
  return { provider: id.slice(0, index), model: id.slice(index + 1) };
}

export function formatRouteId(provider, model) {
  if (typeof provider !== 'string' || !provider) throw new TypeError('provider must be a non-empty string');
  if (typeof model !== 'string' || !model) throw new TypeError('model must be a non-empty string');
  return `${provider}:${model}`;
}
