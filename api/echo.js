// 临时诊断端点：确认 Vercel Node 函数 req 形态与 POST body 读取。定位后删除。
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  const meta = {
    region: process.env.VERCEL_REGION || '?',
    method: req.method,
    hasOn: typeof req.on,
    ctor: (req && req.constructor && req.constructor.name) || typeof req,
    hasJson: typeof (req && req.json)
  };
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, ...meta });
    return;
  }
  try {
    const b = await readBody(req);
    res.status(200).json({ ok: true, got: b, ...meta });
  } catch (e) {
    res.status(500).json({ ok: false, err: e.name + ': ' + e.message, ...meta });
  }
}
