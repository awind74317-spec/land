from __future__ import annotations

import re
from typing import Any

RISK_KEYWORDS = ["流抵", "查封", "限制登記", "套繪", "假扣押", "預告登記", "假處分"]


def _clean(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"[\s\u3000]+", " ", str(value)).strip()


def _normalize_page(value: str | None) -> str:
    if not value:
        return ""
    lines = [_clean(line) for line in value.replace("\r", "\n").split("\n")]
    return "\n".join(line for line in lines if line)


def _lines(text: str) -> list[str]:
    return [line for line in (_clean(item) for item in text.splitlines()) if line]


def _section(text: str, start_terms: list[str], stop_terms: list[str]) -> str:
    starts = [text.find(term) for term in start_terms if text.find(term) >= 0]
    if not starts:
        return ""
    start = min(starts)
    stops = [text.find(term, start + 1) for term in stop_terms if text.find(term, start + 1) >= 0]
    return text[start:min(stops) if stops else len(text)]


def _first_regex(text: str, patterns: list[str]) -> str:
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE | re.MULTILINE)
        if match:
            return _clean(match.group(1))
    return ""


def _label_value(text: str, labels: list[str], max_next_lines: int = 2) -> str:
    rows = _lines(text)
    for index, row in enumerate(rows):
        for label in labels:
            match = re.search(rf"{re.escape(label)}\s*[:：]?\s*(.*)$", row)
            if not match:
                continue
            value = _clean(match.group(1))
            if value and value not in {label, "-", "--"}:
                return value
            for offset in range(1, max_next_lines + 1):
                if index + offset >= len(rows):
                    break
                candidate = _clean(rows[index + offset])
                if candidate and not re.match(r"^[一二三四五六七八九十0-9]+[、.]?$", candidate):
                    return candidate
    return ""


def _detect_document_type(text: str) -> str:
    # Explicit section heading wins. Land transcripts often contain "地上建號", so
    # generic occurrences of 建號 must never make a land transcript become 建物.
    if re.search(r"土地\s*標示部|土地標示", text):
        return "土地"
    if re.search(r"建物\s*標示部|建物標示", text):
        return "建物"
    if re.search(r"(?:^|\n)\s*地號\s*[:：]", text):
        return "土地"
    if re.search(r"(?:^|\n)\s*建號\s*[:：]", text):
        return "建物"
    return "未知"


def _roc_date(value: str, separator: str = ".") -> str:
    if not value:
        return ""
    value = _clean(value)
    match = re.search(r"(?:民國)?\s*(\d{2,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日", value)
    if not match:
        match = re.search(r"(?<!\d)(\d{2,3})[./-](\d{1,2})[./-](\d{1,2})(?!\d)", value)
    if not match:
        return value
    return separator.join([match.group(1), match.group(2).zfill(2), match.group(3).zfill(2)])


def _number(value: str) -> float:
    try:
        return float(value.replace(",", "")) if value else 0.0
    except (TypeError, ValueError):
        return 0.0


def _fmt_number(value: float, digits: int = 2) -> str:
    if not value:
        return "0"
    result = f"{value:.{digits}f}"
    return result.rstrip("0").rstrip(".") if "." in result else result


def _to_ping(m2: float) -> float:
    return round(m2 / 3.305785, 2) if m2 else 0.0


def _extract_main_no(text: str, document_type: str) -> str:
    label = "地號" if document_type == "土地" else "建號"
    value = _label_value(text, [label])
    match = re.search(r"(?<!\d)(\d{1,5}-\d{4})(?!\d)", value)
    if match:
        return match.group(1).zfill(9) if len(match.group(1).split("-")[0]) < 4 else match.group(1)

    for line in _lines(text):
        if label in line:
            match = re.search(r"(?<!\d)(\d{1,5}-\d{4})(?!\d)", line)
            if match:
                left, right = match.group(1).split("-", 1)
                return f"{left.zfill(4)}-{right}"
    match = re.search(r"(?<!\d)(\d{4}-\d{4})(?!\d)", text)
    return match.group(1) if match else ""


