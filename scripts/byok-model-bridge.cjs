// 本地 BYOK 模型桥：接收 worker 改写后的 OpenAI Chat Completions 请求，
// 按上游协议（OpenAI / Anthropic）转发，并把响应统一成 OpenAI SSE 流。
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.BYOK_BRIDGE_PORT || 17895);
const HOST = '127.0.0.1';
const DB_PATH = process.env.QWENWORK_AGENTS_DB
  || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'QwenWorkCN', 'data', 'agents.db');
const LOG_PATH = path.join(__dirname, 'byok-model-bridge.log');

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_ANTHROPIC_MAX_TOKENS = 8192;
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 20000;

function log(...args) {
  const line = `${new Date().toISOString()} ${args.join(' ')}`;
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
  console.log(line);
}

function queryModel(model) {
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const row = db.prepare(
      'select url, model, style, format, provider, extra_params, max_output_tokens from byok_custom_models where model = ? limit 1',
    ).get(model);
    db.close();
    return row;
  } catch (e) {
    log('DB_ERR', e.message);
    return null;
  }
}

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function candidateUrls(primary, base, style) {
  const list = [];
  const add = (value) => {
    const url = normalizeUrl(value);
    if (url && !list.includes(url)) list.push(url);
  };
  const expand = (raw) => {
    if (!raw) return;
    const url = normalizeUrl(raw);
    if (style === 'anthropic') {
      if (/\/messages$/.test(url)) add(url);
      else if (/\/v1$/.test(url)) add(url + '/messages');
      else { add(url + '/v1/messages'); add(url + '/messages'); }
      if (/\/chat\/completions$/.test(url)) add(url.replace(/\/chat\/completions$/, '/messages'));
      return;
    }
    if (/\/chat\/completions$/.test(url)) {
      add(url);
      add(url.replace(/\/chat\/completions$/, '/v1/chat/completions'));
    } else if (/\/v1$/.test(url)) {
      add(url + '/chat/completions');
    } else {
      add(url + '/chat/completions');
      add(url + '/v1/chat/completions');
    }
  };
  expand(primary);
  expand(base);
  return list;
}

function resolveUpstream(model, headers) {
  const row = queryModel(model) || {};
  let extraBase = '';
  try {
    extraBase = JSON.parse(row.extra_params || '{}').baseUrl || '';
  } catch {}
  const styleSource = String(headers['x-byok-style'] || row.style || row.format || row.provider || '');
  const style = /anthropic/i.test(styleSource) ? 'anthropic' : 'openai';
  const primary = headers['x-byok-upstream'] || row.url || '';
  return {
    style,
    urls: candidateUrls(primary, extraBase, style),
    maxTokens: Number(row.max_output_tokens) || 0,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function countImages(messages) {
  let total = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const part of Array.isArray(message && message.content) ? message.content : []) {
      if (part && (part.type === 'image_url' || part.type === 'image')) total += 1;
    }
  }
  return total;
}

function describeMessages(messages) {
  if (!Array.isArray(messages)) return '';
  return messages.slice(-4).map((message) => {
    if (!message) return '?';
    const content = message.content;
    const kinds = typeof content === 'string'
      ? 'str'
      : Array.isArray(content)
        ? content.map((part) => (part && part.type ? part.type : '?')).join('+')
        : '?';
    return message.role + ':' + kinds;
  }).join(',');
}

function openAIHeaders(auth) {
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...(auth ? { authorization: auth } : {}),
  };
}

function anthropicHeaders(auth) {
  const key = String(auth || '').replace(/^Bearer\s+/i, '').trim();
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'anthropic-version': ANTHROPIC_VERSION,
    ...(key ? { 'x-api-key': key } : {}),
  };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part && part.type === 'text' ? (part.text || '') : '')).join('');
}

async function imageBlock(part) {
  const source = part.image_url || {};
  const url = source.url || part.url || '';
  if (!url) return null;
  const dataUrl = /^data:([^;,]+);base64,(.*)$/is.exec(url);
  if (dataUrl) {
    return { type: 'image', source: { type: 'base64', media_type: dataUrl[1], data: dataUrl[2] } };
  }
  if (/^https?:/i.test(url)) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        const mediaType = String(response.headers.get('content-type') || 'image/png').split(';')[0].trim();
        if (buffer.length <= MAX_INLINE_IMAGE_BYTES && /^image\//i.test(mediaType)) {
          return { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } };
        }
      }
    } catch (e) {
      log('IMAGE_FETCH_ERR', url.slice(0, 120), e.message);
    }
    return { type: 'image', source: { type: 'url', url } };
  }
  return null;
}

async function userBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'image_url' || part.type === 'image') {
      const block = await imageBlock(part);
      if (block) blocks.push(block);
    }
  }
  return blocks;
}

function mergeMessages(messages) {
  const out = [];
  for (const message of messages) {
    const last = out[out.length - 1];
    if (last && last.role === message.role) last.content.push(...message.content);
    else out.push({ role: message.role, content: [...message.content] });
  }
  return out;
}

function anthropicTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const tool of tools) {
    if (!tool) continue;
    const fn = tool.function || tool;
    if (!fn.name) continue;
    out.push({
      name: fn.name,
      ...(fn.description ? { description: fn.description } : {}),
      input_schema: fn.parameters && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} },
    });
  }
  return out;
}

function anthropicToolChoice(choice) {
  if (!choice) return null;
  if (typeof choice === 'string') {
    if (choice === 'auto') return { type: 'auto' };
    if (choice === 'required' || choice === 'any') return { type: 'any' };
    if (choice === 'none') return { type: 'none' };
    return null;
  }
  if (choice.type === 'function' && choice.function && choice.function.name) {
    return { type: 'tool', name: choice.function.name };
  }
  if (choice.type === 'auto' || choice.type === 'any') return { type: choice.type };
  return null;
}

async function buildAnthropicRequest(body, upstream) {
  const systemParts = [];
  const messages = [];
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!message) continue;
    const role = message.role;
    if (role === 'system' || role === 'developer') {
      const text = textOf(message.content);
      if (text.trim()) systemParts.push(text);
      continue;
    }
    if (role === 'tool') {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: message.tool_call_id || '', content: textOf(message.content) }],
      });
      continue;
    }
    if (role === 'assistant') {
      const blocks = [];
      const text = textOf(message.content);
      if (text.trim()) blocks.push({ type: 'text', text });
      for (const call of message.tool_calls || []) {
        if (!call || !call.function) continue;
        let input = {};
        try {
          input = JSON.parse(call.function.arguments || '{}') || {};
        } catch {
          input = {};
        }
        blocks.push({
          type: 'tool_use',
          id: call.id || 'toolu_' + Math.random().toString(36).slice(2, 10),
          name: call.function.name || '',
          input,
        });
      }
      if (blocks.length) messages.push({ role: 'assistant', content: blocks });
      continue;
    }
    const blocks = await userBlocks(message.content);
    if (blocks.length) messages.push({ role: 'user', content: blocks });
  }
  if (!systemParts.length && typeof body.system === 'string' && body.system.trim()) {
    systemParts.push(body.system);
  }
  const merged = mergeMessages(messages);
  if (!merged.length) throw new Error('没有可发送的对话消息');
  const maxTokens = Math.max(
    1,
    Number(body.max_tokens) || Number(body.max_completion_tokens)
      || upstream.maxTokens || DEFAULT_ANTHROPIC_MAX_TOKENS,
  );
  const out = { model: body.model, max_tokens: maxTokens, stream: true, messages: merged };
  if (systemParts.length) out.system = systemParts.join('\n\n');
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  const tools = anthropicTools(body.tools);
  if (tools.length) out.tools = tools;
  const toolChoice = anthropicToolChoice(body.tool_choice);
  if (toolChoice) out.tool_choice = toolChoice;
  return out;
}

function mapStopReason(reason) {
  switch (reason) {
    case 'max_tokens': return 'length';
    case 'tool_use': return 'tool_calls';
    case 'refusal': return 'content_filter';
    case 'end_turn':
    case 'stop_sequence':
    default: return 'stop';
  }
}

async function pipeOpenAIStream(upstream, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const reader = upstream.body.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (!res.write(Buffer.from(value))) await new Promise((r) => res.once('drain', r));
  }
  res.end();
  log('DONE', 'bytes=' + bytes);
}

