// 临时诊断端点：并行探测多个 LLM endpoint 的可达性（无密钥，HTTP 响应即视为网络通）。定位后删除。
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' TIMEOUT ' + ms + 'ms')), ms))
  ]);
}

const TARGETS = [
  ['ark-bj',      'https://ark.cn-beijing.volces.com/api/v3/chat/completions', 'POST'],
  ['byteplus-sg', 'https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions', 'POST'],
  ['deepseek',    'https://api.deepseek.com/v1/chat/completions', 'POST'],
  ['openai',      'https://api.openai.com/v1/chat/completions', 'POST'],
  ['example',     'https://example.com', 'GET']
];

async function probe([name, url, method]) {
  const t = Date.now();
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (method === 'POST') opts.body = JSON.stringify({ model: 'probe', messages: [] });
    const r = await withTimeout(fetch(url, opts), 7000, name);
    let txt = '';
    try { txt = (await r.text()).slice(0, 180); } catch (e) { txt = '(no body)'; }
    return { name, ok: true, status: r.status, ms: Date.now() - t, body: txt };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t,
             error: e.name + ': ' + e.message, code: e.code || (e.cause && e.cause.code) || undefined };
  }
}

export default async function handler(req, res) {
  const results = await Promise.all(TARGETS.map(probe));
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({ region: process.env.VERCEL_REGION || 'unknown', node: process.version, results });
}
