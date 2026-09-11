from __future__ import annotations

import re
from typing import Any

RISK_KEYWORDS = ["流抵", "查封", "限制登記", "套繪", "假扣押", "預告登記", "假處分"]


def _clean(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"[\s\u3000]+", " ", value).strip()


def _normalize_page(value: str | None) -> str:
    if not value:
        return ""
    lines = [_clean(line) for line in value.replace("\r", "\n").split("\n")]
    return "\n".join(line for line in lines if line)


def _find_first(text: str, patterns: list[str]) -> str:
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE | re.MULTILINE)
        if match:
            return _clean(match.group(1))
    return ""


def _section(text: str, start_terms: list[str], stop_terms: list[str]) -> str:
    starts = [text.find(term) for term in start_terms if text.find(term) >= 0]
    if not starts:
        return ""
    start = min(starts)
    stops = [text.find(term, start + 1) for term in stop_terms if text.find(term, start + 1) >= 0]
    end = min(stops) if stops else len(text)
    return text[start:end]


def _detect_document_type(text: str) -> str:
    if "建物標示部" in text or re.search(r"建號\s*[:：]", text):
        return "建物"
    if "土地標示部" in text or re.search(r"地號\s*[:：]", text):
        return "土地"
    return "未知"


def _extract_area(text: str, document_type: str) -> dict[str, str | float]:
    total_m2 = _find_first(text, [r"(?:總面積|面積)\s*[:：]?\s*([0-9,.]+)\s*平方公尺"])
    main_m2 = _find_first(text, [r"主建物[^\n]*?([0-9,.]+)\s*平方公尺", r"主建物面積\s*[:：]?\s*([0-9,.]+)"])
    public_m2 = _find_first(text, [r"(?:共有部分|共同使用部分)[^\n]*?([0-9,.]+)\s*平方公尺"])

    def num(value: str) -> float:
        try:
            return float(value.replace(",", "")) if value else 0.0
        except ValueError:
            return 0.0

    total = num(total_m2)
    main = num(main_m2)
    public = num(public_m2)
    if not total:
        total = main + public
    return {
        "main_building_m2": main_m2,
        "public_m2": public_m2,
        "total_m2": total_m2 or (f"{total:g}" if total else ""),
        "total_ping": round(total / 3.305785, 2) if total else 0,
        "main_building_ping": round(main / 3.305785, 2) if main else 0,
        "public_ping": round(public / 3.305785, 2) if public else 0,
    }


def _extract_owner_blocks(text: str) -> list[dict[str, str]]:
    owner_section = _section(text, ["所有權部"], ["他項權利部", "其他權利部"])
    source = owner_section or text
    matches = list(re.finditer(r"權利人\s*[:：]\s*([^\n\r]+)", source))
    owners: list[dict[str, str]] = []
    for index, match in enumerate(matches):
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else min(len(source), start + 2400)
        block = source[start:end]
        owner = _clean(match.group(1))
        if not owner or owner in {"權利人", "無"}:
            continue
        owners.append({
            "owner": owner,
            "owner_id": _find_first(block, [r"(?:統一編號|統一編號：|身分證統一編號|身分證字號)\s*[:：]?\s*([^\n\r]+)"]),
            "share": _find_first(block, [r"(?:權利範圍|持分)\s*[:：]\s*([^\n\r]+)"]),
            "registration_date": _find_first(block, [r"登記日期\s*[:：]\s*([^\n\r]+)"]),
            "registration_reason": _find_first(block, [r"登記原因\s*[:：]\s*([^\n\r]+)"]),
            "registration_order": _find_first(block, [r"登記次序\s*[:：]\s*([^\n\r]+)"]),
        })
    return owners


def _extract_mortgages(text: str) -> list[dict[str, str]]:
    section = _section(text, ["他項權利部", "其他權利部"], [])
    if not section:
        return []
    matches = list(re.finditer(r"權利人\s*[:：]\s*([^\n\r]+)", section))
    result: list[dict[str, str]] = []
    for index, match in enumerate(matches):
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else min(len(section), start + 2600)
        block = section[start:end]
        result.append({
            "holder": _clean(match.group(1)),
            "order": _find_first(block, [r"登記次序\s*[:：]\s*([^\n\r]+)"]),
            "right_type": _find_first(block, [r"權利種類\s*[:：]\s*([^\n\r]+)"]),
            "amount": _find_first(block, [r"(?:擔保債權總金額|債權額比例|權利價值)\s*[:：]\s*([^\n\r]+)"]),
            "scope": _find_first(block, [r"權利範圍\s*[:：]\s*([^\n\r]+)"]),
            "debtor": _find_first(block, [r"(?:債務人及債務額比例|債務人)\s*[:：]\s*([^\n\r]+)"]),
            "duration": _find_first(block, [r"存續期間\s*[:：]\s*([^\n\r]+)"]),
            "notes": _find_first(block, [r"其他登記事項\s*[:：]\s*([^\n\r]+)"]),
        })
    return [item for item in result if item["holder"]]


