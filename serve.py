#!/usr/bin/env python3
"""Static server for local verification of the draft board."""
import http.server, os, socketserver, sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
    def log_message(self, *a):
        pass

with socketserver.TCPServer(("127.0.0.1", port), H) as httpd:
    print(f"serving on http://localhost:{port}")
    sys.stdout.flush()
    httpd.serve_forever()