async function pipeAnthropicStream(upstream, res, model) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const decoder = new TextDecoder();
  const id = 'chatcmpl-' + Date.now().toString(36);
  const created = Math.floor(Date.now() / 1000);
  const toolByBlock = new Map();
  let toolIndex = -1;
  let streamModel = model;
  let finishReason = 'stop';
  let promptTokens = 0;
  let completionTokens = 0;
  let stopped = false;
  let errored = false;
  let buffer = '';

  const send = async (chunk) => {
    if (!res.write('data: ' + JSON.stringify(chunk) + '\n\n')) {
      await new Promise((r) => res.once('drain', r));
    }
  };
  const sendDelta = (delta) => send({
    id, object: 'chat.completion.chunk', created, model: streamModel,
    choices: [{ index: 0, delta, finish_reason: null }],
  });
  const sendFinish = (reason) => send({
    id, object: 'chat.completion.chunk', created, model: streamModel,
    choices: [{ index: 0, delta: {}, finish_reason: reason || 'stop' }],
  });
  const sendUsage = () => send({
    id, object: 'chat.completion.chunk', created, model: streamModel, choices: [],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  });

  const handleEvent = async (event) => {
    switch (event.type) {
      case 'message_start': {
        const message = event.message || {};
        if (message.model) streamModel = message.model;
        if (message.usage) {
          promptTokens = message.usage.input_tokens || 0;
          completionTokens = message.usage.output_tokens || 0;
        }
        await sendDelta({ role: 'assistant', content: '' });
        break;
      }
      case 'content_block_start': {
        const block = event.content_block || {};
        if (block.type === 'tool_use') {
          toolIndex += 1;
          toolByBlock.set(event.index, toolIndex);
          await sendDelta({
            tool_calls: [{
              index: toolIndex,
              id: block.id || '',
              type: 'function',
              function: { name: block.name || '', arguments: '' },
            }],
          });
        } else if (block.type === 'text' && block.text) {
          await sendDelta({ content: block.text });
        } else if (block.type === 'thinking' && block.thinking) {
          await sendDelta({ reasoning_content: block.thinking });
        }
        break;
      }
      case 'content_block_delta': {
        const delta = event.delta || {};
        if (delta.type === 'text_delta' && delta.text) {
          await sendDelta({ content: delta.text });
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          await sendDelta({ reasoning_content: delta.thinking });
        } else if (delta.type === 'input_json_delta' && delta.partial_json) {
          const index = toolByBlock.get(event.index);
          if (index !== undefined) {
            await sendDelta({ tool_calls: [{ index, function: { arguments: delta.partial_json } }] });
          }
        }
        break;
      }
      case 'message_delta': {
        if (event.usage && typeof event.usage.output_tokens === 'number') {
          completionTokens = event.usage.output_tokens;
        }
        finishReason = mapStopReason(event.delta && event.delta.stop_reason);
        break;
      }
      case 'message_stop': {
        await sendFinish(finishReason);
        await sendUsage();
        stopped = true;
        break;
      }
      case 'error': {
        const error = event.error || {};
        await send({ error: { message: error.message || '上游流式错误', type: error.type || 'stream_error', code: error.type } });
        errored = true;
        stopped = true;
        break;
      }
      default:
        break;
    }
  };

  try {
    for await (const value of upstream.body) {
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while (!stopped && (newline = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let event;
        try {
          event = JSON.parse(raw);
        } catch {
          continue;
        }
        await handleEvent(event);
      }
      if (stopped) break;
    }
    if (!stopped) {
      await sendFinish(finishReason);
      await sendUsage();
    }
  } catch (e) {
    log('ANTHROPIC_STREAM_ERR', e.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message } }));
      return;
    }
    if (!errored) await send({ error: { message: e.message, type: 'stream_error' } });
  }
  if (!res.writableEnded) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.includes('chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
    return;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"invalid json"}}');
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"invalid request body"}}');
    return;
  }
  const model = String(body.model || '');
  const auth = req.headers.authorization || '';
  const upstream = resolveUpstream(model, req.headers);
  log('REQ', 'model=' + model, 'msgs=' + (Array.isArray(body.messages) ? body.messages.length : 0),
    'images=' + countImages(body.messages), 'style=' + upstream.style, 'upstreams=' + upstream.urls.length,
    'tail=' + describeMessages(body.messages));
  if (!upstream.urls.length) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `没有找到模型 ${model} 的上游地址` } }));
    return;
  }
  let payload;
  let anthropicBody = null;
  try {
    if (upstream.style === 'anthropic') {
      anthropicBody = await buildAnthropicRequest(body, upstream);
      payload = JSON.stringify(anthropicBody);
    } else {
      payload = JSON.stringify({ ...body, stream: true });
    }
  } catch (e) {
    log('CONVERT_ERR', e.message);
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: e.message } }));
    return;
  }
  try {
    let response = null;
    let lastStatus = 502;
    let lastText = '';
    let maxTokensRetried = false;
    for (const candidate of upstream.urls) {
      response = await fetch(candidate, {
        method: 'POST',
        headers: upstream.style === 'anthropic' ? anthropicHeaders(auth) : openAIHeaders(auth),
        body: payload,
      });
      lastStatus = response.status;
      log('UPSTREAM', candidate, upstream.style, response.status, response.headers.get('content-type'));
      if (!response.ok && anthropicBody && response.status === 400
        && !maxTokensRetried && anthropicBody.max_tokens > 8192) {
        const text = await response.text();
        if (!/max_tokens/i.test(text)) {
          lastText = text;
          log('UPSTREAM_ERR', candidate, 400, text.slice(0, 200));
          break;
        }
        maxTokensRetried = true;
        log('RETRY_MAX_TOKENS', candidate, anthropicBody.max_tokens, '->', 8192);
        anthropicBody.max_tokens = 8192;
        payload = JSON.stringify(anthropicBody);
        response = await fetch(candidate, {
          method: 'POST',
          headers: anthropicHeaders(auth),
          body: payload,
        });
        lastStatus = response.status;
        log('UPSTREAM', candidate, upstream.style, response.status, response.headers.get('content-type'));
      }
      if (response.ok) break;
      lastText = await response.text();
      log('UPSTREAM_ERR', candidate, response.status, lastText.slice(0, 200));
      if (response.status !== 404 && response.status !== 405) break;
    }
    if (!response || !response.ok) {
      res.writeHead(lastStatus, { 'content-type': 'application/json' });
      res.end(lastText || '{"error":{"message":"upstream failed"}}');
      return;
    }
    if (upstream.style === 'anthropic') await pipeAnthropicStream(response, res, model);
    else await pipeOpenAIStream(response, res);
  } catch (e) {
    log('PROXY_ERR', e.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message } }));
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => log('BYOK bridge listening on http://' + HOST + ':' + PORT));
