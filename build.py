# -*- coding: utf-8 -*-
"""HanVerse 构建脚本：把 _content/*.json 合并进 index.html 的四个数据占位符。"""
import io
import json
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
CONTENT_DIR = os.path.join(BASE, "_content")
INDEX_TPL = os.path.join(BASE, "_templates", "index.template.html")  # 只读模板（含占位符）
INDEX_OUT = os.path.join(BASE, "index.html")  # 构建产物（合并后）

SCENE_FILES = [
    "scenes-arrival.json", "scenes-food.json", "scenes-transport.json",
    "scenes-shopping.json", "scenes-living.json", "scenes-health.json",
    "scenes-social.json", "scenes-errands.json", "scenes-leisure.json",
    "scenes-work.json",
]

# 数据契约中的每分类场景 id 清单，用于构建期校验
EXPECTED = {
    "arrival": ["airport", "customs", "hotel-checkin", "hotel-service", "sim-card", "wifi", "luggage-storage", "ask-direction", "check-out", "lost-items"],
    "food": ["noodle-shop", "pay-bill", "milk-tea", "coffee", "restaurant-order", "takeout-order", "hotpot", "breakfast-stall", "receive-delivery", "reserve-table"],
    "transport": ["subway", "taxi", "bus", "high-speed-rail", "flight-checkin", "ride-hailing", "bike-share", "transfer-ask", "long-distance-bus", "airport-bus"],
    "shopping": ["market", "supermarket", "convenience-store", "clothes-store", "shoe-store", "souvenir-shop", "night-market", "refund-exchange", "mall-navigation", "electronics-store"],
    "living": ["house-viewing", "utilities-bill", "home-repair", "parcel-delivery", "laundry", "hairdresser", "noise-complaint", "send-parcel", "community-gate", "internet-install"],
    "health": ["pharmacy", "hospital-register", "doctor-visit", "dental", "emergency", "optician", "massage", "gym-signup", "blood-test", "health-appointment"],
    "social": ["meet-friends", "gift-giving", "dinner-invite", "ktv", "birthday-party", "wedding", "small-talk", "compliment", "apology", "farewell"],
    "errands": ["bank-account", "atm", "post-office", "visa-extension", "phone-topup", "police-station", "lost-id", "print-shop", "rental-contract", "government-window"],
    "leisure": ["movie-ticket", "museum", "park-walk", "concert", "sightseeing-ticket", "photo-help", "escape-room", "hiking", "night-view", "game-center"],
    "work": ["job-interview", "office-intro", "meeting", "coworker-lunch", "class-questions", "homework", "library", "campus-navigation", "internship", "business-card"],
}