def _extract_location(text: str) -> str:
    compact = re.sub(r"[\s\u3000]+", "", text)
    city_match = re.search(r"([\u4e00-\u9fff]{2,3}(?:縣|市))", compact)
    district_match = re.search(r"([\u4e00-\u9fff]{1,6}(?:區|鄉|鎮|市))", compact[city_match.end():] if city_match else compact)
    segment_match = re.search(r"([\u4e00-\u9fff]{1,8}(?:小段|段))", compact)
    if city_match and district_match and segment_match:
        return f"{city_match.group(1)}{district_match.group(1)}/{segment_match.group(1)}"

    raw = _label_value(text, ["土地坐落", "建物坐落", "縣市區/地段", "地段"])
    raw = re.sub(r"\s+", "", raw)
    return raw


def _extract_area(text: str, document_type: str) -> dict[str, Any]:
    mark_section = _section(text, ["土地標示部", "建物標示部", "標示部"], ["所有權部"])
    source = mark_section or text

    values: list[float] = []
    for line in _lines(source):
        if "平方公尺" not in line and "面積" not in line:
            continue
        for token in re.findall(r"(?<!\d)(\d{1,8}(?:\.\d{1,4})?)(?!\d)", line):
            number = _number(token)
            if 0 < number < 10000000:
                values.append(number)

    labelled = _first_regex(source, [
        r"(?:面積|總面積)\s*[:：]?\s*([0-9,.]+)\s*(?:平方公尺|㎡|m²)?",
        r"([0-9,.]+)\s*平方公尺",
    ])
    total = _number(labelled)
    if not total and values:
        # For a land transcript, the first sensible square-metre amount in 標示部 is the land area.
        total = values[0]

    main = total if document_type == "土地" else _number(_first_regex(source, [
        r"主建物[^\n]*?([0-9,.]+)\s*(?:平方公尺|㎡|m²)",
        r"主建物面積\s*[:：]?\s*([0-9,.]+)",
    ]))
    public = 0.0 if document_type == "土地" else _number(_first_regex(source, [
        r"(?:共有部分|共同使用部分)[^\n]*?([0-9,.]+)\s*(?:平方公尺|㎡|m²)",
    ]))
    if document_type != "土地" and not total:
        total = main + public

    return {
        "main_m2": round(main, 4),
        "main_ping": _to_ping(main),
        "public_m2": round(public, 4),
        "public_ping": _to_ping(public),
        "total_m2": round(total, 4),
        "total_ping": _to_ping(total),
    }


def _share_percent(raw: str) -> tuple[str, float]:
    raw = _clean(raw)
    if not raw:
        return "", 0.0
    if raw in {"全部", "全"}:
        return "100.00%", 1.0
    match = re.search(r"(\d+)\s*分之\s*(\d+)", raw)
    if match and int(match.group(1)):
        ratio = int(match.group(2)) / int(match.group(1))
        return f"{ratio * 100:.2f}%", ratio
    match = re.search(r"(\d+(?:\.\d+)?)\s*%", raw)
    if match:
        pct = float(match.group(1))
        return f"{pct:.2f}%", pct / 100.0
    return raw, 0.0


def _extract_owner_blocks(text: str) -> list[dict[str, str | float]]:
    owner_section = _section(text, ["所有權部"], ["他項權利部", "其他權利部"])
    source = owner_section or text
    rows = _lines(source)
    owner_indices = [i for i, line in enumerate(rows) if re.search(r"權利人\s*[:：]", line)]
    owners: list[dict[str, str | float]] = []

    for pos, index in enumerate(owner_indices):
        end = owner_indices[pos + 1] if pos + 1 < len(owner_indices) else min(len(rows), index + 40)
        block = "\n".join(rows[index:end])
        owner = _label_value(block, ["權利人"])
        owner = re.split(r"\s+(?:統一編號|住址|權利範圍|登記次序)\s*[:：]", owner)[0].strip()
        if not owner or owner in {"無", "權利人"}:
            continue
        owner_id = _label_value(block, ["統一編號", "身分證統一編號", "身分證字號"])
        owner_id_match = re.search(r"[A-Z]?[0-9＊*]{6,10}", owner_id.replace(" ", ""), re.I)
        owner_id = owner_id_match.group(0) if owner_id_match else owner_id
        share, ratio = _share_percent(_label_value(block, ["權利範圍", "持分"]))
        owners.append({
            "owner": owner,
            "owner_id": owner_id,
            "share": share,
            "share_ratio": ratio,
            "registration_date": _roc_date(_label_value(block, ["登記日期"]), "."),
            "registration_reason": _label_value(block, ["登記原因"]),
            "registration_order": _label_value(block, ["登記次序"]),
        })
    return owners


