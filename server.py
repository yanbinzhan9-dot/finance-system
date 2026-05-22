from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import uuid
from base64 import b64decode
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
DATA_FILE = DATA_DIR / "finance-data.json"
RATE_API = "https://api.frankfurter.dev/v1"


def ensure_data_file() -> None:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    if not DATA_FILE.exists():
        DATA_FILE.write_text(
            json.dumps({"entries": [], "settlements": []}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


def read_state() -> dict:
    ensure_data_file()
    try:
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        data = {"entries": [], "settlements": []}
    return {
        "entries": data.get("entries", []) if isinstance(data.get("entries", []), list) else [],
        "settlements": data.get("settlements", []) if isinstance(data.get("settlements", []), list) else [],
    }


def write_state(data: dict) -> dict:
    ensure_data_file()
    cleaned = {
        "entries": data.get("entries", []) if isinstance(data.get("entries", []), list) else [],
        "settlements": data.get("settlements", []) if isinstance(data.get("settlements", []), list) else [],
    }
    for entry in cleaned["entries"]:
        entry["attachments"] = save_attachments(entry.get("attachments", []))
    DATA_FILE.write_text(json.dumps(cleaned, ensure_ascii=False, indent=2), encoding="utf-8")
    return cleaned


def save_attachments(attachments: list) -> list:
    saved = []
    for item in attachments:
        if not isinstance(item, dict):
            continue
        attachment = {
            "id": str(item.get("id") or uuid.uuid4().hex),
            "name": str(item.get("name") or "screenshot.jpg"),
        }
        if item.get("url"):
            attachment["url"] = item["url"]
            saved.append(attachment)
            continue
        data_url = item.get("dataUrl")
        if isinstance(data_url, str) and data_url.startswith("data:"):
            match = re.match(r"data:(.*?);base64,(.*)", data_url)
            if not match:
                continue
            mime_type, payload = match.groups()
            extension = mimetypes.guess_extension(mime_type) or ".jpg"
            filename = f"{attachment['id']}{extension}"
            file_path = UPLOAD_DIR / filename
            file_path.write_bytes(base64.b64decode(payload))
            attachment["url"] = f"/data/uploads/{filename}"
            saved.append(attachment)
    return saved


def fetch_rate(query: dict) -> dict:
    date = first_query_value(query, "date")
    base = first_query_value(query, "base") or "USD"
    target = first_query_value(query, "target") or "CNY"
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date or ""):
      raise ValueError("date must be YYYY-MM-DD")
    if not re.fullmatch(r"[A-Z]{3}", base) or not re.fullmatch(r"[A-Z]{3}", target):
      raise ValueError("currency must be ISO 4217 code")
    if base == target:
        return {"date": date, "base": base, "target": target, "rate": 1}
    params = urlencode({"from": base, "to": target})
    request = Request(
        f"{RATE_API}/{date}?{params}",
        headers={"User-Agent": "FinanceSystem/1.0"},
    )
    with urlopen(request, timeout=8) as response:
        payload = json.loads(response.read().decode("utf-8"))
    rate = payload.get("rates", {}).get(target)
    if not rate:
        raise ValueError("rate not found")
    return {
        "date": payload.get("date", date),
        "base": base,
        "target": target,
        "rate": rate,
        "source": "Frankfurter",
    }


def first_query_value(query: dict, name: str) -> str:
    values = query.get(name) or []
    return values[0] if values else ""


class FinanceHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def authenticate(self) -> bool:
        username = os.environ.get("FINANCE_USER")
        password = os.environ.get("FINANCE_PASSWORD")
        if not username or not password:
            return True
        auth_header = self.headers.get("Authorization", "")
        if auth_header.startswith("Basic "):
            try:
                decoded = b64decode(auth_header.split(" ", 1)[1]).decode("utf-8")
                if decoded == f"{username}:{password}":
                    return True
            except Exception:
                pass
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="Finance System"')
        self.end_headers()
        return False

    def do_GET(self) -> None:
        if not self.authenticate():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            self.send_json(read_state())
            return
        if parsed.path == "/api/rate":
            try:
                self.send_json(fetch_rate(parse_qs(parsed.query)))
            except Exception as exc:
                self.send_error(502, explain=str(exc))
            return
        super().do_GET()

    def do_POST(self) -> None:
        if not self.authenticate():
            return
        if urlparse(self.path).path != "/api/state":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            body = self.rfile.read(length).decode("utf-8")
            data = json.loads(body)
            self.send_json(write_state(data))
        except Exception as exc:
            self.send_error(400, explain=str(exc))

    def send_json(self, data: dict) -> None:
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    ensure_data_file()
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8765"))
    server = ThreadingHTTPServer((host, port), FinanceHandler)
    print(f"财务系统已启动：http://{host}:{port}/index.html")
    server.serve_forever()
