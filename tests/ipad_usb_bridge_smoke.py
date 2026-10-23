"""Windows usbmux framing and local companion lifecycle, without Apple drivers."""
import http.client
import json
import plistlib
import socketserver
import struct
import sys
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/server'))
import ipadScreenUSB as usb
from ipadUSBBridge import BridgeServer, BridgeState, PROTOCOL


class FakePad:
    def __init__(self):
        self.device_id = 'windows-ipad-0001'
        self.active = False
        self.token = ''
        self.frames = []
        self.workspace = {}
        self.heartbeats = 0
        self.commands = []
        self.viewport_commands = []
        self.capture = None
        self.page = 'cameras'

    def request(self, method, path, body, token):
        if path == '/status':
            return 200, {'protocol': PROTOCOL, 'deviceName': 'Windows USB iPad', 'active': self.active,
                         'keepalive': True, 'jointControl': True}
        if path == '/session' and method == 'POST':
            assert json.loads(body)['protocol'] == PROTOCOL
            self.active = True
            self.token = token
        elif token != self.token or not self.active:
            return 401, {'error': 'iPad session ended'}
        elif path == '/session' and method == 'DELETE':
            self.active = False
        elif path == '/frame':
            self.frames.append(body)
        elif path == '/workspace':
            size = struct.unpack('>I', body[:4])[0]
            self.workspace = json.loads(body[8:8 + size])
            self.commands = [c for c in self.commands if c['sequence'] > self.workspace.get('ack', 0)]
            self.viewport_commands = [c for c in self.viewport_commands if c['sequence'] > self.workspace.get('viewportControl', {}).get('ack', 0)]
            if (self.workspace.get('captureResult') or {}).get('id') == (self.capture or {}).get('id'):
                self.capture = None
        elif path == '/heartbeat':
            self.heartbeats += 1
        return 200, {'active': self.active, 'page': self.page, 'commands': self.commands,
                     'viewportCommands': self.viewport_commands, 'captureRequest': self.capture}


class FakeMux(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, pad):
        self.pad = pad
        super().__init__(('127.0.0.1', 0), MuxHandler)


class MuxHandler(socketserver.BaseRequestHandler):
    def handle(self):
        size, version, kind, tag = struct.unpack('<IIII', usb.read_exact(self.request, 16))
        assert (version, kind) == (1, 8)
        message = plistlib.loads(usb.read_exact(self.request, size - 16))
        pad = self.server.pad
        if message['MessageType'] == 'ListDevices':
            result = {'DeviceList': [
                {'Properties': {'DeviceID': 2, 'SerialNumber': 'wireless-device', 'ConnectionType': 'Network'}},
                {'Properties': {'DeviceID': 7, 'SerialNumber': pad.device_id, 'ConnectionType': 'USB'}}]}
        else:
            assert message['MessageType'] == 'Connect'
            assert message['DeviceID'] == 7
            assert message['PortNumber'] == __import__('socket').htons(21991)
            result = {'MessageType': 'Result', 'Number': 0}
        payload = plistlib.dumps(result)
        self.request.sendall(struct.pack('<IIII', len(payload) + 16, 1, 8, tag) + payload)
        if message['MessageType'] != 'Connect':
            return
        with self.request.makefile('rb') as incoming:
            method, path, _ = incoming.readline().decode().strip().split(' ')
            headers = {}
            while True:
                line = incoming.readline().decode().strip()
                if not line:
                    break
                name, value = line.split(':', 1)
                headers[name.lower()] = value.strip()
            body = incoming.read(int(headers.get('content-length', 0)))
        code, value = pad.request(method, path, body, headers.get('authorization', '').removeprefix('Bearer '))
        body = json.dumps(value).encode()
        self.request.sendall(f'HTTP/1.1 {code} OK\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n'.encode() + body)


