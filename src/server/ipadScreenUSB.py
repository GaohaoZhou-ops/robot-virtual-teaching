#!/usr/bin/env python3
"""USB-only app TCP transport using macOS usbmuxd. JSON lines on stdio.

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


def read_exact(sock, length):
    result = bytearray()
    while len(result) < length:
        chunk = sock.recv(length - len(result))
        if not chunk:
            raise ConnectionError('USB connection closed')
        result.extend(chunk)
    return bytes(result)


def mux(message):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(2)
    try:
        sock.connect('/var/run/usbmuxd')
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


def request(command):
    device = next((d for d in devices() if d.get('SerialNumber') == command['deviceId']), None)
    if device is None:
        raise ConnectionError('USB device disconnected')
    sock, response = mux({'MessageType': 'Connect', 'DeviceID': device['DeviceID'],
                          'PortNumber': socket.htons(PORT)})
    try:
        if response.get('Number') != 0:
            raise ConnectionError('Open the updated Atlas app on the device')
        body = base64.b64decode(command.get('body', ''), validate=True)
        method, path = command['method'], command['path']
        if method not in ('GET', 'POST', 'PUT', 'DELETE') or path not in ('/status', '/session', '/frame', '/heartbeat', '/workspace'):
            raise ValueError('Invalid app endpoint')
        token = command.get('token', '')
        if len(body) > MAX_FRAME or any(c not in 'abcdef0123456789' for c in token):
            raise ValueError('Invalid screen payload')
        headers = f'{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: {len(body)}\r\nAuthorization: Bearer {token}\r\n\r\n'
        sock.sendall(headers.encode('ascii') + body)
        reply = http.client.HTTPResponse(sock)
        reply.begin()
        payload = reply.read(65537)
        if len(payload) > 65536:
            raise ValueError('App response too large')
        return {'status': reply.status, 'body': json.loads(payload)}
    finally:
        sock.close()


def main():
    for line in sys.stdin:
        try:
            command = json.loads(line)
            value = ([{'id': d['SerialNumber']} for d in devices()] if command['action'] == 'devices'
                     else request(command))
            print(json.dumps({'value': value}), flush=True)
        except Exception as error:
            print(json.dumps({'error': str(error)}), flush=True)


if __name__ == '__main__':
    main()
