# -*- coding: utf-8 -*-
"""
HanVerse 翻译质量管线（MiniMax-Text-Text-01, api.minimax.chat）
- 递归收集 _content 全部中英对照（tri: zh/py/en；line: text/pinyin/en）
- 按中文原文去重，批量校对/重译（自动区分「字词/短语词条」与「完整句子」）
- 断点缓存 translation_cache.json；并发 + 指数退避 + 拆批兜底
用法：
  python translate_pipeline.py --limit 40      # 小批量自测
  python translate_pipeline.py                 # 全量
"""
import os, io, json, glob, re, sys, time, argparse, threading
import urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

WORK = os.path.dirname(os.path.abspath(__file__))
CONTENT = os.path.normpath(os.path.join(WORK, "..", "..", "_content"))
CACHE = os.path.join(WORK, "translation_cache.json")
FAILED = os.path.join(WORK, "translation_failed.json")
URL = "https://api.minimax.chat/v1/text/chatcompletion_v2"
MODEL = "MiniMax-Text-01"
KEY = os.environ.get("MINIMAX_API_KEY", "")
HAN = lambda s: isinstance(s, str) and any('一' <= ch <= '鿿' for ch in s)

SYSTEM = """You are a senior editor for a teach-Chinese-as-a-foreign-language course AND a native-level Chinese<->English translator.
You receive Chinese items used on a language-learning app for English-speaking beginners in China. For EACH item you output: the natural simplified Chinese (zh), accurate Hanyu Pinyin with tone marks (py), and idiomatic American English (en).

Decide whether each item is a WORD/PHRASE entry or a FULL SENTENCE:

A) Single character / word / short phrase (a vocabulary entry):
- en = a concise dictionary gloss. You MAY use "/" between near-synonyms (e.g. "have / there is", "to be", "a pair of").
- Do NOT add sentence punctuation or capitalize (keep it as a dictionary headword), e.g. zh "妈" -> en "mom".
- Measure words stay as phrases: zh "一副" -> en "a pair of"; zh "瓶" -> en "bottle (measure word)".

B) Full sentence OR an elliptical spoken sentence used when shopping / ordering / chatting (e.g. "请给我三瓶。", "来两份这个。", "我是英国人。"):
- en MUST be a complete, natural, grammatically-correct spoken sentence, capitalized with correct ending punctuation.
- Fill an elided object naturally OR use an intransitive phrasing: "请给我三瓶。" -> "Three bottles, please." / "Can I get three bottles?"  NEVER leave a dangling preposition: NOT "bottles of.", NOT "pairs of.", NOT "a ticket of.".
- Correct morphology: nationalities use American/British/Canadian/Australian/French/German/Spanish/Japanese/Korean (NEVER "Britainn", "Canadan", "Francen", "Germanyn"); comparatives use "more convenient/quiet/expensive" (NEVER "convenienter/expensiver"), irregular forms "better/worse/farther".
- Match speaker intent and politeness, keep it short and natural for travel/daily life.
- Facilities ("X 坏了"): devices use "The X isn't working." (the toilet / AC / TV / light / elevator); utilities use "There's no hot water.", "The internet is down.", "The power is out.", "The air conditioning isn't working." — NEVER "the hot water is broken" or "the internet is broken".
- If the Chinese itself is an incomplete, awkward or nonsensical machine-stitched sentence, REWRITE it to the most natural short sentence for that clear intent before translating, e.g. "我叫朋友" (name-pattern wrongly fused with a relationship word) -> "这是我朋友。" / "This is my friend."; a self-introduction of a name -> "我叫……". Preserve the same topic, speaker intent and a similar short length.

Pinyin rules:
- Correct tone marks, word-by-word grouping (词儿连写), neutral tone unstressed and toneless, natural erhua (yīdiǎnr), capitalization only for sentence-initial pinyin and proper nouns; keep punctuation aligned with the Chinese.

Chinese (zh):
- If the original Chinese is natural and correct, return it UNCHANGED. Only minimally polish it if it is genuinely awkward or ungrammatical; never change the teaching meaning, numbers, names or the item's length/scope.

Fixed terms (keep these exact forms): WeChat, Alipay, Kung Pao, Mapo tofu, fapiao (official receipt), jin (500g), yuan/kuai, official Pinyin place names (e.g. Ji'an, Beijing).

Output ONLY a JSON array, EXACTLY the same length and order as the input. Each element: {"i": <input index int>, "zh": "...", "py": "...", "en": "..."}. No markdown, no commentary."""

# ---------- 收集 ----------
def collect(node, out):
    if isinstance(node, dict):
        if 'zh' in node and 'en' in node:
            out.append((node, 'tri'))
        elif 'text' in node and 'en' in node and 'pinyin' in node and HAN(node.get('text')):
            out.append((node, 'line'))
        for v in node.values():
            collect(v, out)
    elif isinstance(node, list):
        for v in node:
            collect(v, out)

def gather_unique():
    uniq = {}
    for fp in sorted(glob.glob(os.path.join(CONTENT, "*.json"))):
        data = json.load(io.open(fp, encoding="utf-8"))
        units = []; collect(data, units)
        for d, kind in units:
            z = (d.get('zh') if kind == 'tri' else d.get('text')) or ""
            z = z.strip()
            if z and z not in uniq:
                p = d.get('py') if kind == 'tri' else d.get('pinyin')
                e = d.get('en')
                uniq[z] = {"py": (p or "").strip(), "en": (e or "").strip()}
    return uniq