class BridgeFixture:
    def __init__(self, port=0):
        self.pad = FakePad()
        self.mux = FakeMux(self.pad)
        self.original_sys, self.original_address = usb.sys, usb.WINDOWS_MUX_ADDRESS
        usb.sys = SimpleNamespace(platform='win32')
        usb.WINDOWS_MUX_ADDRESS = self.mux.server_address
        self.mux_thread = threading.Thread(target=self.mux.serve_forever, daemon=True)
        self.mux_thread.start()
        self.state = BridgeState()
        self.server = BridgeServer(('127.0.0.1', port), self.state)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_port

    def close(self):
        self.state.close()
        self.server.shutdown(); self.server.server_close()
        self.mux.shutdown(); self.mux.server_close()
        self.thread.join(); self.mux_thread.join()
        usb.sys, usb.WINDOWS_MUX_ADDRESS = self.original_sys, self.original_address


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.fixture = BridgeFixture()
        self.pad = self.fixture.pad
        self.secret = self.fixture.state.secret

    def tearDown(self):
        self.fixture.close()

    def api(self, path, method='GET', body=None, token=None, headers=None, status=200):
        connection = http.client.HTTPConnection('127.0.0.1', self.fixture.port, timeout=10)
        request_headers = {'X-Atlas-Bridge': self.secret, **(headers or {})}
        if token:
            request_headers['Authorization'] = 'Bearer ' + token
        if isinstance(body, dict):
            body = json.dumps(body)
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        raw = response.read(); connection.close()
        self.assertEqual(response.status, status, raw)
        return json.loads(raw) if response.getheader('Content-Type', '').startswith('application/json') else raw

    def test_windows_mux_and_security(self):
        self.assertEqual([d['SerialNumber'] for d in usb.devices()], [self.pad.device_id])
        self.assertEqual(self.api('/api/devices')['devices'][0]['ready'], True)
        self.api('/api/devices', headers={'Origin': 'http://malicious.example'}, status=403)
        self.api('/api/devices', headers={'Host': 'rebind.example'}, status=403)
        self.api('/api/devices', headers={'X-Atlas-Bridge': ''}, status=403)
        self.api('/api/devices', method='OPTIONS', headers={'Origin': 'http://malicious.example'}, status=403)
        self.api('/api/session', method='POST', body='null', status=400)
        self.api('/api/session', method='POST', body='{', status=400)
        html = self.api('/')
        self.assertIn(self.secret.encode(), html)
        self.api('/api/session', 'POST', {'deviceId': 'wireless-device'}, status=503)
        ticket = self.api('/api/session', 'POST', {'deviceId': self.pad.device_id}, status=201)
        route = '/api/session/' + ticket['id']
        self.api('/api/session', 'POST', {'deviceId': self.pad.device_id}, status=409)
        self.api(route, 'DELETE', token='0' * 64, status=401)
        self.assertTrue(self.pad.active)
        self.api(route + '/frame', 'PUT', b'broken', ticket['token'], status=400)
        self.assertTrue(self.pad.active, 'malformed frames do not end an authorized session')
        self.api(route, 'DELETE', token=ticket['token'])
        self.assertFalse(self.pad.active)
        self.api(route, 'DELETE', token=ticket['token'], status=410)

    def test_frames_controls_and_background_lifecycle(self):
        ticket = self.api('/api/session', 'POST', {'deviceId': self.pad.device_id}, status=201)
        route = '/api/session/' + ticket['id']
        connection = http.client.HTTPConnection('127.0.0.1', self.fixture.port, timeout=10)
        connection.request('GET', route + '/events', headers={'X-Atlas-Bridge': self.secret, 'Authorization': 'Bearer ' + ticket['token']})
        events = connection.getresponse()
        self.assertEqual(json.loads(events.readline()), {'ready': True})
        self.api(route + '/events', token=ticket['token'], status=409)
        jpeg = b'\xff\xd8\x12\xff\xd9'
        frame = struct.pack('>II', len(jpeg), len(jpeg)) + jpeg * 2
        self.api(route + '/frame', 'PUT', frame, ticket['token'])
        self.assertEqual(self.pad.frames, [frame])
        self.pad.commands = [{'name': 'left_J1', 'value': 15, 'sequence': 1}]
        state = json.dumps({'robotId': 'robot', 'joints': [], 'ack': 0}).encode()
        workspace = struct.pack('>II', len(state), 0) + state
        result = self.api(route + '/workspace', 'PUT', workspace, ticket['token'])
        self.assertEqual(result['commands'], self.pad.commands)
        while True:
            event = json.loads(events.readline())
            if event.get('commands'):
                self.assertLess(abs(event['commands'][0]['receivedAt'] - time.time() * 1000), 1000)
                break
        deadline = time.monotonic() + 5
        while self.pad.heartbeats == 0 and time.monotonic() < deadline:
            json.loads(events.readline())
        self.assertGreater(self.pad.heartbeats, 0, 'native heartbeat survives paused rendering')
        self.assertEqual(len(self.pad.frames), 1, 'heartbeat does not replay a stale JPEG')
        self.api(route, 'DELETE', token=ticket['token'])
        events.close(); connection.close()
        self.assertFalse(self.pad.active)
        second = self.api('/api/session', 'POST', {'deviceId': self.pad.device_id}, status=201)
        self.assertNotEqual(second['id'], ticket['id'])
        self.fixture.state.session['ownerSeen'] = time.monotonic() - 11
        deadline = time.monotonic() + 3
        while self.pad.active and time.monotonic() < deadline:
            time.sleep(.05)
        self.assertFalse(self.pad.active, 'an invitation without a browser stream expires')


if __name__ == '__main__':
    unittest.main()
