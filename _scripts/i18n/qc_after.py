# -*- coding: utf-8 -*-
"""
回填后二次 QC（精准版，区分词条/句子，规避合法语法误报）：
- line 按句子；tri 以中文句末标点判定句子。
- 悬空功能词：仅陈述句（非问号）以 of/a/an/the/for/with/and/or 结尾（疑问句句末介词合法、代词结尾合法）。
- 国籍：只报错误词形（Britainn/Canadan/Francen/Germayn）或国名原形直接作表语。
- 比较级：只报 more+真正比较级 的双重比较级，或明确错误的多音节+er。
- 设施 broken：仅流体/服务（hot water/internet/power/gas/AC/heating）后紧跟 broken；实物 pipe/toilet 合法。
- 拼音：仅当中文含汉字且拼音无调才报（Smith/WiFi/42/T2/A12345 等拉丁/数字条跳过）。
导出 qc_issues.json。
"""
import os, io, json, glob, re, sys
from collections import Counter
WORK = os.path.dirname(os.path.abspath(__file__))
CONTENT = os.path.normpath(os.path.join(WORK, "..", "..", "_content"))
sys.path.insert(0, WORK)
from translate_pipeline import collect

TONE = re.compile(r"[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜĀÁǍÀĒÉĚÈĪÍǏÌŌÓǑÒŪÚǓÙ]")
HAN_RE = re.compile(r"[一-鿿]")
SENT_END = re.compile(r"[。！？!?…]")
# 陈述句末尾悬空功能词（疑问句句末介词合法，故排除 ?）
DANGLING_STMT = re.compile(r"\b(of|a|an|the|for|with|and|or)\s*[.…!]\s*$", re.I)
# 错误国籍：错误后缀，或国名原形直接作表语（后紧跟标点/结束）
BAD_NATION = re.compile(r"\b(Britainn|Canadan|Francen|Germanyn|Americann|Australinn|Spainn|Japann|Koreann|Chinan|New Zealan)\b", re.I)
NATION_RAW = re.compile(r"(?:I'?m|I am|He'?s|She'?s|They'?re|We'?re|are)\s+(America|Britain|Canada|France|Germany|Spain|Japan|Korea|Australia|China|New Zealand)\s*[.,!?…]\s*$", re.I)
# 双重比较级 more + 真正比较级；明确错误多音节+er
DOUBLE_COMP = re.compile(r"\bmore\s+(better|worse|quieter|cheaper|faster|easier|bigger|smaller|larger|nicer|safer|cleaner|brighter|happier|heavier|hotter|colder|warmer|newer|older|younger|taller|shorter|longer|stronger|weaker|busier|simpler|wider|narrower)\b", re.I)
BAD_COMP = re.compile(r"\b(convenienter|expensiver|boringer|difficulter|importanter|comfortabler|farrer)\b", re.I)
# 流体/服务 + broken（实物 pipe/toilet/TV 不算）
UTIL_BROKEN = re.compile(r"\b(hot water|running water|cold water|the internet|internet|wi-?fi|the power|power|electricity|the gas|gas|air conditioning|\bAC\b|the heating|heating)\s+(?:is|was|keeps|seems?\s+to\s+be)\s+broken\b", re.I)
NEUTRAL = set("的了吗呢吧啊呀哦嘛们子地得")

def is_sentence(zh, kind):
    return kind == 'line' or bool(SENT_END.search(zh))

def pinyin_toneless(zh, py):
    """中文含汉字、拼音较长却无调 => 异常；纯拉丁/数字/编号跳过。"""
    if not HAN_RE.search(zh): return False
    core = zh.strip()
    if len(core) >= 2 and all(c in NEUTRAL for c in core): return False
    body = re.sub(r"\b(ma|ne|a|ba|de|le|zi|men|ya|wa|o|ê)\b", "", py)
    return len(body) > 6 and not TONE.search(py)

def qc_sentence(zh, py, en):
    iss = []; e = en.strip(); low = e.lower()
    is_q = low.endswith("?")
    if not is_q and DANGLING_STMT.search(e):
        iss.append("悬空功能词:" + DANGLING_STMT.search(e).group(1))
    if BAD_NATION.search(e) or NATION_RAW.search(e): iss.append("国籍词形")
    if DOUBLE_COMP.search(e) or BAD_COMP.search(e): iss.append("错误比较级")
    if UTIL_BROKEN.search(e): iss.append("设施broken")
    if not re.search(r"[.!?…\"')\]]\s*$", e): iss.append("句子缺标点")
    if "  " in e: iss.append("双空格")
    if len(''.join(c for c in e if HAN_RE.match(c))) >= 2: iss.append("en含中文")
    if pinyin_toneless(zh, py): iss.append("拼音无声调")
    zc = len(HAN_RE.findall(zh)); ew = len(e.split())
    if zc >= 5 and (ew < zc * 0.25 or ew > zc * 6): iss.append("长度异常")
    return iss

def qc_word(zh, py, en):
    iss = []
    if len(''.join(c for c in en if HAN_RE.match(c))) >= 2: iss.append("en含中文")
    if pinyin_toneless(zh, py): iss.append("拼音无声调")
    return iss

issues = {}; counts = Counter()
for fp in sorted(glob.glob(os.path.join(CONTENT, "*.json"))):
    data = json.load(io.open(fp, encoding="utf-8"))
    units = []; collect(data, units)
    for d, kind in units:
        zh = (d.get('zh') if kind == 'tri' else d.get('text')) or ""
        py = (d.get('py') if kind == 'tri' else d.get('pinyin')) or ""
        en = d.get('en') or ""
        zh, py, en = zh.strip(), py.strip(), en.strip()
        if not zh or not py or not en:
            lst = ["空字段"]
        elif is_sentence(zh, kind):
            lst = qc_sentence(zh, py, en)
        else:
            lst = qc_word(zh, py, en)
        for x in lst: counts[x.split(":")[0]] += 1
        if lst and zh not in issues:
            issues[zh] = {"zh": zh, "py": py, "en": en, "problems": sorted(set(x.split(":")[0] for x in lst))}

print("== 回填后 QC（精准）问题分布 ==")
for k, v in counts.most_common(): print(f"  {v:5d}  {k}")
print("去重后待修复条目:", len(issues))
io.open(os.path.join(WORK, "qc_issues.json"), "w", encoding="utf-8").write(
    json.dumps(list(issues.values()), ensure_ascii=False, indent=1))
for x in list(issues.values()):
    print(f"  [{'/'.join(x['problems'])}] {x['zh']}  ==>  {x['en']}")
