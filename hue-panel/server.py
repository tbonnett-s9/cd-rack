#!/usr/bin/env python3
"""Tiny zero-dependency server for the Hue touch panel.

It serves the panel (index.html) AND proxies calls to the Hue Bridge, so the
iPad's browser only ever talks same-origin HTTP — no CORS, no mixed content,
which is exactly what the old iOS 9 Safari needs.

Run:  python3 server.py
Then open  http://<this-mac-ip>:8080/  on the iPad.
"""
import json, os, ssl, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "config.json")
PORT = 8080


def load_cfg():
    try:
        with open(CONFIG) as f:
            return json.load(f)
    except Exception:
        return {}


def save_cfg(c):
    with open(CONFIG, "w") as f:
        json.dump(c, f)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _body(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        return self.rfile.read(n) if n else b""

    # ── Routing ─────────────────────────────────────────────
    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/api/state":
            c = load_cfg()
            return self._send(200, {"paired": bool(c.get("username")),
                                    "bridge_ip": c.get("bridge_ip", "")})
        if p.startswith("/hue/"):
            return self.proxy("GET", p)
        return self.serve_static(p)

    def do_PUT(self):
        p = self.path.split("?")[0]
        if p.startswith("/hue/"):
            return self.proxy("PUT", p, self._body())
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        p = self.path.split("?")[0]
        if p == "/api/discover":
            return self.discover()
        if p == "/api/pair":
            return self.pair()
        if p == "/api/set-ip":
            return self.set_ip(self._body())
        return self._send(404, {"error": "not found"})

    # ── Static files ────────────────────────────────────────
    def serve_static(self, p):
        if p == "/":
            p = "/index.html"
        fp = os.path.normpath(os.path.join(HERE, p.lstrip("/")))
        if not fp.startswith(HERE) or not os.path.isfile(fp):
            return self._send(404, "not found", "text/plain")
        ctype = "text/html" if fp.endswith(".html") else "application/octet-stream"
        with open(fp, "rb") as f:
            self._send(200, f.read(), ctype)

    # ── Bridge discovery / pairing ──────────────────────────
    def discover(self):
        try:
            ctx = ssl._create_unverified_context()
            req = urllib.request.Request("https://discovery.meethue.com/")
            with urllib.request.urlopen(req, timeout=8, context=ctx) as r:
                arr = json.loads(r.read())
            ip = arr[0].get("internalipaddress") if arr else ""
            if ip:
                c = load_cfg(); c["bridge_ip"] = ip; save_cfg(c)
            return self._send(200, {"bridge_ip": ip})
        except Exception as e:
            return self._send(200, {"bridge_ip": "", "error": str(e)})

    def set_ip(self, body):
        try:
            ip = json.loads(body or b"{}").get("ip", "").strip()
            c = load_cfg(); c["bridge_ip"] = ip; save_cfg(c)
            return self._send(200, {"bridge_ip": ip})
        except Exception as e:
            return self._send(400, {"error": str(e)})

    def pair(self):
        c = load_cfg(); ip = c.get("bridge_ip")
        if not ip:
            return self._send(200, {"error": "no_bridge"})
        try:
            data = json.dumps({"devicetype": "huepanel#mac"}).encode()
            req = urllib.request.Request("http://%s/api" % ip, data=data, method="POST")
            req.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(req, timeout=8) as r:
                arr = json.loads(r.read())
            if arr and "success" in arr[0]:
                c["username"] = arr[0]["success"]["username"]; save_cfg(c)
                return self._send(200, {"paired": True})
            return self._send(200, {"error": "press_button"})
        except Exception as e:
            return self._send(200, {"error": str(e)})

    # ── Proxy to the Bridge ─────────────────────────────────
    def proxy(self, method, p, body=None):
        c = load_cfg(); ip = c.get("bridge_ip"); user = c.get("username")
        if not ip or not user:
            return self._send(200, {"error": "not_paired"})
        rest = p[len("/hue/"):]
        url = "http://%s/api/%s/%s" % (ip, user, rest)
        try:
            req = urllib.request.Request(url, data=(body or None), method=method)
            if body:
                req.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(req, timeout=8) as r:
                return self._send(200, r.read(), "application/json")
        except urllib.error.HTTPError as e:
            return self._send(e.code, e.read(), "application/json")
        except Exception as e:
            return self._send(502, {"error": str(e)})

    def log_message(self, *a):
        pass  # keep the console quiet


if __name__ == "__main__":
    print("Hue panel serving on http://0.0.0.0:%d" % PORT)
    print("Open  http://<this-mac-ip>:%d/  on the iPad." % PORT)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
