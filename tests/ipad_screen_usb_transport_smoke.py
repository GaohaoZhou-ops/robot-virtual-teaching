"""Exercise real HTTP framing over a fake usbmux endpoint, including persistence."""
import base64
import contextlib
import io
import json
import plistlib
import socketserver
import struct
import subprocess
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


class DeviceNameTests(unittest.TestCase):
    def setUp(self):
        self.platform = patch.object(usb, 'sys', SimpleNamespace(platform='darwin'))
        self.cache = patch.object(usb, '_name_cache', {'ids': (), 'updated': float('-inf'), 'names': {}})
        self.platform.start(); self.cache.start()
        self.addCleanup(self.platform.stop); self.addCleanup(self.cache.stop)
        self.air = {'ConnectionType': 'USB', 'SerialNumber': '00008122-0014118A2223801C', 'DeviceID': 1}
        self.pro = {'ConnectionType': 'USB', 'SerialNumber': '00008027-001910CE0184402E', 'DeviceID': 2}
        self.catalog = [{'hardwareProperties': {'udid': self.pro['SerialNumber'], 'marketingName': 'iPad Pro'},
                         'deviceProperties': {'name': 'Office iPad'}},
                        {'hardwareProperties': {'udid': self.air['SerialNumber'], 'marketingName': 'iPad Air 11-inch (M3)'},
                         'deviceProperties': {'name': 'Xiaoshen iPadAir'}}]

    def coredevice(self, args, **kwargs):
        self.assertEqual(args[:4], ['xcrun', 'devicectl', 'list', 'devices'])
        self.assertLessEqual(kwargs['timeout'], 2)
        output = Path(args[args.index('--json-output') + 1])
        output.write_text(json.dumps({'info': {'outcome': 'success'}, 'result': {'devices': self.catalog}}))

    def test_matches_usb_udid_and_caches_names_without_adding_wireless_devices(self):
        with patch.object(usb, 'devices', return_value=[self.air]), patch.object(usb.subprocess, 'run', side_effect=self.coredevice) as run:
            first = usb.described_devices()
            self.assertEqual(first, [{'id': self.air['SerialNumber'], 'name': 'Xiaoshen iPadAir · iPad Air 11-inch (M3)'}])
            self.assertEqual(usb.described_devices(), first)
            self.assertEqual(run.call_count, 1)
            self.catalog[1]['deviceProperties']['name'] = 'Renamed iPad'
            with patch.object(usb.time, 'monotonic', return_value=usb._name_cache['updated'] + 31):
                self.assertIn('Renamed iPad', usb.described_devices()[0]['name'])
            self.assertEqual(run.call_count, 2)

    def test_same_name_devices_remain_distinguishable(self):
        for item in self.catalog:
            item['deviceProperties']['name'] = 'Office iPad'
            item['hardwareProperties']['marketingName'] = 'iPad Air'
        with patch.object(usb, 'devices', return_value=[self.air, self.pro]), patch.object(usb.subprocess, 'run', side_effect=self.coredevice):
            result = usb.described_devices()
        self.assertEqual([item['name'] for item in result], ['Office iPad · iPad Air · 2223801C', 'Office iPad · iPad Air · 0184402E'])

    def test_missing_or_slow_xcode_does_not_prevent_usb_discovery(self):
        for error in [FileNotFoundError('xcrun'), subprocess.TimeoutExpired('xcrun', 2)]:
            usb._name_cache['updated'] = float('-inf')
            with patch.object(usb, 'devices', return_value=[self.air]), patch.object(usb.subprocess, 'run', side_effect=error):
                device = usb.described_devices()[0]
                self.assertEqual(usb.device_name(device, 'iPad'), 'iPad · 2223801C')
                self.assertEqual(usb.device_name(device, 'Custom iPad'), 'Custom iPad')

    def test_windows_does_not_invoke_xcode(self):
        with patch.object(usb, 'sys', SimpleNamespace(platform='win32')), patch.object(usb, 'devices', return_value=[self.air]), patch.object(usb.subprocess, 'run') as run:
            self.assertEqual(usb.described_devices()[0]['id'], self.air['SerialNumber'])
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
