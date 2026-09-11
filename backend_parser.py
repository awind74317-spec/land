from __future__ import annotations

import re
from typing import Any

RISK_KEYWORDS = ["流抵", "查封", "限制登記", "套繪", "假扣押", "預告登記", "假處分"]


def _clean(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"[\s\u3000]+", " ", value).strip()


def _find_first(text: str, patterns: list[str]) -> str:
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE | re.MULTILINE)
        if match:
            return _clean(match.group(1))
    return ""


def _detect_document_type(text: str) -> str:
    if "建物標示部" in text or re.search(r"\b建號\s*[:：]", text):
        return "建物"
    if "土地標示部" in text or re.search(r"\b地號\s*[:：]", text):
        return "土地"
    return "未知"


def _extract_owner_blocks(text: str) -> list[dict[str, str]]:
    owners: list[dict[str, str]] = []
    owner_matches = list(re.finditer(r"權利人\s*[:：]\s*([^\n\r]+)", text))
    for index, match in enumerate(owner_matches):
        start = match.start()
        end = owner_matches[index + 1].start() if index + 1 < len(owner_matches) else min(len(text), start + 2200)
        block = text[start:end]
        owner = _clean(match.group(1))
        owner_id = _find_first(
            block,
            [
                r"(?:統一編號|身分證統一編號|身分證字號)\s*[:：]\s*([^\n\r]+)",
            ],
        )
        share = _find_first(
            block,
            [
                r"權利範圍\s*[:：]\s*([^\n\r]+)",
                r"持分\s*[:：]\s*([^\n\r]+)",
            ],
        )
        registration_date = _find_first(
            block,
            [r"登記日期\s*[:：]\s*([^\n\r]+)"],
        )
        registration_reason = _find_first(
            block,
            [r"登記原因\s*[:：]\s*([^\n\r]+)"],
        )
        order = _find_first(
            block,
            [r"登記次序\s*[:：]\s*([^\n\r]+)"],
        )
        owners.append(
            {
                "owner": owner,
                "owner_id": owner_id,
                "share": share,
                "registration_date": registration_date,
                "registration_reason": registration_reason,
                "registration_order": order,
            }
        )
    return owners


def parse_transcript(pages: list[str], filename: str = "") -> dict[str, Any]:
    page_texts = [_clean(page) for page in pages]
    full_text = "\n".join(page_texts)

    document_type = _detect_document_type(full_text)
    main_no = _find_first(
        full_text,
        [
            r"(?:地號|建號)\s*[:：]\s*([^\n\r]+)",
            r"(?:土地坐落|建物坐落)\s*[:：]\s*([^\n\r]+)",
        ],
    )
    address = _find_first(
        full_text,
        [
            r"(?:建物門牌|門牌)\s*[:：]\s*([^\n\r]+)",
            r"(?:坐落地號|地上建物建號)\s*[:：]\s*([^\n\r]+)",
        ],
    )
    location = _find_first(
        full_text,
        [
            r"(?:縣市|縣市鄉鎮市區|鄉鎮市區|地段)\s*[:：]\s*([^\n\r]+)",
        ],
    )
    query_time = _find_first(
        full_text,
        [
            r"(?:謄本列印時間|列印時間|查詢時間|謄本日期)\s*[:：]\s*([^\n\r]+)",
        ],
    )

    owners = _extract_owner_blocks(full_text)
    matched_risks = [keyword for keyword in RISK_KEYWORDS if keyword in full_text]

    warnings: list[str] = []
    if not full_text.strip():
        warnings.append("PDF 無可讀文字層，需 OCR 才能完整辨識。")
    if not owners:
        warnings.append("未辨識到權利人；目前公開後端版本僅處理 PDF 文字層，圖片型欄位將於 OCR 模組補強。")

    return {
        "parser_version": "0.1.0-text-layer",
        "document": {
            "type": document_type,
            "main_no": main_no,
            "location": location,
            "address": address,
            "query_time": query_time,
            "source_file": filename,
        },
        "owners": owners,
        "risk_keywords": matched_risks,
        "warnings": warnings,
        "text_layer": {
            "page_count_with_text": sum(1 for page in page_texts if page),
            "total_characters": sum(len(page) for page in page_texts),
        },
    }
