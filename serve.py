#!/usr/bin/env python3
"""Mini servidor HTTP local para TSAgestor.

Abrir index.html con file:// hace que el navegador trate el origen como
"null" y bloquee por CORS las peticiones a las APIs externas (METAR/TAF,
RainViewer, EUMETView). Servir desde http://127.0.0.1:8000 evita ese
problema.

Uso:
    python serve.py            # puerto 8000
    python serve.py 9000       # puerto custom
"""
from __future__ import annotations

import http.server
import os
import socketserver
import sys
import webbrowser

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.abspath(__file__))


def main() -> None:
    os.chdir(ROOT)
    handler = http.server.SimpleHTTPRequestHandler
    with socketserver.TCPServer(("127.0.0.1", PORT), handler) as httpd:
        url = f"http://127.0.0.1:{PORT}/index.html"
        print(f"TSAgestor servido en {url}")
        print("Pulsa Ctrl+C para parar.")
        try:
            webbrowser.open(url)
        except Exception:
            pass
        httpd.serve_forever()


if __name__ == "__main__":
    main()
