// Provider-neutral conversation model for multi-turn, tool-using agents.
//
// Every provider protocol translates to and from these shapes, so a task's
// transcript, checkpoints and tool history never depend on one vendor:
//
//   Message  { role: 'user' | 'assistant', content: Block[] }
//   Block    { type: 'text', text }
//            { type: 'tool_call', id, name, arguments }            (assistant)
//            { type: 'tool_result', callId, name, content, isError } (user)
//            { type: 'reasoning', provider, model, data }           (assistant, opaque)
//   ToolSpec { name, description, inputSchema }
//
// Opaque reasoning blocks (for example Anthropic thinking signatures) are only
// replayed to the exact provider and model that produced them. A provider
// switch never forwards another vendor's native structures: the new model is
// given a rendered handoff built from durable task state instead.

import { GatewayError } from '../contracts.js';

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function text(value) {
  return { type: 'text', text: String(value ?? '') };
}

export function userText(value) {
  return { role: 'user', content: [text(value)] };
}

export function toolResult(call, content, { isError = false } = {}) {
  return {
    type: 'tool_result',
    callId: call.id,
    name: call.name,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    isError: Boolean(isError),
  };
}

export function normalizeToolSpecs(tools = []) {
  if (!Array.isArray(tools)) throw invalid('tools must be an array');
  const seen = new Set();
  return tools.map((tool) => {
    if (!TOOL_NAME.test(tool?.name || '')) throw invalid(`Tool name ${tool?.name} is not portable across providers`);
    if (seen.has(tool.name)) throw invalid(`Duplicate tool ${tool.name}`);
    seen.add(tool.name);
    if (!tool.inputSchema || tool.inputSchema.type !== 'object') throw invalid(`Tool ${tool.name} needs an object input schema`);
    return Object.freeze({
      name: tool.name,
      description: String(tool.description || '').slice(0, 1024),
      inputSchema: tool.inputSchema,
    });
  });
}

export function validateConversation(messages) {
  if (!Array.isArray(messages) || !messages.length) throw invalid('A conversation needs at least one message');
  if (messages[0].role !== 'user') throw invalid('A conversation must start with a user message');
  const openCalls = new Map();
  for (const message of messages) {
    if (!['user', 'assistant'].includes(message?.role)) throw invalid('Unsupported message role');
    if (!Array.isArray(message.content) || !message.content.length) throw invalid('Messages need content blocks');
    for (const block of message.content) {
      if (block.type === 'tool_call') {
        if (message.role !== 'assistant') throw invalid('Only assistant messages may call tools');
        openCalls.set(block.id, block.name);
      } else if (block.type === 'tool_result') {
        if (message.role !== 'user') throw invalid('Tool results belong to user messages');
        if (!openCalls.has(block.callId)) throw invalid(`Tool result ${block.callId} has no matching call`);
        openCalls.delete(block.callId);
      } else if (!['text', 'reasoning'].includes(block.type)) {
        throw invalid(`Unsupported block type ${block.type}`);
      }
    }
  }
  return messages;
}

// Pending tool calls are those in the final assistant message that have not
// yet received results. The controller must answer all of them before the
// next model turn.
export function pendingToolCalls(messages) {
  const last = messages.at(-1);
  if (last?.role !== 'assistant') return [];
  return last.content.filter((block) => block.type === 'tool_call');
}

export function stripForeignReasoning(messages, { provider, model }) {
  return messages.map((message) => ({
    ...message,
    content: message.content.filter((block) => block.type !== 'reasoning' ||
      (block.provider === provider && block.model === model)),
  })).filter((message) => message.content.length);
}

export function transcriptChars(messages) {
  let total = 0;
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text') total += block.text.length;
      else if (block.type === 'tool_call') total += JSON.stringify(block.arguments || {}).length + block.name.length;
      else if (block.type === 'tool_result') total += block.content.length;
    }
  }
  return total;
}

// Renders the recent part of a transcript as plain text so any model can read
// it. Used when ownership moves to another provider or when the transcript is
// compacted: structural vendor details are dropped, facts are kept.
export function renderRecentActivity(messages, { maxChars = 24_000, maxResultChars = 4_000 } = {}) {
  const lines = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim()) {
        lines.push(`${message.role === 'assistant' ? 'AGENT' : 'CONTROLLER'}: ${block.text.trim()}`);
      } else if (block.type === 'tool_call') {
        lines.push(`TOOL CALL ${block.name} ${truncate(JSON.stringify(block.arguments || {}), 1_500)}`);
      } else if (block.type === 'tool_result') {
        lines.push(`TOOL RESULT ${block.name}${block.isError ? ' (error)' : ''}: ${truncate(block.content, maxResultChars)}`);
      }
    }
  }
  let rendered = '';
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const next = `${lines[index]}\n${rendered}`;
    if (next.length > maxChars) {
      rendered = `[${index + 1} earlier entries omitted; see the durable state summary]\n${rendered}`;
      break;
    }
    rendered = next;
  }
  return rendered.trim();
}

export function truncate(value, maximum) {
  const textValue = String(value ?? '');
  if (textValue.length <= maximum) return textValue;
  const head = Math.floor(maximum * 0.6);
  const tail = maximum - head;
  return `${textValue.slice(0, head)}\n…[${textValue.length - maximum} characters truncated]…\n${textValue.slice(-tail)}`;
}

// JSON-Schema subset accepted by every supported function-calling protocol.
export function portableSchema(schema) {
  if (Array.isArray(schema)) return schema.map(portableSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (['$schema', 'additionalProperties', 'minLength', 'maxLength', 'pattern', 'maxItems', 'minItems', 'default'].includes(key)) continue;
    result[key] = key === 'properties'
      ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, portableSchema(child)]))
      : portableSchema(value);
  }
  return result;
}

function invalid(message) {
  return new GatewayError(message, { code: 'INVALID_AGENT_CONVERSATION', failureClass: 'fatal' });
}
