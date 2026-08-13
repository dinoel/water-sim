#!/usr/bin/env python3
"""
Локальный сервер для многопоточного режима.

    python serve.py            # http://localhost:8000
    python serve.py 8080

Зачем он нужен. Потоки делят память через SharedArrayBuffer, а браузер даёт
его только «изолированному» источнику — странице, которая объявила заголовки
Cross-Origin-Opener-Policy и Cross-Origin-Embedder-Policy. Поставить их
может только сервер, файл, открытый двойным щелчком, их не имеет. Поэтому
без этого скрипта симулятор работает, но в один поток.
"""
import sys
import os
import http.server
import socketserver

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # то, ради чего всё затевалось
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        # правки в js должны подхватываться сразу, без ручного сброса кэша
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        if '404' in (fmt % args):
            super().log_message(fmt, *args)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with Server(('127.0.0.1', PORT), Handler) as httpd:
        print('Симулятор воды: http://localhost:%d' % PORT)
        print('Многопоточный режим включён (COOP/COEP выставлены).')
        print('Ctrl+C — остановить.')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nостановлен')
