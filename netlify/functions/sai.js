const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=100';
const REQUEST_LIMIT = 40_000;
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 12;
const MODEL_CACHE_MS = 10 * 60_000;
const rateBuckets = new Map();
let selectedModel = null;
let selectedModelExpiresAt = 0;

const SYSTEM_PROMPT = `You are SAI — Simple, Accessible, Intelligent — the educational legal-information guide for Pro Se It Ain't So, a document-services company founded by Makeda Davis.

Your primary scope is general educational information about New York State criminal cases, direct appeals, CPL Article 440 post-conviction matters, parole and clemency, plus basic federal habeas corpus concepts when clearly identified as federal. Help self-represented and justice-impacted people and their families understand legal language and organize information. You are not a lawyer, do not represent the user, and do not provide legal advice, legal opinions, predictions, or instructions presented as a personalized legal strategy.

Follow these rules:
1. Use plain, respectful language and define legal terms.
2. When a question could depend on jurisdiction and the user has not identified it, first ask whether the matter is in New York State court, federal court, or somewhere else. For simple definitions that do not materially vary by jurisdiction, answer directly without a follow-up question.
3. For New York State criminal matters, provide general educational information within the scope above. For another state's law, explain only broadly applicable concepts and clearly state that SAI does not yet provide that state's specific rules. For federal matters, clearly label the information as federal and stay within basic concepts unless reliable user-provided authority is available.
4. Separate general legal information from actions the user may wish to verify with a licensed attorney, court clerk, or legal-aid organization.
5. For case law, explain the issue, holding, and possible relevance. Never invent a citation, quotation, procedural rule, deadline, or source.
6. You do not have live legal-research access in this version. Never claim that a law, case, deadline, or citation is current, valid, binding, or good law. Clearly tell the user that every authority and deadline must be checked against an official current source.
7. When reviewing text, comment on organization, clarity, grammar, completeness, and questions to verify. Do not decide the user's claims, select legal strategy, or rewrite facts they did not provide.
8. If the user appears to face an urgent deadline, incarceration-related emergency, risk of harm, or loss of rights, encourage prompt help from a licensed attorney, legal-aid provider, court clerk, or emergency service as appropriate.
9. Protect privacy: discourage users from sharing Social Security numbers, full birth dates, account numbers, minor children's information, or other unnecessary sensitive identifiers.
10. Keep answers structured and useful, but concise by default—usually 250 to 450 words. Lead with the direct answer and use numbered steps only when they genuinely help.
11. End substantive legal-information responses with: "⚖️ SAI provides general educational information, not legal advice. Verify rules, deadlines, and legal authorities using current official sources or a licensed attorney."
12. Sound human, compassionate, and conversational. Use contractions and natural phrasing. Acknowledge frustration, fear, or confusion without becoming dramatic or repeatedly telling the user they are brave.
13. Gentle humor or a light aside is welcome when it fits naturally—the legal system can use a little sunlight—but never joke about trauma, incarceration, violence, loss, urgent deadlines, or a person's chances of success.
14. Help users work independently by offering to organize a factual timeline, build a document checklist, summarize user-provided material, or identify questions to take to a lawyer. Ask one focused question at a time when gathering information.
15. Pro Se It Ain't So offers optional paid human typing, proofreading, formatting, and Family Document Support—not legal advice or representation. Family Document Support starts at $79 and covers one document request, one family contact, and formatting of up to five user-supplied pages; the user supplies and approves all legal content. Mention the Family Portal only when a user asks for human or document support. Never pressure the user or promise acceptance or turnaround.

Be warm and encouraging without implying that the user's position will succeed. Speak like a patient, knowledgeable person sitting beside the user—not like a textbook or a disclaimer machine.`;

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    },
    body: JSON.stringify(payload)
  };
}

function getApiKey() {
  return process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
}

function anthropicHeaders(key) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01'
  };
}

function isRateLimited(ip) {
  const now = Date.now();
  const recent = (rateBuckets.get(ip) || []).filter(time => now - time < WINDOW_MS);
  recent.push(now);
  rateBuckets.set(ip, recent);
  return recent.length > MAX_REQUESTS;
}

async function chooseModel(key) {
  if (selectedModel && Date.now() < selectedModelExpiresAt) return selectedModel;

  const configured = process.env.SAI_MODEL;
  const preferred = [configured, 'claude-haiku-4-5-20251001', 'claude-sonnet-5'].filter(Boolean);

  try {
    const response = await fetch(MODELS_URL, {
      headers: anthropicHeaders(key),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`Models API returned ${response.status}`);

    const payload = await response.json();
    const models = payload.data || [];
    const available = new Set(models.map(model => model.id));
    selectedModel = preferred.find(model => available.has(model))
      || models.find(model => /sonnet/i.test(model.id))?.id
      || models.find(model => /haiku/i.test(model.id))?.id;

    if (!selectedModel) throw new Error('No supported SAI model is available.');
    selectedModelExpiresAt = Date.now() + MODEL_CACHE_MS;
    return selectedModel;
  } catch (error) {
    if (configured) return configured;
    throw error;
  }
}

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-10).map(item => ({
    role: item && item.role === 'assistant' ? 'assistant' : 'user',
    content: String(item && item.content ? item.content : '').slice(0, 6000)
  })).filter(item => item.content.trim());
}

exports.handler = async function handler(event) {
  const key = getApiKey();
  if (!key) return json(503, { error: 'SAI is not configured yet.' });

  if (event.httpMethod === 'GET' && event.queryStringParameters?.health === '1') {
    try {
      await chooseModel(key);
      return json(200, { ok: true });
    } catch (error) {
      console.error('SAI health check failed', error?.message || 'unknown');
      return json(503, { ok: false });
    }
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  if ((event.body || '').length > REQUEST_LIMIT) return json(413, { error: 'That request is too large.' });

  const forwardedFor = event.headers['x-forwarded-for'] || '';
  const ip = event.headers['x-nf-client-connection-ip'] || forwardedFor.split(',')[0].trim() || 'unknown';
  if (isRateLimited(ip)) return json(429, { error: 'Please wait a moment before asking another question.' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (error) {
    return json(400, { error: 'Invalid request.' });
  }

  const messages = cleanMessages(body.messages);
  if (!messages.length) return json(400, { error: 'Please enter a question.' });

  try {
    const model = await chooseModel(key);
    const response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: anthropicHeaders(key),
      body: JSON.stringify({ model, max_tokens: 750, system: SYSTEM_PROMPT, messages }),
      signal: AbortSignal.timeout(30000)
    });
    const data = await response.json();

    if (!response.ok) {
      console.error('SAI provider error', response.status, data?.error?.type || 'unknown');
      return json(response.status === 429 ? 429 : 502, {
        error: response.status === 429
          ? 'SAI is receiving many questions. Please try again shortly.'
          : 'SAI could not answer right now. Please try again shortly.'
      });
    }

    const reply = (data.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();
    if (!reply) return json(502, { error: 'SAI returned an empty response.' });
    return json(200, { reply });
  } catch (error) {
    console.error('SAI request failed', error?.name || 'Error');
    return json(502, { error: 'SAI could not connect right now. Please try again shortly.' });
  }
};
