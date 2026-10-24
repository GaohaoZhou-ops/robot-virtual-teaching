#!/usr/bin/env python3
"""Local, USB-only companion for a workbench served by another computer.

Only Python's standard library is required. Browser windows exchange messages
locally; the server hosting the workbench never receives collaboration frames.
"""
import argparse
import base64
import json
import queue
import re
import secrets
import socket
import struct
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import ipadScreenUSB as usb

PROTOCOL = 'atlas-ipad-screen/1'
ASSETS = Path(__file__).resolve().parent / 'web'
if not ASSETS.is_dir():
    ASSETS = Path(__file__).resolve().parents[1] / 'usbBridge'


class BridgeError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class BridgeState:
    def __init__(self, transport=usb):
        self.transport = transport
        self.secret = secrets.token_hex(32)
        self.lock = threading.RLock()
        self.session = None
        self.closed = threading.Event()
        self.worker = threading.Thread(target=self.keepalive, daemon=True)
        self.worker.start()

    def call(self, device_id, method, path, body=b'', token=''):
        try:
            response = self.transport.request({'deviceId': device_id, 'method': method, 'path': path,
                                               'body': base64.b64encode(body).decode(), 'token': token})
        except Exception as error:
            raise BridgeError(503, str(error)) from error
        if response['status'] >= 400:
            raise BridgeError(response['status'], response['body'].get('error', 'iPad 连接失败，请重新连接。'))
        return response['body']

    def discover(self):
        with self.lock:
            devices = []
            for device in self.transport.devices():
                device_id = device['SerialNumber']
                try:
                    status = self.call(device_id, 'GET', '/status')
                    ready = (status.get('protocol') == PROTOCOL and status.get('keepalive') is True
                             and status.get('jointControl') is True and status.get('usbInvitations') is True
                             and not status.get('active')
                             and (not status.get('invitationPending') or bool(status.get('outgoingInvitation'))))
                    devices.append({'id': device_id, 'name': status.get('deviceName', 'iPad'), 'ready': ready,
                                    'outgoingInvitation': status.get('outgoingInvitation'),
                                    'active': bool(status.get('active')), 'message': '正在进行画面协作' if status.get('active')
                                    else '' if ready else '请更新 Atlas App 并保持在前台。'})
                except Exception:
                    devices.append({'id': device_id, 'name': 'USB 设备', 'ready': False,
                                    'message': '请解锁并信任这台电脑，在前台打开 Atlas App。'})
            return {'supported': True, 'devices': devices,
                    'message': '' if devices else '请用支持数据传输的线缆连接 iPad，解锁并信任电脑，再打开 Atlas App。'}

    def invitations(self):
        with self.lock:
            if self.session:
                return {'invitations': []}
            return {'invitations': [
                {'deviceId': device['id'], 'deviceName': device['name'],
                 'invitationId': device['outgoingInvitation']['id'], 'expiresAt': device['outgoingInvitation']['expiresAt']}
                for device in self.discover()['devices'] if device['ready']
                and isinstance(device.get('outgoingInvitation'), dict)
                and re.fullmatch(r'[a-f0-9-]{36}', str(device['outgoingInvitation'].get('id', '')))
                and isinstance(device['outgoingInvitation'].get('expiresAt'), (int, float))]}

    def reject_invitation(self, device_id, invitation_id):
        with self.lock:
            if not isinstance(device_id, str) or not re.fullmatch(r'[a-zA-Z0-9-]{8,80}', device_id) \
                    or not isinstance(invitation_id, str) or not re.fullmatch(r'[a-f0-9-]{36}', invitation_id):
                raise BridgeError(400, '邀请参数无效')
            self.call(device_id, 'POST', '/invitation', json.dumps({'id': invitation_id, 'decision': 'reject'}).encode())
            return {'rejected': True}

    def start(self, device_id, invitation_id=None):
        with self.lock:
            if self.session:
                raise BridgeError(409, '已有数据线协作，请先结束当前协作。')
            if not isinstance(device_id, str) or not re.fullmatch(r'[a-zA-Z0-9-]{8,80}', device_id):
                raise BridgeError(400, '设备参数无效')
            status = self.call(device_id, 'GET', '/status')
            if status.get('active'):
                raise BridgeError(409, 'iPad 正在协作，请先在 iPad 上结束当前协作。')
            if status.get('protocol') != PROTOCOL or not status.get('keepalive') or not status.get('jointControl') \
                    or status.get('usbInvitations') is not True:
                raise BridgeError(409, '请更新 iPad 上的 Atlas App 以支持双向协作邀请。')
            if invitation_id is not None and (not isinstance(invitation_id, str)
                    or not re.fullmatch(r'[a-f0-9-]{36}', invitation_id)
                    or (status.get('outgoingInvitation') or {}).get('id') != invitation_id):
                raise BridgeError(409, '邀请已取消或过期，请重新发起。')
            current = {'id': str(uuid.uuid4()), 'token': secrets.token_hex(32), 'deviceId': device_id,
                       'deviceName': status.get('deviceName', 'iPad'), 'mode': 'usb',
                       'updated': time.monotonic(), 'ownerSeen': time.monotonic(), 'watching': False,
                       'invitationDeadline': time.monotonic() + 60, 'deviceReady': False,
                       'events': queue.Queue(maxsize=8), 'ended': False}
            payload = {'protocol': PROTOCOL, 'sessionId': current['id'], 'computerName': socket.gethostname()[:80]}
            if invitation_id:
                payload['invitationId'] = invitation_id
            reply = self.call(device_id, 'POST', '/session', json.dumps(payload).encode(), current['token'])
            current['deviceReady'] = reply.get('ready') is True
            if not current['deviceReady'] and reply.get('invitationStatus') != 'pending':
                raise BridgeError(409, '协作邀请已拒绝或失效，请重新发起。')
            self.session = current
            return {key: current[key] for key in ('id', 'token', 'deviceName', 'mode', 'deviceReady')}

    def authorize(self, session_id, authorization):
        current = self.session
        if not current or current['id'] != session_id:
            raise BridgeError(410, '数据线协作已结束，请重新连接。')
        if not secrets.compare_digest(authorization, 'Bearer ' + current['token']):
            raise BridgeError(401, '协作凭据无效')
        return current

    @staticmethod
    def publish(current, status):
        # Commands remain on the iPad until acknowledged by the workbench; keep
        # only recent status under backpressure, never an unbounded frame queue.
        value = {key: status[key] for key in ('page', 'commands', 'captureRequest', 'viewportCommands', 'error', 'deviceReady', 'deviceName') if key in status}
        # Timestamp on native receipt, before queuing. The workbench reuses the
        # existing sequence/age/robot/task/soft-limit checks for every command.
        received = time.time() * 1000
        for key in ('commands', 'viewportCommands'):
            candidates = status.get(key)
            value[key] = sorted([{**command, 'receivedAt': received} for command in
                                 (candidates[:128] if isinstance(candidates, list) else [])
                                 if isinstance(command, dict) and isinstance(command.get('sequence'), int)],
                                key=lambda command: command['sequence'])
        if isinstance(status.get('captureRequest'), dict):
            value['captureRequest'] = {**status['captureRequest'], 'receivedAt': received}
        if current['events'].full():
            try:
                current['events'].get_nowait()
            except queue.Empty:
                pass
        current['events'].put_nowait(value)

    def stop(self, current, message=None):
        with self.lock:
            if current is not self.session:
                return
            self.session = None
            current['ended'] = True
            self.publish(current, {'error': message or '数据线协作已结束。'})
            try:
                self.call(current['deviceId'], 'DELETE', '/session', token=current['token'])
            except Exception:
                pass

    def relay(self, current, route, body):
        with self.lock:
            if self.session is not current:
                raise BridgeError(410, '数据线协作已结束')
            if not current['deviceReady']:
                raise BridgeError(409, '请等待 iPad 接受协作邀请')
            validate_payload(route, body)
            try:
                result = self.call(current['deviceId'], 'PUT', route, body, current['token'])
                current['updated'] = time.monotonic()
                self.publish(current, result)
                return result
            except BridgeError as error:
                self.stop(current, str(error))
                raise

    def keepalive(self):
        while not self.closed.wait(0.5):
            with self.lock:
                current = self.session
                if not current:
                    continue
                now = time.monotonic()
                if now - current['ownerSeen'] > 10:
                    self.stop(current, '电脑连接窗口已关闭，请重新连接。')
                elif not current['deviceReady']:
                    if now >= current['invitationDeadline']:
                        self.stop(current, '协作邀请已过期，请重新发起。')
                    elif now - current['updated'] >= 0.75:
                        try:
                            reply = self.call(current['deviceId'], 'GET', '/session', token=current['token'])
                            current['updated'] = time.monotonic()
                            if reply.get('ready') is True:
                                current['deviceReady'] = True
                                self.publish(current, {'deviceReady': True, 'deviceName': current['deviceName']})
                            elif reply.get('invitationStatus') != 'pending':
                                self.stop(current, 'iPad 已拒绝此次协作邀请。' if reply.get('invitationStatus') == 'rejected'
                                          else '协作邀请已取消或过期。')
                        except BridgeError as error:
                            self.stop(current, str(error))
                elif now - current['updated'] >= 2:
                    try:
                        status = self.call(current['deviceId'], 'PUT', '/heartbeat', token=current['token'])
                        current['updated'] = time.monotonic()
                        self.publish(current, status)
                    except BridgeError as error:
                        self.stop(current, str(error))

    def close(self):
        self.closed.set()
        if self.session:
            self.stop(self.session)
        self.worker.join(timeout=5)