def _setting_summary(mortgages: list[dict[str, str]]) -> str:
    chunks: list[str] = []
    for item in mortgages:
        parts = [item.get("order", ""), item.get("right_type", ""), item.get("holder", ""), item.get("amount", "")]
        text = "｜".join(part for part in parts if part)
        if text:
            chunks.append(text)
    return "\n".join(chunks)


def _extract_location(text: str) -> str:
    direct = _find_first(text, [
        r"(?:土地坐落|建物坐落地號|建物坐落)\s*[:：]\s*([^\n\r]+)",
        r"(?:縣市鄉鎮市區|縣市|鄉鎮市區)\s*[:：]\s*([^\n\r]+)",
    ])
    if direct:
        return direct
    match = re.search(r"([\u4e00-\u9fff]{2,3}(?:市|縣)[\u4e00-\u9fff]{1,5}(?:區|鄉|鎮|市)[^\n]{0,30}(?:段|小段))", text)
    return _clean(match.group(1)) if match else ""


def parse_transcript(pages: list[str], filename: str = "") -> dict[str, Any]:
    page_texts = [_normalize_page(page) for page in pages]
    full_text = "\n".join(page for page in page_texts if page)
    document_type = _detect_document_type(full_text)

    document = {
        "type": document_type,
        "main_no": _find_first(full_text, [r"(?:地號|建號)\s*[:：]\s*([^\n\r]+)"]),
        "location": _extract_location(full_text),
        "address": _find_first(full_text, [r"(?:建物門牌|門牌)\s*[:：]\s*([^\n\r]+)", r"(?:坐落地號|地上建物建號)\s*[:：]\s*([^\n\r]+)"]),
        "query_time": _find_first(full_text, [r"(?:謄本列印時間|列印時間|查詢時間|謄本日期|資料列印時間)\s*[:：]\s*([^\n\r]+)"]),
        "source_file": filename,
    }
    area = _extract_area(full_text, document_type)
    owners = _extract_owner_blocks(full_text)
    mortgages = _extract_mortgages(full_text)
    matched_risks = [keyword for keyword in RISK_KEYWORDS if keyword in full_text]

    rows: list[dict[str, Any]] = []
    row_owners = owners or [{"owner": "", "owner_id": "", "share": "", "registration_date": "", "registration_reason": "", "registration_order": ""}]
    for owner in row_owners:
        rows.append({
            "type": document_type,
            "owner_name": owner.get("owner", ""),
            "owner_id": owner.get("owner_id", ""),
            "owner_share": owner.get("share", ""),
            "location": document["location"],
            "main_no": document["main_no"],
            "address": document["address"],
            "main_building_m2": area["main_building_m2"],
            "main_building_ping": area["main_building_ping"],
            "public_m2": area["public_m2"],
            "public_ping": area["public_ping"],
            "total_m2": area["total_m2"],
            "total_ping": area["total_ping"],
            "registration_date": owner.get("registration_date", ""),
            "registration_reason": owner.get("registration_reason", ""),
            "registration_order": owner.get("registration_order", ""),
            "settings": _setting_summary(mortgages),
            "risk_alerts": matched_risks,
            "query_time": document["query_time"],
            "source_file": filename,
        })

    warnings: list[str] = []
    if not full_text.strip():
        warnings.append("PDF 無可讀文字層，需 OCR 才能完整辨識。")
    if not owners:
        warnings.append("未從文字層辨識到所有權人；若姓名位於圖片列，需 OCR 補強。")
    if "異動索引" in full_text:
        warnings.append("異動索引的圖片列 OCR 尚未搬到雲端版，本輪先保留文字層結果。")

    return {
        "parser_version": "0.2.0-structured-rows",
        "document": document,
        "rows": rows,
        "owners": owners,
        "mortgages": mortgages,
        "risk_keywords": matched_risks,
        "warnings": warnings,
        "text_layer": {
            "page_count_with_text": sum(1 for page in page_texts if page),
            "total_characters": sum(len(page) for page in page_texts),
        },
    }