def _extract_mortgages(text: str) -> list[dict[str, str]]:
    section = _section(text, ["他項權利部", "其他權利部"], [])
    if not section:
        return []
    rows = _lines(section)
    holder_indices = [i for i, line in enumerate(rows) if re.search(r"權利人\s*[:：]", line)]
    mortgages: list[dict[str, str]] = []
    for pos, index in enumerate(holder_indices):
        end = holder_indices[pos + 1] if pos + 1 < len(holder_indices) else min(len(rows), index + 45)
        block = "\n".join(rows[index:end])
        holder = _label_value(block, ["權利人"])
        if not holder:
            continue
        mortgages.append({
            "holder": holder,
            "order": _label_value(block, ["登記次序"]),
            "right_type": _label_value(block, ["權利種類"]),
            "amount": _label_value(block, ["擔保債權總金額", "債權額比例", "權利價值"]),
            "scope": _label_value(block, ["權利範圍"]),
            "debtor": _label_value(block, ["債務人及債務額比例", "債務人"]),
        })
    return mortgages


def _setting_summary(mortgages: list[dict[str, str]]) -> str:
    if not mortgages:
        return "無"
    chunks = []
    for idx, item in enumerate(mortgages, 1):
        details = "｜".join(value for value in [item.get("order", ""), item.get("right_type", ""), item.get("holder", ""), item.get("amount", "")] if value)
        if details:
            chunks.append(f"{idx}.{details}")
    return "\n".join(chunks) or "無"


def _extract_announced(text: str, labels: list[str]) -> str:
    value = _label_value(text, labels)
    match = re.search(r"[0-9][0-9,]*(?:\.\d+)?", value)
    return match.group(0) if match else "-"


def _query_date(text: str) -> str:
    value = _label_value(text, ["謄本列印時間", "資料列印時間", "列印時間", "查詢時間", "謄本日期"])
    if not value:
        value = _first_regex(text, [r"(民國\s*\d{2,3}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)"])
    return _roc_date(value, "/")


def _notes(owner: dict[str, Any], document_type: str, risks: list[str], text: str) -> str:
    zoning = _label_value(text, ["使用分區", "分區"]) or "(空白)"
    land_class = _label_value(text, ["使用地類別", "類別"]) or "(空白)"
    material = _label_value(text, ["主要建材", "主要用途及材料"]) or "-"
    parking = "無" if document_type == "土地" else (_label_value(text, ["車位", "停車位"]) or "-")
    return (
        f"1.所有權登記日: {owner.get('registration_date') or '-'} "
        f"2.完工登記日: - "
        f"3.建築類型: 分區:{zoning} 類別:{land_class} "
        f"4.有無車位: {parking} "
        f"5.主要建材: {material} "
        f"6.登記原因: {owner.get('registration_reason') or '-'} "
        f"7.風險提醒: {'、'.join(risks) if risks else '-'}"
    )