# ---------- 缓存 ----------
lock = threading.Lock()
def load_cache():
    if os.path.exists(CACHE):
        return json.load(io.open(CACHE, encoding="utf-8"))
    return {}
def save_cache(cache):
    tmp = CACHE + ".tmp"
    with io.open(tmp, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=1)
    os.replace(tmp, CACHE)

# ---------- API ----------
def api(messages, max_tokens, timeout=90):
    body = {"model": MODEL, "messages": messages, "temperature": 0.2,
            "max_tokens": max_tokens}
    req = urllib.request.Request(URL, data=json.dumps(body).encode("utf-8"), method="POST")
    req.add_header("Authorization", "Bearer " + KEY)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        j = json.loads(r.read().decode("utf-8"))
    if not j.get("choices"):
        raise RuntimeError("upstream error: %s" % j.get("base_resp"))
    return j

def extract_array(text, expect):
    t = text.strip()
    t = re.sub(r"^```(?:json)?|```$", "", t, flags=re.M).strip()
    # 优先整体 json_object（可能 {"results":[...]} 或直接数组）
    try:
        j = json.loads(t)
        if isinstance(j, list): return j
        if isinstance(j, dict):
            for k in ("results","items","data","translations"):
                if isinstance(j.get(k), list): return j[k]
    except Exception: pass
    a, b = t.find("["), t.rfind("]")
    if a >= 0 and b > a:
        return json.loads(t[a:b+1])
    raise ValueError("no json array")

def translate_batch(items, max_tokens, tries=4):
    """items: [(i, zh)] -> {zh_input: {zh,py,en}}"""
    payload = [{"i": i, "zh": z} for i, z in items]
    user = ("Translate / proofread these %d Chinese items. Return ONLY the JSON array described, "
            "same length & order, keys i/zh/py/en.\n" % len(items)) + json.dumps(payload, ensure_ascii=False)
    last = None
    for at in range(tries):
        try:
            resp = api([{"role": "system", "content": SYSTEM},
                        {"role": "user", "content": user}], max_tokens=max_tokens)
            content = resp["choices"][0]["message"]["content"]
            arr = extract_array(content, len(items))
            if not isinstance(arr, list) or len(arr) != len(items):
                raise ValueError("len mismatch %s != %s" % (None if arr is None else len(arr), len(items)))
            out = {}
            for idx, row in enumerate(arr):
                i_in = row.get("i", idx)
                z2 = str(row.get("zh", "")).strip(); p2 = str(row.get("py", "")).strip(); e2 = str(row.get("en", "")).strip()
                if not z2 or not e2: raise ValueError("empty field at %s" % i_in)
                out[items[idx][1]] = {"zh": z2, "py": p2, "en": e2}
            if len(out) != len(items): raise ValueError("key mismatch")
            return out
        except Exception as e:
            last = e
            time.sleep(1.5 * (at + 1))
    raise RuntimeError("batch failed after retries: %s" % last)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch-size", type=int, default=25)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    uniq = gather_unique()
    cache = load_cache()
    pending = [z for z in uniq if z not in cache]
    print("唯一中文串:", len(uniq), "| 已缓存:", len(uniq) - len(pending), "| 待译:", len(pending))
    if args.limit:
        pending = pending[:args.limit]
        print("(自测模式) 本次只处理:", len(pending))

    batches = [pending[i:i+args.batch_size] for i in range(0, len(pending), args.batch_size)]
    # 大批次 max_tokens
    mt = max(2500, args.batch_size * 170)
    done = 0; failed = []
    save_every = 0
    def work(batch):
        try:
            return translate_batch(list(enumerate(batch)), max_tokens=mt)
        except Exception:
            # 拆成单条兜底
            res = {}; errs = []
            for z in batch:
                try:
                    r = translate_batch([(0, z)], max_tokens=400)
                    res.update(r)
                except Exception as e:
                    errs.append((z, str(e)))
            return res, errs if errs else None
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(work, b): b for b in batches}
        for fut in as_completed(futs):
            b = futs[fut]
            try:
                r = fut.result()
                errs = None
                if isinstance(r, tuple): r, errs = r
                with lock:
                    cache.update(r); done += len(r)
                    if errs: failed.extend(errs)
                    save_every += 1
                    if save_every >= 3:
                        save_cache(cache); save_every = 0
                print(f"  进度 {done}/{len(pending)}  本批 {len(r)}" + (f"  失败 {len(errs) if errs else 0}" if errs else ""))
            except Exception as e:
                print("  批次彻底失败:", e)
                failed.extend([(z, str(e)) for z in b])
    with lock:
        save_cache(cache)
    if failed:
        io.open(FAILED, "w", encoding="utf-8").write(json.dumps(failed, ensure_ascii=False, indent=1))
        print("⚠️ 失败", len(failed), "条 ->", FAILED)
    print("完成。缓存总条数:", len(cache), "| 本次新译:", done, "| 失败:", len(failed))

if __name__ == "__main__":
    main()