def validate_payload(route, body):
    if not 8 <= len(body) <= usb.MAX_FRAME:
        raise BridgeError(400, '画面数据无效')
    left, right = struct.unpack('>II', body[:8])
    if 8 + left + right != len(body):
        raise BridgeError(400, '画面数据不完整')
    is_jpeg = lambda data: len(data) >= 4 and data[:2] == b'\xff\xd8' and data[-2:] == b'\xff\xd9'
    if route == '/frame':
        valid = is_jpeg(body[8:8 + left]) and is_jpeg(body[8 + left:])
    else:
        valid = left <= 65536 and (not right or is_jpeg(body[8 + left:]))
        try:
            state = json.loads(body[8:8 + left])
            valid = valid and isinstance(state, dict) and isinstance(state.get('joints'), list)
        except (ValueError, UnicodeDecodeError):
            valid = False
    if not valid:
        raise BridgeError(400, '画面或关节数据无效')


class BridgeServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, state):
        self.state = state
        super().__init__(address, BridgeHandler)


class BridgeHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_args):
        pass  # Do not log session credentials or teaching content.

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def respond(self, status, value, content_type='application/json; charset=utf-8'):
        body = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        self.end_headers()
        self.wfile.write(body)

    def handle_request(self):
        state = self.server.state
        origin = 'http://127.0.0.1:' + str(self.server.server_port)
        try:
            if self.client_address[0] != '127.0.0.1' or self.headers.get('Host') != origin[7:]:
                raise BridgeError(403, '连接助手仅允许本机访问')
            if self.headers.get('Origin', origin) != origin:
                raise BridgeError(403, '请通过本机连接窗口操作')
            if self.command == 'GET' and self.path in ('/', '/client.js'):
                file = ASSETS / ('index.html' if self.path == '/' else 'client.js')
                body = file.read_bytes().replace(b'__BRIDGE_SECRET__', state.secret.encode())
                return self.respond(200, body, 'text/html; charset=utf-8' if self.path == '/' else 'text/javascript; charset=utf-8')
            if not secrets.compare_digest(self.headers.get('X-Atlas-Bridge', ''), state.secret):
                raise BridgeError(403, '请从工作台打开连接助手')
            length = self.headers.get('Content-Length', '0')
            if not length.isdecimal() or self.headers.get('Transfer-Encoding'):
                raise BridgeError(400, '请求长度无效')
            if int(length) > usb.MAX_FRAME:
                raise BridgeError(413, '画面数据过大')
            body = self.rfile.read(int(length))
            if len(body) != int(length):
                raise BridgeError(400, '请求不完整')
            if self.path == '/api/devices' and self.command == 'GET':
                return self.respond(200, state.discover())
            if self.path == '/api/invitations' and self.command == 'GET':
                return self.respond(200, state.invitations())
            if self.path in ('/api/session', '/api/invitations/reject') and self.command == 'POST':
                try:
                    value = json.loads(body)
                    if not isinstance(value, dict):
                        raise ValueError()
                except (ValueError, UnicodeDecodeError):
                    raise BridgeError(400, '设备参数无效')
                if self.path == '/api/invitations/reject':
                    return self.respond(200, state.reject_invitation(value.get('deviceId'), value.get('invitationId')))
                return self.respond(201, state.start(value.get('deviceId'), value.get('invitationId')))
            match = re.fullmatch(r'/api/session/([a-f0-9-]{36})(/frame|/workspace|/events)?', self.path)
            if not match:
                raise BridgeError(404, '连接接口不存在')
            with state.lock:
                current = state.authorize(match[1], self.headers.get('Authorization', ''))
            route = match[2]
            if self.command == 'DELETE' and route is None:
                state.stop(current)
                return self.respond(200, {'stopped': True})
            if self.command == 'PUT' and route in ('/frame', '/workspace'):
                return self.respond(200, state.relay(current, route, body))
            if self.command == 'GET' and route == '/events':
                return self.events(current)
            raise BridgeError(405, '不支持的操作')
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            self.close_connection = True
        except Exception as error:
            self.close_connection = True
            self.respond(getattr(error, 'status', 503), {'error': str(error)})

    def events(self, current):
        state = self.server.state
        with state.lock:
            if current['watching']:
                raise BridgeError(409, '协作连接已经打开')
            current['watching'] = True
        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(json.dumps({'ready': True, 'deviceReady': current['deviceReady'], 'deviceName': current['deviceName']}).encode() + b'\n')
            self.wfile.flush()
            while not state.closed.is_set():
                try:
                    event = current['events'].get(timeout=1)
                except queue.Empty:
                    event = {}
                self.wfile.write(json.dumps(event).encode() + b'\n')
                self.wfile.flush()
                current['ownerSeen'] = time.monotonic()
                if current['ended']:
                    break
        finally:
            state.stop(current)

    do_GET = do_POST = do_PUT = do_DELETE = do_OPTIONS = handle_request


def main():
    parser = argparse.ArgumentParser(description='Atlas iPad USB companion (Windows / Mac, Python 3.9+)')
    parser.add_argument('--port', type=int, default=21994)
    args = parser.parse_args()
    state = BridgeState()
    try:
        server = BridgeServer(('127.0.0.1', args.port), state)
    except OSError:
        state.close()
        raise SystemExit('端口已占用，连接助手可能已经运行。请返回工作台点击“连接本机助手”。')
    print(f'Atlas iPad USB helper ready: http://127.0.0.1:{args.port}', flush=True)
    print('请保持本窗口打开，在工作台选择“画面协作 → 数据线 → 连接本机助手”。', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        state.close()
        server.server_close()


if __name__ == '__main__':
    main()