def parse_transcript(pages: list[str], filename: str = "") -> dict[str, Any]:
    page_texts = [_normalize_page(page) for page in pages]
    full_text = "\n".join(page for page in page_texts if page)
    document_type = _detect_document_type(full_text)
    main_no = _extract_main_no(full_text, document_type)
    location = _extract_location(full_text)
    query_date = _query_date(full_text)
    area = _extract_area(full_text, document_type)
    owners = _extract_owner_blocks(full_text)
    mortgages = _extract_mortgages(full_text)
    risks = [keyword for keyword in RISK_KEYWORDS if keyword in full_text]
    address = _label_value(full_text, ["建物門牌", "門牌"] if document_type == "建物" else ["地上建號", "地上建物建號"])
    announced_value = _extract_announced(full_text, ["公告土地現值", "公告現值"])
    announced_price = _extract_announced(full_text, ["公告地價"])

    row_owners: list[dict[str, Any]] = owners or [{
        "owner": "", "owner_id": "", "share": "", "share_ratio": 0.0,
        "registration_date": "", "registration_reason": "", "registration_order": "",
    }]
    rows: list[dict[str, Any]] = []

    for owner in row_owners:
        ratio = float(owner.get("share_ratio") or 0.0)
        if not ratio and owner.get("share") == "100.00%":
            ratio = 1.0
        share_main = area["main_m2"] * ratio if ratio else 0.0
        share_total = area["total_m2"] * ratio if ratio else 0.0
        main_parts = f"1. {document_type}: {_fmt_number(area['main_m2'])}m²" if area["main_m2"] else "--"
        settings = _setting_summary(mortgages)
        source = f"{document_type}: {filename}" if document_type != "未知" else filename

        rows.append({
            "pre_review_case_no": "-",
            "type": document_type,
            "owner_name": owner.get("owner", ""),
            "owner_id": owner.get("owner_id", ""),
            "owner_share": owner.get("share", ""),
            "location": location,
            "address": address or "-",
            "main_no": main_no,
            "main_building_parts": main_parts,
            "main_building_m2": _fmt_number(area["main_m2"]),
            "main_building_ping": f"{area['main_ping']:.2f}" if area["main_m2"] else "0",
            "public_parts": "--" if not area["public_m2"] else f"共有部分: {_fmt_number(area['public_m2'])}m²",
            "public_m2": _fmt_number(area["public_m2"]),
            "public_ping": f"{area['public_ping']:.2f}" if area["public_m2"] else "0",
            "parking_count": "-" if document_type == "土地" else "0",
            "parking_ratio": "-",
            "parking_m2": "-" if document_type == "土地" else "0",
            "parking_ping": "-" if document_type == "土地" else "0",
            "total_m2_w_car": _fmt_number(area["total_m2"]),
            "total_ping_w_car": f"{area['total_ping']:.2f}" if area["total_m2"] else "0",
            "total_m2_no_car": _fmt_number(area["total_m2"]),
            "total_ping_no_car": f"{area['total_ping']:.2f}" if area["total_m2"] else "0",
            "announced_value": announced_value,
            "announced_price": announced_price,
            "post_share_m2_w_car": _fmt_number(share_total) if ratio else "-",
            "post_share_ping_w_car": f"{_to_ping(share_total):.2f}" if ratio else "-",
            "post_share_m2_no_car": _fmt_number(share_total) if ratio else "-",
            "post_share_ping_no_car": f"{_to_ping(share_total):.2f}" if ratio else "-",
            "pure_amount": "無" if not mortgages else "待解析",
            "collateral": "無" if not mortgages else "待解析",
            "settings": settings,
            "notes": _notes(owner, document_type, risks, full_text),
            "change_index": f"無關聯索引 ({main_no})" if main_no else "無關聯索引",
            "query_time": query_date,
            "source_file": source,
            "record_time": "-",
            "registration_date": owner.get("registration_date", ""),
            "registration_reason": owner.get("registration_reason", ""),
            "registration_order": owner.get("registration_order", ""),
            "risk_alerts": risks,
        })

    warnings: list[str] = []
    if not full_text.strip():
        warnings.append("PDF 無可讀文字層，需 OCR 才能完整辨識。")
    for field_name, value in [("類型", document_type if document_type != "未知" else ""), ("主地/建號", main_no), ("所有權人", owners[0].get("owner", "") if owners else "")]:
        if not value:
            warnings.append(f"未從文字層穩定辨識「{field_name}」，需再比對原始謄本或 OCR。")

    return {
        "parser_version": "0.3.0-offline-schema",
        "document": {"type": document_type, "main_no": main_no, "location": location, "address": address, "query_time": query_date, "source_file": filename},
        "rows": rows,
        "owners": owners,
        "mortgages": mortgages,
        "risk_keywords": risks,
        "warnings": warnings,
        "text_layer": {"page_count_with_text": sum(1 for page in page_texts if page), "total_characters": sum(len(page) for page in page_texts)},
    }
