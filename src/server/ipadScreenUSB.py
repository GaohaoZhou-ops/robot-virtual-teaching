#!/usr/bin/env python3
"""USB-only app TCP transport using Apple's local device service. JSON lines on stdio.

No network fallback, external package, local TCP proxy, or image files. The
usbmux framing follows libimobiledevice/libusbmuxd's public plist protocol.
"""
import base64
import http.client
import json
import plistlib
import socket
import struct
import sys

PORT = 21991
MAX_FRAME = 2 * 1024 * 1024
WINDOWS_MUX_ADDRESS = ('127.0.0.1', 27015)


def read_exact(sock, length):
    result = bytearray()
    while len(result) < length:
        chunk = sock.recv(length - len(result))
        if not chunk:
            raise ConnectionError('USB connection closed')
        result.extend(chunk)
    return bytes(result)


def mux(message):
    windows = sys.platform == 'win32'
    sock = socket.socket(socket.AF_INET if windows else socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(2)
    try:
        try:
            sock.connect(WINDOWS_MUX_ADDRESS if windows else '/var/run/usbmuxd')
        except OSError as error:
            if windows:
                raise ConnectionError('无法连接 Apple 设备服务。请安装并打开 Windows「Apple 设备」App（或含 Apple Mobile Device Support 的 iTunes），确认能识别已信任的 iPad，然后重试。') from error
            raise
        payload = plistlib.dumps({'ClientVersionString': 'AtlasScreen/1', 'ProgName': 'AtlasTeaching',
                                   'kLibUSBMuxVersion': 3, **message})
        sock.sendall(struct.pack('<IIII', len(payload) + 16, 1, 8, 1) + payload)
        length, version, kind, tag = struct.unpack('<IIII', read_exact(sock, 16))
        if not 16 <= length <= MAX_FRAME or version != 1 or kind != 8 or tag != 1:
            raise ValueError('Invalid usbmux response')
        return sock, plistlib.loads(read_exact(sock, length - 16))
    except Exception:
        sock.close()
        raise


def devices():
    sock, response = mux({'MessageType': 'ListDevices'})
    sock.close()
    return [item['Properties'] for item in response.get('DeviceList', [])
            if item.get('Properties', {}).get('ConnectionType') == 'USB']


def connect(device_id):
    device = next((d for d in devices() if d.get('SerialNumber') == device_id), None)
    if device is None:
        raise ConnectionError('USB device disconnected')
    sock, response = mux({'MessageType': 'Connect', 'DeviceID': device['DeviceID'],
                          'PortNumber': socket.htons(PORT)})
    try:
        if response.get('Number') != 0:
            raise ConnectionError('Open the updated Atlas app on the device')
        return sock
    except Exception:
        sock.close()
        raise


class Requests:
    """One image/state request at a time; controls use a separate USB socket."""
    def __init__(self):
        self.sock = None
        self.identity = None

    def close(self):
        if self.sock:
            self.sock.close()
        self.sock = None
        self.identity = None

    def request(self, command):
        body = base64.b64decode(command.get('body', ''), validate=True)
        method, path = command['method'], command['path']
        if method not in ('GET', 'POST', 'PUT', 'DELETE') or path not in ('/status', '/session', '/invitation', '/frame', '/heartbeat', '/workspace'):
            raise ValueError('Invalid app endpoint')
        token = command.get('token', '')
        if len(body) > MAX_FRAME or any(c not in 'abcdef0123456789' for c in token):
            raise ValueError('Invalid screen payload')
        persistent = command.get('keepAlive') is True
        identity = (command['deviceId'], token)
        if not persistent or identity != self.identity:
            self.close()
        try:
            if self.sock is None:
                self.sock = connect(command['deviceId'])
                self.identity = identity
            connection = 'keep-alive' if persistent else 'close'
            headers = f'{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: {connection}\r\nContent-Length: {len(body)}\r\nAuthorization: Bearer {token}\r\n\r\n'
            self.sock.sendall(headers.encode('ascii') + body)
            reply = http.client.HTTPResponse(self.sock)
            reply.begin()
            # Read the declared body, not until EOF on a persistent connection.
            if reply.length is None or reply.length > 65536:
                raise ValueError('Invalid app response length')
            payload = reply.read()
            if reply.will_close or not persistent or method == 'DELETE':
                self.close()
            return {'status': reply.status, 'body': json.loads(payload)}
        except Exception:
            self.close()
            raise


def request(command):
    client = Requests()
    try:
        return client.request(command)
    finally:
        client.close()


def events(command):
    """A bounded NDJSON control stream, independent of JPEG transfer/encoding."""
    token = command.get('token', '')
    if len(token) != 64 or any(c not in 'abcdef0123456789' for c in token):
        raise ValueError('Invalid event credentials')
    sock = connect(command['deviceId'])
    try:
        sock.settimeout(10)
        sock.sendall(f'GET /events HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 0\r\nAuthorization: Bearer {token}\r\n\r\n'.encode('ascii'))
        reply = http.client.HTTPResponse(sock)
        reply.begin()
        if reply.status != 200:
            raise ConnectionError('USB control stream rejected')
        while True:
            line = reply.readline(65537)
            if not line or len(line) > 65536 or not line.endswith(b'\n'):
                raise ConnectionError('USB control stream closed or invalid')
            print(json.dumps({'event': json.loads(line)}), flush=True)
    finally:
        sock.close()


def main():
    client = Requests()
    for line in sys.stdin:
        command = {}
        try:
            command = json.loads(line)
            if command['action'] == 'events':
                events(command)
                return
            value = ([{'id': d['SerialNumber']} for d in devices()] if command['action'] == 'devices'
                     else client.request(command))
            print(json.dumps({'value': value}), flush=True)
        except Exception as error:
            print(json.dumps({'error': str(error)}), flush=True)
            if isinstance(command, dict) and command.get('action') == 'events':
                return
    client.close()


if __name__ == '__main__':
    main()
