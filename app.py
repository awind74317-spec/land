from __future__ import annotations

import os
from collections import defaultdict
from typing import Annotated

import fitz
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend_parser import parse_transcript

MAX_FILE_BYTES = int(os.getenv("MAX_FILE_BYTES", str(20 * 1024 * 1024)))
MAX_PAGES = int(os.getenv("MAX_PAGES", "200"))


def _allowed_origins() -> list[str]:
    raw = os.getenv(
        "ALLOWED_ORIGINS",
        "https://awind74317-spec.github.io,http://127.0.0.1:5500,http://localhost:5500",
    )
    return [item.strip().rstrip("/") for item in raw.split(",") if item.strip()]


def _page_text_by_lines(page: fitz.Page) -> str:
    """Rebuild visible lines from positioned words instead of flattening the whole page."""
    words = page.get_text("words") or []
    if not words:
        return page.get_text("text") or ""

    grouped: dict[tuple[int, int], list[tuple]] = defaultdict(list)
    for word in words:
        if len(word) < 8:
            continue
        grouped[(int(word[5]), int(word[6]))].append(word)

    lines: list[tuple[float, float, str]] = []
    for items in grouped.values():
        items.sort(key=lambda item: (float(item[0]), float(item[1])))
        y = min(float(item[1]) for item in items)
        x = min(float(item[0]) for item in items)
        text = " ".join(str(item[4]).strip() for item in items if str(item[4]).strip())
        if text:
            lines.append((y, x, text))

    lines.sort(key=lambda item: (round(item[0], 1), item[1]))
    return "\n".join(text for _, _, text in lines)


app = FastAPI(
    title="Land Registry Parser API",
    version="0.3.0",
    docs_url="/docs",
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Accept"],
)


@app.get("/")
def root() -> dict:
    return {"ok": True, "service": "land-registry-parser", "version": "0.3.0"}


@app.get("/health")
def health() -> dict:
    return {"ok": True, "status": "healthy", "version": "0.3.0"}


@app.post("/api/parse")
async def parse_pdf(file: Annotated[UploadFile, File(...)]) -> JSONResponse:
    filename = file.filename or "upload.pdf"
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=415, detail="僅接受 PDF 檔案。")

    data = await file.read(MAX_FILE_BYTES + 1)
    await file.close()
    if not data or len(data) > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="PDF 超過允許大小或內容為空。")
    if not data.startswith(b"%PDF-"):
        raise HTTPException(status_code=400, detail="檔案不是有效的 PDF。")

    try:
        with fitz.open(stream=data, filetype="pdf") as doc:
            page_count = len(doc)
            if page_count < 1:
                raise HTTPException(status_code=400, detail="PDF 沒有可解析頁面。")
            if page_count > MAX_PAGES:
                raise HTTPException(status_code=413, detail=f"PDF 超過 {MAX_PAGES} 頁限制。")
            pages = [_page_text_by_lines(page) for page in doc]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail="PDF 無法解析。") from exc

    result = parse_transcript(pages, filename=filename)
    result.update({
        "ok": True,
        "filename": filename,
        "page_count": page_count,
        "file_size": len(data),
        "privacy": "PDF 僅在本次請求記憶體中處理，API 不主動保存原始檔。",
    })
    return JSONResponse(result)


@app.exception_handler(HTTPException)
async def http_error_handler(_, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"ok": False, "error": str(exc.detail)})