def load_json(path):
    with io.open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _read_md(path):
    try:
        with io.open(path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def js_dump(obj):
    s = json.dumps(obj, ensure_ascii=False, indent=2)
    # JSON -> 内嵌 JS 的安全处理：避免 </script> 与行分隔符破坏 HTML/JS
    s = s.replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    return s


def main():
    errors = []

    # 1. 合并场景
    scenes = {}
    per_cat = {}
    for fname in SCENE_FILES:
        path = os.path.join(CONTENT_DIR, fname)
        data = load_json(path)
        cat = fname.replace("scenes-", "").replace(".json", "")
        ids = list(data.keys())
        per_cat[cat] = ids
        for sid, s in data.items():
            if s.get("category") != cat:
                errors.append(f"[{fname}] 场景 {sid} 的 category={s.get('category')} 与文件分类 {cat} 不符")
            scenes[sid] = s

    for cat, expect in EXPECTED.items():
        got = per_cat.get(cat, [])
        if got != expect:
            errors.append(f"[{cat}] id 清单不符：缺 {set(expect)-set(got)}，多 {set(got)-set(expect)}")

    # 2. 合并专题
    chinese101 = load_json(os.path.join(CONTENT_DIR, "chinese101.json"))
    culture = load_json(os.path.join(CONTENT_DIR, "culture.json"))
    places = load_json(os.path.join(CONTENT_DIR, "places.json"))
    sentences = load_json(os.path.join(CONTENT_DIR, "sentences.json"))

    # 3. 结构约束抽查
    for sid, s in scenes.items():
        if not (3 <= len(s.get("dialogue", [])) <= 5):
            errors.append(f"[{sid}] dialogue 数量 {len(s.get('dialogue', []))} 不在 3-5")
        if len(s.get("choices", [])) != 3:
            errors.append(f"[{sid}] choices 数量 {len(s.get('choices', []))} != 3")
        for k in ("title", "subtitle", "culture"):
            if not s.get(k):
                errors.append(f"[{sid}] 缺字段 {k}")

    # 3b. 城市五区域归类校验
    valid_regions = {"East", "West", "North", "South", "Central"}
    region_counter = {r: 0 for r in ["East", "West", "North", "South", "Central"]}
    for pid, pc in places.items():
        rg = pc.get("region")
        if rg not in valid_regions:
            errors.append(f"[places] {pid} 的 region={rg!r} 非法（应为 East/West/North/South/Central）")
        else:
            region_counter[rg] += 1
    if len(places) != 100:
        errors.append(f"[places] 城市数 {len(places)} != 100")

    # 4. 读模板并注入
    with io.open(INDEX_TPL, "r", encoding="utf-8") as f:
        html = f.read()

    injections = [
        ("/*__SCENES_DATA__*/{}", js_dump(scenes)),
        ("/*__CHINESE101_DATA__*/{}", js_dump(chinese101)),
        ("/*__CULTURE_DATA__*/{}", js_dump(culture)),
        ("/*__PLACES_DATA__*/{}", js_dump(places)),
        ("/*__SENTENCES_DATA__*/[]", js_dump(sentences)),
        # PayPal 三 plan IDs（Vercel 环境变量注入，本地未配置则留空，订阅页显示"配置中"）
        ("/*__PAYPAL_PLANS__*/{}", js_dump({
            "monthly": os.environ.get("PAYPAL_PLAN_MONTHLY", ""),
            "promo":   os.environ.get("PAYPAL_PLAN_PROMO", ""),
            "annual":  os.environ.get("PAYPAL_PLAN_ANNUAL", ""),
        })),
        # 合规文档（docs/legal/*.md → 前端 markdown 渲染）
        ("/*__LEGAL_DATA__*/{}", js_dump({
            "privacy": _read_md(os.path.join(BASE, "docs", "legal", "privacy.md")),
            "terms":   _read_md(os.path.join(BASE, "docs", "legal", "terms.md")),
            "refund":  _read_md(os.path.join(BASE, "docs", "legal", "refund.md")),
        })),
    ]
    for marker, payload in injections:
        if marker not in html:
            errors.append(f"模板缺少占位符 {marker}")
            continue
        html = html.replace(marker, payload)

    if errors:
        print("❌ 校验失败，未写入：")
        for e in errors[:50]:
            print("  -", e)
        sys.exit(1)

    with io.open(INDEX_OUT, "w", encoding="utf-8") as f:
        f.write(html)

    print("✅ 合并成功，已写入 index.html")
    print(f"   场景总数：{len(scenes)}（目标 100）")
    for cat in EXPECTED:
        print(f"   {cat}: {len(per_cat.get(cat, []))}")
    print(f"   chinese101 模块：{len(chinese101)}；culture 话题：{len(culture)}；places 城市：{len(places)}；sentences：{len(sentences)}")
    if len(sentences) < 1000:
        errors.append(f"sentences 条数 {len(sentences)} < 1000")
    print("   places 分区：" + "  ".join(f"{r}={region_counter[r]}" for r in ["East", "West", "North", "South", "Central"]))
    print(f"   index.html 大小：{os.path.getsize(INDEX_OUT)/1024:.1f} KB")


if __name__ == "__main__":
    main()
