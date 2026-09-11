#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import socket
import threading
import webbrowser
from datetime import datetime
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_HTML = "index.html"
USAGE_STATS_FILE = BASE_DIR / "runtime" / "usage_stats.json"
USAGE_FILE_LOCK = threading.Lock()
OCR_LOCK = threading.Lock()


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def safe_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def default_usage_stats() -> dict:
    return {
        "visitCount": 0,
        "totalParsedCount": 0,
        "logs": [],
    }


def normalize_usage_stats(raw: dict | None) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    normalized = default_usage_stats()
    normalized["visitCount"] = max(0, safe_int(raw.get("visitCount"), 0))
    normalized["totalParsedCount"] = max(0, safe_int(raw.get("totalParsedCount"), 0))
    normalized["logs"] = raw.get("logs") if isinstance(raw.get("logs"), list) else []
    return normalized


def ensure_usage_stats_file() -> None:
    USAGE_STATS_FILE.parent.mkdir(parents=True, exist_ok=True)
    if not USAGE_STATS_FILE.exists():
        USAGE_STATS_FILE.write_text(
            json.dumps(default_usage_stats(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


def read_usage_stats_unlocked() -> dict:
    ensure_usage_stats_file()
    try:
        raw = json.loads(USAGE_STATS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raw = default_usage_stats()
    return normalize_usage_stats(raw)


def write_usage_stats_unlocked(stats: dict) -> None:
    normalized = normalize_usage_stats(stats)
    tmp_path = USAGE_STATS_FILE.with_suffix(".tmp")
    tmp_path.write_text(
        json.dumps(normalized, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    tmp_path.replace(USAGE_STATS_FILE)


def read_usage_stats() -> dict:
    with USAGE_FILE_LOCK:
        return read_usage_stats_unlocked()


def read_json_body(request_handler: SimpleHTTPRequestHandler) -> dict:
    body_len = safe_int(request_handler.headers.get("Content-Length"), 0)
    if body_len <= 0:
        return {}
    raw = request_handler.rfile.read(body_len)
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError:
        return {}


def update_usage_stats(mutator) -> dict:
    with USAGE_FILE_LOCK:
        stats = read_usage_stats_unlocked()
        mutator(stats)
        # Avoid unbounded growth
        if len(stats["logs"]) > 100000:
            stats["logs"] = stats["logs"][-100000:]
        write_usage_stats_unlocked(stats)
        return stats


class HomeHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, target_html: str = DEFAULT_HTML, **kwargs):
        self.target_html = target_html
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def end_headers(self) -> None:
        # Force fresh HTML/JS/CSS after local edits; avoids stale browser cache.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            self.path = f"/{self.target_html}"
            return super().do_GET()
        if path == "/api/usage/stats":
            stats = read_usage_stats()
            return self.send_json({"ok": True, "stats": stats})
        return super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path

        if path == '/api/pdf-field-repair':
            origin = self.headers.get('Origin')
            if self.client_address[0] not in ('127.0.0.1', '::1') or (origin and urlparse(origin).netloc != self.headers.get('Host')):
                return self.send_json({'ok': False, 'error': 'Local requests only.'}, HTTPStatus.FORBIDDEN)
            length = safe_int(self.headers.get('Content-Length'), 0)
            if not 0 < length <= 28 * 1024 * 1024:
                return self.send_json({'ok': False, 'error': 'Request too large.'}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            try:
                import base64
                payload = json.loads(self.rfile.read(length))
                data = base64.b64decode(payload['pdf'], validate=True)
                if not data.startswith(b'%PDF-') or len(data) > 20 * 1024 * 1024:
                    raise ValueError('Invalid PDF')
                from local_field_repair import recognize_regions
                with OCR_LOCK:
                    regions = recognize_regions(data, payload['regions'], BASE_DIR)
                return self.send_json({'ok': True, 'regions': regions})
            except Exception:
                return self.send_json({'ok': False, 'error': '局部 OCR 未完成，保留原值供核對。'}, HTTPStatus.UNPROCESSABLE_ENTITY)

        if path in ('/api/pdf-index-images', '/api/pdf-crosscheck'):
            origin = self.headers.get('Origin')
            if self.client_address[0] not in ('127.0.0.1', '::1') or (origin and urlparse(origin).netloc != self.headers.get('Host')):
                return self.send_json({'ok': False, 'error': 'Local requests only.'}, HTTPStatus.FORBIDDEN)
            length = safe_int(self.headers.get('Content-Length'), 0)
            if length <= 0 or length > 20 * 1024 * 1024:
                return self.send_json({'ok': False, 'error': 'PDF must be smaller than 20 MB.'}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            data = self.rfile.read(length)
            if len(data) != length or not data.startswith(b'%PDF-'):
                return self.send_json({'ok': False, 'error': 'Invalid PDF.'}, HTTPStatus.BAD_REQUEST)
            try:
                if path == '/api/pdf-crosscheck':
                    from local_pdf_crosscheck import recognize_pages
                    with OCR_LOCK:
                        pages = recognize_pages(data, BASE_DIR)
                    return self.send_json({'ok': True, 'pages': pages})
                from local_index_ocr import extract_index_image_lines
                with OCR_LOCK:
                    lines = extract_index_image_lines(data, BASE_DIR)
                return self.send_json({'ok': True, 'lines': lines})
            except Exception:
                return self.send_json({'ok': False, 'error': 'Local image recognition failed. Verify PyMuPDF and Windows Traditional Chinese OCR, then inspect the source PDF.'}, HTTPStatus.UNPROCESSABLE_ENTITY)

        if path == "/api/usage/visit":
            def apply_visit(stats: dict) -> None:
                stats["visitCount"] = max(0, safe_int(stats.get("visitCount"), 0)) + 1

            stats = update_usage_stats(apply_visit)
            return self.send_json({"ok": True, "stats": stats})

        if path == "/api/usage/parse":
            payload = read_json_body(self)
            parsed_count = max(0, safe_int(payload.get("parsedCount"), 0))
            source_file_count = max(0, safe_int(payload.get("sourceFileCount"), 0))

            def apply_parse(stats: dict) -> None:
                stats["totalParsedCount"] = max(0, safe_int(stats.get("totalParsedCount"), 0)) + parsed_count
                stats["logs"].append(
                    {
                        "time": now_str(),
                        "visitCount": max(0, safe_int(stats.get("visitCount"), 0)),
                        "sourceFileCount": source_file_count,
                        "parsedCount": parsed_count,
                        "totalParsedCount": max(0, safe_int(stats.get("totalParsedCount"), 0)),
                    }
                )

            stats = update_usage_stats(apply_parse)
            return self.send_json({"ok": True, "stats": stats})

        self.send_json({"ok": False, "error": "API endpoint not found"}, HTTPStatus.NOT_FOUND)


def get_local_ipv4_list() -> list[str]:
    ips: set[str] = set()

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            ip = sock.getsockname()[0]
            if ip and not ip.startswith("127."):
                ips.add(ip)
    except OSError:
        pass

    try:
        hostname = socket.gethostname()
        for item in socket.getaddrinfo(hostname, None, family=socket.AF_INET):
            ip = item[4][0]
            if ip and not ip.startswith("127."):
                ips.add(ip)
    except OSError:
        pass

    return sorted(ips)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run local static host with usage stats API.")
    parser.add_argument("--host", default="127.0.0.1", help="Default: 127.0.0.1")
    parser.add_argument("--port", default=8011, type=int, help="Default: 8011")
    parser.add_argument("--html", default=DEFAULT_HTML, help=f"Default: {DEFAULT_HTML}")
    parser.add_argument("--open-browser", action="store_true", help="Open the local page after binding the server.")
    args = parser.parse_args()

    html_file = BASE_DIR / args.html
    if not html_file.exists():
        print(f"[ERROR] HTML file not found: {html_file}")
        return 1

    ensure_usage_stats_file()

    handler = partial(HomeHandler, target_html=args.html)
    server = ThreadingHTTPServer((args.host, args.port), handler)

    print(f"[OK] Local URL: http://127.0.0.1:{args.port}/")
    if args.host in ("0.0.0.0", "::"):
        ip_list = get_local_ipv4_list()
        if ip_list:
            print("[OK] LAN URLs:")
            for ip in ip_list:
                print(f"     http://{ip}:{args.port}/")
        else:
            print("[WARN] No LAN IP found. Try checking with ipconfig.")
    else:
        print(f"[OK] Host URL: http://{args.host}:{args.port}/")

    print(f"[INFO] Usage stats file: {USAGE_STATS_FILE}")
    print("[INFO] Press Ctrl+C to stop")

    if args.open_browser:
        webbrowser.open(f"http://127.0.0.1:{args.port}/")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        print("[OK] Server stopped")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
