# -*- coding: utf-8 -*-
"""
拼音确定性后处理（规则明确，避免模型连写不稳定）：
A) 完整句（line，或 zh 含句末标点）拼音句首字母大写；词条保持原样。
B) 数词 + 容器/个体/集体量词 之间补空格（正词法分写），如 liǎngshuāng->liǎng shuāng、yībēi->yī bēi、yīgè->yí gè(本调 yī gè)。
   不拆 百/千/万/十 复合数词（bǎi/qiān/wàn 不在量词表），不拆 一点 yīdiǎn / 一些 yīxiē 等固定副词。
C) 去掉拼音音节之间误入的句点（lěng.guì -> lěngguì）。
默认 dry-run 打印变更样例；--write 落盘。
"""
import os, io, json, glob, re, sys
WORK = os.path.dirname(os.path.abspath(__file__))
CONTENT = os.path.normpath(os.path.join(WORK, "..", "..", "_content"))
sys.path.insert(0, WORK)
from translate_pipeline import collect
WRITE = "--write" in sys.argv
SENT_END = re.compile(r"[。！？!?…]")
TONELET = "a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňǹḿm̀"
# 数词（本调/变调）
NUM = r"(?:yī|yí|yì|liǎng|èr|sān|sì|wǔ|liù|qī|bā|jiǔ|shí)"
# 容器/个体/集体量词（带调或轻声）；不含 百bǎi/千qiān/万wàn、点diǎn、些xiē
MW = (r"(?:gè|ge|wèil|wèi|míng|kǒu|tóu|pǐ|zhī|zhū|kē|lì|duǒ|kē|gēn|zhī|tiáo|zhāng|piàn|běn|bǎ|jià|liàng|tái|dǐng|fēng|zé|piān|shǒu|"
      r"jiàn|jiàn|tào|shuāng|fù|duì|fèn|bāo|bēi|píng|wǎn|dié|pán|hé|guàn|tǒng|hú|lóng|chuàn|dāo|dīng|kuài|"
      r"jiā|suǒ|dòng|zhuàng|jiān|céng|lóu|chù|suǒ|sōu|táng|dào|dùn|chǎng|cì|tàng|huí|zhèn|qún|zǔ|duī|pī|luó|dǎ|qǐ|zōng|juǎn|bǒ|lán)")
MW = r"(?:gè|ge|wèi|míng|kǒu|tóu|pǐ|zhū|kē|lì|duǒ|gēn|tiáo|zhāng|piàn|běn|bǎ|jià|liàng|tái|dǐng|fēng|zé|piān|shǒu|tào|shuāng|fù|duì|fèn|bāo|bēi|píng|wǎn|dié|pán|hé|guàn|tǒng|hú|lóng|chuàn|kuài|jiā|suǒ|zhuàng|céng|dào|dùn|chǎng|cì|tàng|huí|qún|zǔ|duī|pī|dǎ|juǎn)"
NUM_MW = re.compile(r"(?<![A-Za-zÀ-ǿ])(" + NUM + r")(" + MW + r")(?![A-Za-zÀ-ǿ])")
# 特例：本调/二声的「一件」是数词+量词（意见 yìjiàn 为名词，四声 yì，不动）；「一栋」数据无需求，移动 yídòng 不动
SPECIAL = [(re.compile(r"\byījiàn\b"), "yī jiàn"), (re.compile(r"\byíjiàn\b"), "yí jiàn"),
           (re.compile(r"\bnǐhǎo\b"), "nǐ hǎo")]
DOT = re.compile(r"([" + TONELET + r"])\.([" + TONELET + r"])")

def fix_pinyin(py, is_sent):
    s = py
    s2 = DOT.sub(r"\1\2", s)
    # 数词量词分写（可能多处）
    s2 = NUM_MW.sub(lambda m: m.group(1) + " " + m.group(2), s2)
    for rx, rep in SPECIAL:
        s2 = rx.sub(rep, s2)
    if is_sent:
        t = s2.lstrip()
        if t and t[0].isalpha() and t[0].islower():
            s2 = s2[:len(s2)-len(t)] + t[0].upper() + t[1:]
    return s2

changes = []
for fp in sorted(glob.glob(os.path.join(CONTENT, "*.json"))):
    name = os.path.basename(fp)
    raw = io.open(fp, encoding="utf-8").read()
    indent = 0 if "\n" in raw and not re.search(r"\n \"", raw) else (2 if re.search(r"\n  \"", raw) else None)
    data = json.loads(raw)
    units = []; collect(data, units)
    nf = 0
    for d, kind in units:
        pk = 'py' if kind == 'tri' else 'pinyin'
        zk = 'zh' if kind == 'tri' else 'text'
        zh = d.get(zk) or ""
        old = d.get(pk) or ""
        is_sent = (kind == 'line') or bool(SENT_END.search(zh))
        new = fix_pinyin(old, is_sent)
        if new != old:
            nf += 1
            if len(changes) < 60: changes.append((name, zh.strip(), old, new))
            if WRITE: d[pk] = new
    print(f"{name:26s} 拼音修正 {nf}")
    if WRITE and nf:
        with io.open(fp, "w", encoding="utf-8", newline="") as f:
            json.dump(data, f, ensure_ascii=False, indent=indent)
print("\n== 变更样例 ==")
for nm, zh, o, n in changes:
    print(f"  [{nm}] {zh}\n     {o}  ->  {n}")
print(("\n已落盘。" if WRITE else "\n(dry-run，加 --write 落盘)"))
