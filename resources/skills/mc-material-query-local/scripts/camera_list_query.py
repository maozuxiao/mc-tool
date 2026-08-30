# -*- coding: utf-8 -*-
"""
本地 AHD/IPC 摄像机可售清单 + IMX307 替代料号查询脚本
数据来源:
  - ../data/camera_sales_list.json   (GitHub zvcii8/AHD-Camera-Sales-List 蒸馏)
  - ../data/imx307_replacement.json  (IMX307替代料号明细_260529.xlsx 梳理)

用法:
  python camera_list_query.py item <料号> [--json]
  python camera_list_query.py search <关键词> [--json]   (支持 && 多条件)
  python camera_list_query.py imx307 <料号> [--json]     (查询 IMX307 替代料号)
  python camera_list_query.py stats [--json]

IMX307 提示规则: item/search 命中行的描述含 "IMX307" 时，自动附加 imx307_replacement 字段
（替代料号信息），供 agent 提示用户并告知客户。

注意: 本清单仅含静态信息。生命周期、库存等动态数据请以 MC 服务器查询 (mc_query.js) 为准。
"""
import sys, os, json

DATA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "camera_sales_list.json")
IMX307_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "imx307_replacement.json")

_imx307_cache = None

def load_data():
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

def load_imx307():
    global _imx307_cache
    if _imx307_cache is None:
        with open(IMX307_PATH, "r", encoding="utf-8") as f:
            _imx307_cache = json.load(f)
    return _imx307_cache["mapping"]

def norm(v):
    if v is None:
        return ""
    return str(v).strip().replace("\t", "").replace(" ", "")

def emit(obj):
    print("===JSON_BEGIN===")
    print(json.dumps(obj, ensure_ascii=False))
    print("===JSON_END===")

def attach_imx307(rows):
    """对描述含 IMX307 的行附加替代料号信息"""
    imx = load_imx307()
    for r in rows:
        desc = str(r.get("cn", "")) + "|" + str(r.get("en", ""))
        if "IMX307" in desc.upper():
            code = norm(r.get("p"))
            repls = [m for m in imx if norm(m.get("original")) == code]
            r["imx307_replacement"] = repls if repls else []
    return rows

def cmd_item(data, code):
    code = norm(code)
    rows = [d for d in data if norm(d.get("p")) == code]
    if not rows:
        rows = [d for d in data if code in norm(d.get("p"))]
    rows = attach_imx307(rows)
    return {"itemNumber": code, "method": "ITEM_NUMBER" if rows else "NONE",
            "found": len(rows) > 0, "rows": rows}

def cmd_search(data, kw):
    terms = [t.strip() for t in kw.split("&&") if t.strip()]
    rows = []
    for d in data:
        hay = "|".join([str(d.get(k, "")) for k in ("cat", "m", "t", "p", "r", "s", "l", "i", "g", "st", "c", "cn", "en")])
        if all(norm(t) in norm(hay) for t in terms):
            rows.append(d)
    rows = attach_imx307(rows)
    return {"query": kw, "rows": rows}

def cmd_imx307(code):
    imx = load_imx307()
    code = norm(code)
    rows = [m for m in imx if norm(m.get("original")) == code]
    return {"itemNumber": code, "found": len(rows) > 0, "rows": rows}

def cmd_stats(data):
    cats = {}
    for d in data:
        c = d.get("cat", "?")
        cats[c] = cats.get(c, 0) + 1
    models = {}
    for d in data:
        m = d.get("m", "?")
        models[m] = models.get(m, 0) + 1
    imx = load_imx307()
    return {"total": len(data), "categories": cats, "models": models,
            "imx307_mapping_count": len(imx)}

def main():
    args = sys.argv[1:]
    if not args:
        print("usage: camera_list_query.py <item|search|imx307|stats> [args] [--json]")
        sys.exit(1)
    cmd = args[0]
    rest = [a for a in args[1:] if a != "--json"]
    data = load_data()
    if cmd == "item" and rest:
        emit(cmd_item(data, rest[0]))
    elif cmd == "search" and rest:
        emit(cmd_search(data, rest[0]))
    elif cmd == "imx307" and rest:
        emit(cmd_imx307(rest[0]))
    elif cmd == "stats":
        emit(cmd_stats(data))
    else:
        print("bad args")
        sys.exit(1)

if __name__ == "__main__":
    main()