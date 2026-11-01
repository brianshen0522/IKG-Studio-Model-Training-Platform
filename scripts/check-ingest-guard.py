"""Self-check for the model URL guard: non-public addresses are refused, both when the
hostname is checked and when the connection has actually been made.
Run: uv run --project workers/dataset-worker python scripts/check-ingest-guard.py
"""
import os
import sys
import threading
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "workers/dataset-worker/src"))
from dataset_worker import model_ingest as mi  # noqa: E402


def refused(address: str, allow_private: bool = False) -> bool:
    try:
        mi._assert_public_ip(address, allow_private)
    except mi.IngestError:
        return True
    return False


for blocked in ("127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254",
                "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1",
                "::ffff:10.0.0.1", "224.0.0.1"):
    assert refused(blocked), blocked
for allowed in ("8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"):
    assert not refused(allowed), allowed
assert not refused("10.0.0.1", allow_private=True)
assert refused("169.254.169.254", allow_private=True)
assert refused("::ffff:169.254.169.254", allow_private=True)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{server.server_port}/"

# A name that passes the check and then connects somewhere private is stopped at connect.
try:
    mi._build_opener(allow_private=False).open(url, timeout=5)
    raise AssertionError("connection to a loopback peer was allowed")
except mi.IngestError:
    pass
except urllib.error.URLError as e:
    assert isinstance(e.reason, mi.IngestError), e

# Metadata services stay blocked when private networks are allowed.
for address in ("169.254.169.254", "169.254.170.2", "168.63.129.16", "100.100.100.200", "fd00:ec2::254"):
    assert refused(address, allow_private=True), address

assert mi._build_opener(allow_private=True).open(url, timeout=5).read() == b"ok"
server.shutdown()
print("ingest guard ok")
