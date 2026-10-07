# -*- coding: utf-8 -*-
"""
把 translation_cache.json 按中文原文回填到 _content 全部 JSON。
tri(zh/py/en) 与 line(text/pinyin/en) 分别写字段；保持原缩进。
默认 dry-run 只报告；加 --write 落盘。
"""
import os, io, json, glob, re, sys
WORK = os.path.dirname(os.path.abspath(__file__))
CONTENT = os.path.normpath(os.path.join(WORK, "..", "..", "_content"))
sys.path.insert(0, WORK)
from translate_pipeline import collect, CACHE

WRITE = "--write" in sys.argv
cache = json.load(io.open(CACHE, encoding="utf-8"))
print("缓存条数:", len(cache), "| 模式:", "WRITE 落盘" if WRITE else "dry-run")

def detect_indent(raw):
    m = re.search(r"\n( +)\"", raw)
    if m: return len(m.group(1))
    return 0 if "\n" in raw else None

grand_hit = grand_miss = grand_zhchg = 0
for fp in sorted(glob.glob(os.path.join(CONTENT, "*.json"))):
    name = os.path.basename(fp)
    raw = io.open(fp, encoding="utf-8").read()
    indent = detect_indent(raw)
    data = json.loads(raw)
    units = []; collect(data, units)
    hit = miss = zhchg = 0
    miss_samples = []
    for d, kind in units:
        zk = 'zh' if kind == 'tri' else 'text'
        pk = 'py' if kind == 'tri' else 'pinyin'
        orig = (d.get(zk) or "").strip()
        v = cache.get(orig)
        if not v:
            miss += 1
            if len(miss_samples) < 5: miss_samples.append(orig)
            continue
        hit += 1
        if v.get("zh", "").strip() and v["zh"].strip() != orig:
            zhchg += 1
        d[zk] = v.get("zh", orig).strip()
        d[pk] = v.get("py", "").strip()
        d["en"] = v.get("en", "").strip()
    grand_hit += hit; grand_miss += miss; grand_zhchg += zhchg
    print(f"{name:26s} 命中={hit:4d} 缺失={miss:4d} 中文润色={zhchg:3d} indent={indent}")
    for s in miss_samples: print("     缺失:", s[:30])
    if WRITE and hit:
        with io.open(fp, "w", encoding="utf-8", newline="") as f:
            json.dump(data, f, ensure_ascii=False, indent=indent)
print(f"\n合计 命中={grand_hit} 缺失={grand_miss} 中文被润色={grand_zhchg}")
if grand_miss:
    print("⚠️ 有缺失，说明翻译未全部完成或存在 failed，暂不应构建/部署。")
if WRITE:
    print("已写回 _content。下一步：python build.py")
