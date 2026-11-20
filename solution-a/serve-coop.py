#!/usr/bin/env python3
"""Static server with COOP/COEP headers (required by BrowserPod/SharedArrayBuffer),
serving the whole POC root so solution-a can read ../shared-tests."""
import http.server
import os
import socketserver

PORT = 8998
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        super().end_headers()


class ReuseAddrServer(socketserver.TCPServer):
    allow_reuse_address = True


with ReuseAddrServer(("", PORT), Handler) as httpd:
    print(f"Serving {ROOT} with COOP/COEP on :{PORT}")
    httpd.serve_forever()
