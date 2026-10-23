"""Exercise real HTTP framing over a fake usbmux endpoint, including persistence."""
import base64
import contextlib
import io
import json
import plistlib
import socketserver
import struct
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/server'))
import ipadScreenUSB as usb


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        length, _, _, tag = struct.unpack('<IIII', self.rfile.read(16))
        message = plistlib.loads(self.rfile.read(length - 16))
        if message['MessageType'] == 'ListDevices':
            self.server.enumerations += 1
            result = {'DeviceList': [{'Properties': {'ConnectionType': 'USB', 'SerialNumber': 'ipad', 'DeviceID': 1}}]}
        else:
            self.server.connections += 1
            result = {'Number': 0}
        data = plistlib.dumps(result)
        self.wfile.write(struct.pack('<IIII', len(data) + 16, 1, 8, tag) + data)
        if message['MessageType'] == 'ListDevices':
            return
        while True:
            line = self.rfile.readline()
            if not line:
                return
            method, path, _ = line.decode().strip().split(' ')
            headers = {}
            while True:
                line = self.rfile.readline().decode().strip()
                if not line:
                    break
                name, value = line.split(':', 1)
                headers[name.lower()] = value.strip()
            self.server.bodies.append(self.rfile.read(int(headers['content-length'])))
            if path == '/events':
                self.wfile.write(b'HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n')
                self.wfile.write(b'{"page":"joints","viewportCommands":[{"sequence":1}]}\n')
                return
            keep = headers['connection'] == 'keep-alive' and not self.server.force_close
            body = json.dumps({'received': True, 'method': method}).encode()
            self.wfile.write(f'HTTP/1.1 200 OK\r\nContent-Length: {len(body)}\r\nConnection: {"keep-alive" if keep else "close"}\r\n\r\n'.encode() + body)
            if not keep:
                return


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.server = Server(('127.0.0.1', 0), Handler)
        self.server.enumerations = self.server.connections = 0
        self.server.bodies = []
        self.server.force_close = False
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.platform = patch.object(usb, 'sys', SimpleNamespace(platform='win32'))
        self.address = patch.object(usb, 'WINDOWS_MUX_ADDRESS', self.server.server_address)
        self.platform.start(); self.address.start()
        self.client = usb.Requests()
        self.command = {'deviceId': 'ipad', 'method': 'PUT', 'path': '/workspace', 'token': 'a' * 64,
                        'body': base64.b64encode(b'jpeg fixture').decode(), 'keepAlive': True}

    def tearDown(self):
        self.client.close()
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.platform.stop(); self.address.stop()

    def test_reuses_connection_and_isolates_sessions(self):
        for _ in range(6):
            self.assertEqual(self.client.request(self.command)['status'], 200)
        self.assertEqual((self.server.enumerations, self.server.connections), (1, 1))
        self.assertEqual(self.server.bodies, [b'jpeg fixture'] * 6)
        self.client.request({**self.command, 'token': 'b' * 64})
        self.assertEqual(self.server.connections, 2, 'a new session never inherits a previous socket')

    def test_respects_connection_close(self):
        self.server.force_close = True
        for _ in range(2):
            self.client.request(self.command)
        self.assertEqual(self.server.connections, 2)

    def test_events_arrive_without_image_requests(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(ConnectionError):
            usb.events(self.command)
        self.assertEqual(json.loads(output.getvalue())['event']['viewportCommands'][0]['sequence'], 1)
        self.assertEqual(self.server.bodies, [b''])


if __name__ == '__main__':
    unittest.main()
