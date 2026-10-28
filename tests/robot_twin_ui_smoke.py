"""Read-only twin UI regression. --live explicitly uses the supplied LAN robot."""
import argparse
import base64
import json
import math
import os
import re
from pathlib import Path
from threading import Thread
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs
from playwright.sync_api import sync_playwright, expect
from topbar_tools_helpers import topbar_action
from viewer_tools_helpers import viewer_tool

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:22061')
NAMES = ['ankle_pitch_J', 'knee_pitch_J', 'waist_pitch_J', 'waist_yaw_J', 'head_yaw_J', 'head_pitch_J'] + [f'{side}_J{i}' for side in ['left', 'right'] for i in range(1, 8)]
parser = argparse.ArgumentParser()
parser.add_argument('--live', action='store_true')
args = parser.parse_args()
traffic = []
robot_ports = []
camera_actions = []
camera_images = {}
BODY_CAMERAS = {'head-left': '头部左目', 'head-right': '头部右目', 'chest-color': '胸前彩色',
                'chest-depth': '胸前深度', 'wrist-left': '左手腕', 'wrist-right': '右手腕'}
fixture = {'stale': False, 'x': 2.5, 'y': -3.25, 'yaw': 1, 'task_phase': 'running', 'task_failure': False, 'processing': True,
           'run_id': 'd' * 32, 'task_name': '设备巡检任务', 'captures': 1, 'freeze_video': False}


class RobotFixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send_json(self, status, payload, headers=None):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        traffic.append(('GET', self.path))
        robot_ports.append(self.server.server_port)
        if self.headers.get('Cookie') != f'fixture_access={self.server.password}':
            self.send_json(401, {'error': 'login required'})
            return
        if self.path == '/api/v1/control-session':
            payload = {'token': 'a' * 64}
        elif self.path == '/api/v1/model':
            payload = {'name': 'botx_abx_zivid_m70', 'joint_names_sdk_order': NAMES}
        elif self.path == '/api/v1/body-cameras':
            payload = {'ok': True, 'preview_fps': 6, 'cameras': [{'id': key, 'label': label, 'available': key != 'head-right'} for key, label in BODY_CAMERAS.items()]}
        elif self.path == '/api/v1/slam':
            payload = {'fresh': not fixture['stale'], 'age_ms': 10, 'sample': {'ok': True, 'source': 'slam_websocket',
                'scene': {'mode': 'kLocalization', 'operation_running': False},
                'pose': {'x_m': getattr(self.server, 'pose_x', fixture['x']), 'y_m': fixture['y'], 'yaw_rad': fixture['yaw']}}}
        elif self.path == '/api/v1/state':
            payload = {'robot': {'valid': True, 'state_fresh': True, 'health_fresh': True, 'state_age_ms': 5,
                'joint_samples': {key: [{'valid': True, 'fresh': True, 'position_rad': 1.0} for _ in range(count)]
                                  for key, count in [('torso', 4), ('head', 2), ('left_arm', 7), ('right_arm', 7)]}}}
        elif self.path.startswith('/api/v1/execution') and fixture['task_failure']:
            self.send_error(503)
            return
        elif self.path == '/api/v1/execution/activity':
            payload = {'ok': True, 'task_phase': fixture['task_phase'], 'navigation_phase': 'idle'}
        elif self.path == '/api/v1/execution':
            payload = {'ok': True, 'run': {'id': fixture['run_id'], 'phase': fixture['task_phase'], 'task_name': fixture['task_name'],
                'parking_name': '一号停车点', 'point_name': '焊缝检测', 'stage': 'capture', 'task_index': 0,
                'message': '正在采集检测图像', 'completed_points': 2, 'completed_captures': fixture['captures'], 'elapsed_ms': 125000,
                'algorithm_mode': 'execute', 'algorithm_state': 'processing',
                'summary': {'point_count': 4, 'tasks': [{'name': fixture['task_name'], 'point_count': 4}]}}}
        elif self.path == f"/api/v1/execution/captures?run_id={fixture['run_id']}&offset=0":
            payload = {'ok': True, 'run_id': fixture['run_id'], 'total': fixture['captures'], 'next_offset': fixture['captures'],
                'captures': [{'id': 'e' * 32, 'side': 'left', 'sequence': 1, 'task_name': fixture['task_name'],
                              'parking_name': '一号停车点', 'point_name': '焊缝检测'}] if fixture['captures'] else []}
        elif self.path == '/api/v1/cameras/jobs/' + 'e' * 32:
            payload = {'job': {'state': 'complete', 'cameras': {'left': {'inspection': {'state': 'processing'} if fixture['processing']
                else {'state': 'complete', 'boxes': [{'label': '表面裂纹', 'x': 20, 'y': 40, 'width': 80, 'height': 10}]}}}}}
        else:
            self.send_error(404)
            return
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        traffic.append(('POST', self.path))
        robot_ports.append(self.server.server_port)
        if self.path == '/api/v1/access/login':
            fields = parse_qs(self.rfile.read(int(self.headers['Content-Length'])).decode())
            assert fields.get('role') == ['admin']
            if fields.get('password') != [self.server.password]:
                # Native servers can return HTML for auth errors too.
                self.send_error(401)
            else:
                self.send_json(200, {'ok': True}, {'Set-Cookie': f'fixture_access={self.server.password}; HttpOnly'})
            return
        if self.path in ['/api/v1/body-cameras/preview', '/api/v1/body-cameras/frame']:
            fields = {key: value[0] for key, value in parse_qs(self.rfile.read(int(self.headers['Content-Length'])).decode()).items()}
            camera_actions.append((self.server.server_port, self.path, fields))
            assert re.fullmatch('[a-f0-9]{32}', fields['client'])
            generation = int(fields['generation'])
            leases = getattr(self.server, 'camera_leases', {})
            self.server.camera_leases = leases
            previous = leases.get(fields['client'], {'generation': 0, 'camera': None})
            if self.path.endswith('/preview'):
                if generation < previous['generation']:
                    self.send_error(409)
                    return
                if fields['enabled'] == '1':
                    assert fields['camera'] in BODY_CAMERAS and len(fields) == 4
                    assert getattr(self.server, 'active_camera', None) is None, 'previous camera must close before switching'
                    self.server.active_camera = fields['camera']
                else:
                    assert fields['enabled'] == '0' and len(fields) == 3
                    self.server.active_camera = None
                leases[fields['client']] = {'generation': generation, 'camera': self.server.active_camera}
                data = b'{"ok":true}'
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
            else:
                assert len(fields) == 2
                if previous['generation'] != generation or not previous['camera']:
                    self.send_error(409)
                    return
                if not fixture['freeze_video']:
                    self.server.frame_sequence = getattr(self.server, 'frame_sequence', 0) + 1
                data = camera_images[previous['camera']]
                self.send_response(200)
                self.send_header('Content-Type', 'image/jpeg')
                self.send_header('X-ABX-Sequence', str(self.server.frame_sequence))
                self.send_header('X-ABX-Preview-Width', '480')
                self.send_header('X-ABX-Preview-Height', '270')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        self.send_error(405)


server = None
backup_server = None
if args.live:
    address = os.environ.get('ROBOT_TWIN_ADDRESS', '192.168.0.112:9090')
    password = os.environ.get('ROBOT_TWIN_PASSWORD', '')
else:
    server = ThreadingHTTPServer(('127.0.0.1', 0), RobotFixture)
    server.password = 'fixture-robot-A'
    Thread(target=server.serve_forever, daemon=True).start()
    address = f'127.0.0.1:{server.server_port}'
    backup_server = ThreadingHTTPServer(('127.0.0.1', 0), RobotFixture)
    backup_server.password = 'fixture-robot-B'
    backup_server.pose_x = 8.5
    Thread(target=backup_server.serve_forever, daemon=True).start()
    backup_address = f'127.0.0.1:{backup_server.server_port}'
    password = server.password


def reading(canvas):
    return {'pose': {key: float(canvas.get_attribute(f'data-robot-{key}')) for key in ['x', 'y', 'z', 'roll', 'pitch', 'yaw']},
            'joints': json.loads(canvas.get_attribute('data-robot-joint-values'))}


def camera_view(canvas):
    return canvas.evaluate('(canvas) => ["cameraX", "cameraY", "cameraZ", "targetX", "targetY", "targetZ"].map(key => Number(canvas.dataset[key]))')


artifacts = ROOT / 'test-artifacts' / 'robot-twin'
artifacts.mkdir(parents=True, exist_ok=True)
errors = []
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        page.set_default_timeout(30000)
        page.on('pageerror', lambda error: errors.append(str(error)))
        snapshots = []

        def on_response(response):
            if response.url.endswith('/__atlas/robot-twin/snapshot') and response.status == 200:
                snapshots.append(response.json())

        page.on('response', on_response)
        try:
            page.goto(BASE, wait_until='networkidle')
            if not args.live:
                encoded = page.evaluate('''(ids) => Object.fromEntries(ids.map((id, index) => {
                    const canvas=document.createElement('canvas'); canvas.width=480; canvas.height=270;
                    const ctx=canvas.getContext('2d'); ctx.fillStyle=index===0?'#195845':'#204779'; ctx.fillRect(0,0,480,270);
                    ctx.strokeStyle='#ffffff30'; for(let x=0;x<480;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,270);ctx.stroke();}
                    ctx.fillStyle='#fff';ctx.font='28px monospace';ctx.fillText(id.toUpperCase(),28,140);
                    return [id,canvas.toDataURL('image/jpeg').split(',')[1]];
                }))''', list(BODY_CAMERAS))
                camera_images.update({key: base64.b64decode(value) for key, value in encoded.items()})
            page.get_by_role('button', name='同步作业', exact=True).click()
            chooser = page.get_by_role('dialog', name='选择同步模式', exact=True)
            expect(chooser).to_be_visible()
            chooser.get_by_role('button', name='离线协作').click()
            expect(page.get_by_role('dialog', name='离线协作', exact=True)).to_contain_text('申请离线协作')
            page.get_by_role('button', name='关闭同步作业', exact=True).click()
            page.goto(BASE + '/workbench', wait_until='networkidle')
            page.locator('[data-session-state="ready"]').wait_for()
            page.locator('input[type="file"][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/rotation-map.ply'))
            page.locator('.loading-curtain').wait_for(state='hidden')
            topbar_action(page, name='加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70', exact=True).click()
            canvas = page.locator('.three-canvas')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded', timeout=180000)
            before = reading(canvas)
            expect(page.get_by_role('button', name='机器人后上方跟随视角')).to_have_count(0)
            page.get_by_role('button', name='同步作业', exact=True).click()
            page.get_by_role('dialog').get_by_role('button', name='真机孪生').click()
            dialog = page.get_by_role('dialog', name='真机孪生', exact=True)
            if not args.live:
                expect(dialog.get_by_role('radio', name='ABX 机器人 192.168.0.112:9090', exact=True)).to_be_checked()
                dialog.get_by_role('button', name='编辑机器人 ABX 机器人', exact=True).click()
                dialog.get_by_label('机器人地址', exact=True).fill('invalid-address')
                dialog.get_by_role('button', name='保存机器人', exact=True).click()
                expect(dialog.get_by_role('alert')).to_contain_text('局域网 IPv4 地址')
                dialog.get_by_role('button', name='取消编辑').click()

                def add_robot(name, target):
                    dialog.get_by_role('button', name='添加机器人', exact=True).click()
                    dialog.get_by_label('机器人名称', exact=True).fill(name)
                    dialog.get_by_label('机器人地址', exact=True).fill(target)
                    dialog.get_by_role('button', name='保存机器人', exact=True).click()

                add_robot('测试机器人 A', address)
                add_robot('备用机器人', backup_address)
                dialog.get_by_role('button', name='编辑机器人 备用机器人', exact=True).click()
                dialog.get_by_label('机器人名称', exact=True).fill('测试机器人 B')
                dialog.get_by_role('button', name='保存机器人', exact=True).click()
                add_robot('重复地址', 'http://' + address + '/')
                expect(dialog.get_by_role('alert')).to_contain_text('此地址已保存为“测试机器人 A”')
                dialog.get_by_role('button', name='取消编辑').click()
                dialog.get_by_role('button', name='删除机器人 测试机器人 B', exact=True).click()
                expect(dialog.get_by_role('radio', name=f'测试机器人 B {backup_address}', exact=True)).to_have_count(0)
                dialog.get_by_role('button', name='撤销删除').click()
                expect(dialog.get_by_role('radio', name=f'测试机器人 B {backup_address}', exact=True)).to_be_checked()
                dialog.get_by_label('管理员密码', exact=True).fill('do-not-persist-this-password')
                dialog.get_by_text('测试机器人 A', exact=True).click()
                expect(dialog.get_by_label('管理员密码', exact=True)).to_have_value('')
                assert not traffic, 'saving, deleting and selecting uncached cards must not contact any robot'
                page.screenshot(path=str(artifacts / 'robot-cards.png'))
                page.route('**/__atlas/robot-twin/sessions', lambda route: route.fulfill(status=502,
                    content_type='application/json', body=json.dumps({'error': '连接测试：服务暂不可用'})), times=1)
                dialog.get_by_role('button', name='连接并同步', exact=True).click()
                expect(dialog.locator('.robot-twin-panel__state')).to_contain_text('连接失败')
                page.wait_for_timeout(1300)
                expect(dialog).to_be_visible()
                expect(dialog.locator('.robot-twin-success')).to_have_count(0)
            else:
                if address != '192.168.0.112:9090':
                    dialog.locator('.robot-twin-card.is-selected').get_by_role('button', name=re.compile('^编辑机器人 ')).click()
                    dialog.get_by_label('机器人地址', exact=True).fill(address)
                    dialog.get_by_role('button', name='保存机器人', exact=True).click()
            dialog.get_by_label('管理员密码', exact=True).fill(password)
            dialog.get_by_role('button', name='连接并同步', exact=True).click()
            success = dialog.locator('.robot-twin-success')
            expect(success).to_contain_text('连接成功', timeout=20000)
            assert success.locator('path').evaluate('(el) => el.getAnimations().length') > 0
            page.screenshot(path=str(artifacts / 'connection-success.png'), animations='disabled')
            expect(dialog).not_to_be_visible(timeout=2500)
            expect(page.get_by_role('button', name='停止同步', exact=True)).to_be_focused()
            page.wait_for_timeout(1100)
            live = reading(canvas)
            assert len(snapshots) >= 2, len(snapshots)
            assert any(s['pose'] and abs(live['pose']['x'] - s['pose']['x']) < 1e-5 and
                       abs(live['pose']['y'] - s['pose']['y']) < 1e-5 and abs(live['pose']['yaw'] - s['pose']['yaw']) < 1e-5
                       for s in snapshots[-4:]), (live['pose'], snapshots[-1]['pose'])
            assert live['pose']['z'] == before['pose']['z']
            assert all(any(abs(live['joints'][name] - s['joints'][name]) < 1e-5 for s in snapshots[-4:] if name in s['joints']) for name in NAMES)
            follow_view = page.get_by_role('button', name='机器人后上方跟随视角', exact=True)
            original_view = camera_view(canvas)
            saved_view_signature = canvas.get_attribute('data-view-signature')
            follow_view.click()
            expect(follow_view).to_have_attribute('aria-pressed', 'true')
            expect(canvas).to_have_attribute('data-twin-follow-enabled', 'true')
            expect(canvas).to_have_attribute('data-robot-control-enabled', 'false')
            offset = camera_view(canvas)
            heading = live['pose']['yaw'] * math.pi / 180
            dx, dy = offset[0] - live['pose']['x'], offset[1] - live['pose']['y']
            assert dx * math.cos(heading) + dy * math.sin(heading) < -3
            assert offset[2] > live['pose']['z'] + 2
            if not args.live:
                fixture.update(x=3.75, y=-4)
                page.wait_for_function('''([dx, dy]) => { const d = document.querySelector('.three-canvas').dataset;
                    return Math.abs(Number(d.cameraX) - 3.75 - dx) < .02 && Math.abs(Number(d.cameraY) + 4 - dy) < .02;
                }''', arg=[dx, dy])
                fixture['yaw'] = math.pi / 2
                page.wait_for_function('''() => { const d = document.querySelector('.three-canvas').dataset;
                    return Math.abs(Number(d.cameraX) - 3.75) < .02 && Number(d.cameraY) < -7 && Number(d.targetY) > -3.5;
                }''')
                page.screenshot(path=str(artifacts / 'fixture-twin-follow.png'))
                fixture.update(x=2.5, y=-3.25, yaw=1)
                expect(canvas).to_have_attribute('data-robot-x', '2.500000')
                page.wait_for_function('''([dx, dy]) => { const d = document.querySelector('.three-canvas').dataset;
                    return Math.abs(Number(d.cameraX) - 2.5 - dx) < .02 && Math.abs(Number(d.cameraY) + 3.25 - dy) < .02;
                }''', arg=[dx, dy])
                fixture.update(stale=True, x=99, yaw=0)
                expect(page.locator('.work-sync:visible')).to_have_attribute('data-twin-phase', 'stale')
                page.wait_for_timeout(300)
                held_view = camera_view(canvas)
                assert abs(held_view[0] - 2.5 - dx) < .02 and abs(held_view[1] + 3.25 - dy) < .02, 'stale feedback must not displace the follow view'
                fixture.update(stale=False, x=2.5, yaw=1)
                expect(page.locator('.work-sync:visible')).to_have_attribute('data-twin-phase', 'live')
            assert canvas.get_attribute('data-view-signature') == saved_view_signature, 'following must not overwrite the saved workspace view'
            follow_view.click()
            expect(canvas).to_have_attribute('data-twin-follow-enabled', 'false')
            assert all(abs(a - b) < 1e-6 for a, b in zip(camera_view(canvas), original_view)), 'leaving follow restores the original view'
            canvas.press('ArrowRight')
            page.wait_for_function('''previous => {
                const d = document.querySelector('.three-canvas').dataset;
                return Math.abs(Number(d.cameraX) - previous[0]) + Math.abs(Number(d.cameraY) - previous[1]) > .001;
            }''', arg=original_view)
            if not args.live:
                for action in ['rotate', 'pan', 'wheel', 'keyboard', 'toolbar']:
                    follow_view.click()
                    expect(follow_view).to_have_attribute('aria-pressed', 'true')
                    bounds = canvas.bounding_box()
                    x, y = bounds['x'] + bounds['width'] * .25, bounds['y'] + bounds['height'] * .4
                    page.mouse.move(x, y)
                    page.get_by_role('heading', name='任务监控台', exact=True).click()
                    expect(follow_view).to_have_attribute('aria-pressed', 'true')
                    follow_frame = camera_view(canvas)
                    if action in ['rotate', 'pan']:
                        page.mouse.move(x, y)
                        button = 'left' if action == 'rotate' else 'right'
                        page.mouse.down(button=button)
                        expect(follow_view).to_have_attribute('aria-pressed', 'false')
                        assert all(abs(a - b) < 1e-6 for a, b in zip(camera_view(canvas), follow_frame)), 'pointer takeover must keep the current follow view'
                        page.mouse.move(x + 85, y + 32, steps=8)
                        page.mouse.up(button=button)
                    elif action == 'wheel':
                        page.mouse.move(x, y)
                        page.mouse.wheel(0, -120)
                    elif action == 'keyboard':
                        canvas.press('ArrowRight')
                    else:
                        page.get_by_role('button', name='视图工具', exact=True).click()
                    expect(follow_view).to_have_attribute('aria-pressed', 'false')
                    expect(canvas).to_have_attribute('data-twin-follow-enabled', 'false')
                    expect(canvas).to_have_attribute('data-robot-control-enabled', 'false')
                    if action == 'toolbar':
                        assert all(abs(a - b) < 1e-6 for a, b in zip(camera_view(canvas), follow_frame))
                        page.get_by_role('button', name='视图工具', exact=True).click()
                    else:
                        page.wait_for_function('''previous => {
                            const d = document.querySelector('.three-canvas').dataset;
                            return ['cameraX', 'cameraY', 'cameraZ'].some((key, i) => Math.abs(Number(d[key]) - previous[i]) > .001);
                        }''', arg=follow_frame)
                        if action in ['rotate', 'wheel', 'keyboard']:
                            assert all(abs(a - b) < 1e-6 for a, b in zip(camera_view(canvas)[3:], follow_frame[3:])), 'manual orbit/zoom must keep the current target'
                manual_view = camera_view(canvas)
                fixture['x'] = 3.5
                expect(canvas).to_have_attribute('data-robot-x', '3.500000')
                page.wait_for_timeout(600)
                assert all(abs(a - b) < 1e-6 for a, b in zip(camera_view(canvas), manual_view)), 'new telemetry must not restart following after manual takeover'
                fixture['x'] = 2.5
                expect(canvas).to_have_attribute('data-robot-x', '2.500000')
            monitor = page.get_by_role('complementary', name='任务监控台', exact=True)
            expect(monitor).to_be_visible()
            expect(monitor).to_have_attribute('data-monitor-phase', 'live')
            expect(page.get_by_role('complementary', name='图谱控制台', exact=True)).to_have_count(0)
            expect(page.get_by_role('tablist', name='控制台子页')).to_have_count(0)
            expect(page.get_by_role('button', name='打开全关节浮动窗口', exact=True)).to_have_count(0)
            cameras = monitor.get_by_role('region', name='本体相机', exact=True)
            picker = cameras.get_by_role('combobox', name='选择本体相机')
            video_switch = cameras.get_by_role('switch', name='本体相机实时画面')
            expand_camera = cameras.get_by_role('button', name='放大本体相机画面')
            expect(picker).to_have_value('head-left')
            expect(picker.locator('option')).to_have_count(6)
            expect(video_switch).to_have_attribute('aria-checked', 'false')
            expect(expand_camera).to_be_disabled()
            if not args.live:
                expect(picker.get_by_role('option', name='头部右目（未发现）')).to_be_disabled()
                assert not camera_actions, 'connecting the twin must not open camera streams'
            picker.select_option('chest-color')
            if not args.live:
                assert not camera_actions, 'selecting a camera while off must not subscribe'
            video_switch.click()
            expect(cameras).to_have_attribute('data-camera-phase', 'live', timeout=15000)
            expect(cameras.get_by_role('img', name='胸前彩色实时画面')).to_be_visible()
            assert cameras.locator('img').evaluate('(image) => image.complete && image.naturalWidth > 0')
            picker.select_option('head-left')
            expect(cameras.get_by_role('img', name='头部左目实时画面')).to_be_visible(timeout=15000)
            if not args.live:
                assert server.active_camera == 'head-left'
                fixture['freeze_video'] = True
                expect(cameras).to_have_attribute('data-camera-phase', 'stale')
                expect(cameras.locator('img')).to_have_count(0)
                expect(page.locator('.work-sync:visible')).to_have_attribute('data-twin-phase', 'live')
                fixture['freeze_video'] = False
                expect(cameras).to_have_attribute('data-camera-phase', 'live')
            preview_actions = [action for action in camera_actions if action[1].endswith('/preview')]
            expand_camera.click()
            expanded_camera = page.get_by_role('dialog', name='头部左目 · 实时画面', exact=True)
            expect(expanded_camera).to_be_visible()
            expect(expanded_camera.get_by_role('img', name='头部左目实时画面')).to_be_visible()
            first_frame = expanded_camera.locator('img').get_attribute('src')
            page.wait_for_function('''previous => {
                const image = document.querySelector('.task-monitor-camera-dialog img');
                const small = document.querySelector('.task-monitor-camera img');
                return image?.complete && image.naturalWidth > 0 && image.src !== previous && image.src === small?.src;
            }''', arg=first_frame)
            if not args.live:
                fixture['freeze_video'] = True
                expect(expanded_camera.locator('img')).to_have_count(0)
                expect(expanded_camera.get_by_role('status')).to_contain_text('画面已过期')
                fixture['freeze_video'] = False
                expect(expanded_camera.locator('img')).to_be_visible()
            page.screenshot(path=str(artifacts / ('live-camera-expanded.png' if args.live else 'fixture-camera-expanded.png')))
            page.set_viewport_size({'width': 390, 'height': 844})
            assert expanded_camera.evaluate('(dialog) => { const r = dialog.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }')
            page.set_viewport_size({'width': 1440, 'height': 1000})
            expanded_camera.get_by_role('button', name='关闭放大画面').click()
            expect(expanded_camera).to_have_count(0)
            expect(expand_camera).to_be_focused()
            expand_camera.click()
            page.keyboard.press('Escape')
            expect(expanded_camera).to_have_count(0)
            expand_camera.click()
            page.mouse.click(4, 4)
            expect(expanded_camera).to_have_count(0)
            expect(cameras).to_have_attribute('data-camera-phase', 'live')
            if not args.live:
                assert [action for action in camera_actions if action[1].endswith('/preview')] == preview_actions, 'expanding and closing must reuse the existing preview subscription'
            page.screenshot(path=str(artifacts / ('live-body-camera.png' if args.live else 'fixture-body-camera.png')))
            video_switch.click()
            expect(cameras).to_have_attribute('data-camera-phase', 'idle')
            if not args.live:
                frame_requests = len(camera_actions)
                page.wait_for_timeout(450)
                assert len(camera_actions) == frame_requests and server.active_camera is None
            video_switch.click()
            expect(cameras).to_have_attribute('data-camera-phase', 'live', timeout=15000)
            if not args.live:
                expect(monitor.locator('.task-monitor__task-name')).to_have_text('设备巡检任务')
                expect(monitor.get_by_role('progressbar', name='任务步骤进度')).to_have_attribute('value', '2')
                expect(monitor.locator('.task-monitor__result')).to_contain_text('算法执行中')
                fixture['processing'] = False
                expect(monitor.locator('.task-monitor__result')).to_contain_text('表面裂纹')
                expect(monitor.get_by_text('原始算法输出', exact=True)).to_have_count(0)
                monitor.get_by_role('list', name='算法结果列表', exact=True).get_by_role('button').click()
                expect(monitor.get_by_role('region', name='Zivid 采集结果', exact=True)).to_have_attribute('data-capture-mode', 'selected')
                page.screenshot(path=str(artifacts / 'task-monitor-results.png'))
                monitor.get_by_role('button', name='折叠任务监控台').click()
                expect(monitor).to_have_attribute('data-collapsed', 'true')
                monitor.get_by_role('button', name='展开任务监控台').click()
                expect(monitor).to_have_attribute('data-collapsed', 'false')
                expect(cameras).to_have_attribute('data-camera-phase', 'idle')
                assert server.active_camera is None, 'collapsing the console must release the preview'
                video_switch.click()
                expect(cameras).to_have_attribute('data-camera-phase', 'live')
                fixture['task_phase'] = 'paused'
                expect(monitor.get_by_role('region', name='机器人任务状态')).to_contain_text('已暂停')
                fixture['task_failure'] = True
                expect(monitor).to_have_attribute('data-monitor-phase', 'stale')
                expect(page.locator('.work-sync:visible')).to_have_attribute('data-twin-phase', 'live')
                expect(monitor).to_contain_text('以下为上次读取记录')
                fixture['task_failure'] = False
                fixture.update(run_id='c' * 32, task_name='下一站任务', captures=0, task_phase='running')
                expect(monitor.locator('.task-monitor__task-name')).to_have_text('下一站任务')
                expect(monitor.locator('.task-monitor__result')).to_have_count(0)
                expect(monitor).to_contain_text('暂无算法结果')
                expect(monitor.get_by_role('button', name='回到最新', exact=True)).to_have_count(0)
                fixture['task_phase'] = 'idle'
                expect(monitor).to_contain_text('当前没有执行中的任务')
            expect(canvas).to_have_attribute('data-robot-control-enabled', 'false')
            page.screenshot(path=str(artifacts / ('live-readings.png' if args.live else 'fixture-readings.png')))
            if not args.live:
                fixture['stale'] = True
                expect(page.locator('.work-sync:visible')).to_have_attribute('data-twin-phase', 'stale')
                assert reading(canvas)['pose']['x'] == 2.5
                fixture['stale'] = False
                fixture['x'] = 4.75
                expect(canvas).to_have_attribute('data-robot-x', '4.750000')
                expect(page.locator('.work-sync:visible')).to_have_attribute('data-twin-phase', 'live')
            expect(page.locator('.work-sync[data-twin-phase="live"]')).to_be_visible()
            expect(page.get_by_role('button', name='停止同步', exact=True)).to_be_visible()
            viewer_tool(page, name='定位机器人模型').click()
            expect(canvas).to_have_attribute('data-robot-control-enabled', 'false')
            page.get_by_role('button', name='视图工具', exact=True).click()
            page.screenshot(path=str(artifacts / ('live-scene.png' if args.live else 'fixture-scene.png')))
            before_stop_view = camera_view(canvas)
            follow_view.click()
            expect(canvas).to_have_attribute('data-twin-follow-enabled', 'true')
            page.get_by_role('button', name='停止同步', exact=True).click()
            expect(canvas).to_have_attribute('data-twin-follow-enabled', 'false')
            expect(follow_view).to_have_count(0)
            assert all(abs(a - b) < 1e-6 for a, b in zip(camera_view(canvas), before_stop_view)), 'disconnect restores the view before following'
            expect(page.get_by_role('button', name='同步作业', exact=True)).to_be_visible()
            expect(page.get_by_role('dialog')).to_have_count(0)
            expect(page.get_by_role('complementary', name='任务监控台', exact=True)).to_have_count(0)
            expect(page.get_by_role('complementary', name='图谱控制台', exact=True)).to_be_visible()
            expect(page.get_by_role('tablist', name='控制台子页')).to_be_visible()
            page.wait_for_timeout(100)
            after = reading(canvas)
            assert before['pose'] == after['pose'], (before['pose'], after['pose'])
            assert all(abs(before['joints'][name] - after['joints'][name]) < 1e-8 for name in before['joints']), (before['joints'], after['joints'])
            count = len(snapshots)
            request_count = len(traffic)
            page.wait_for_timeout(1200)
            assert len(snapshots) == count, 'disconnect must stop polling'
            assert len(traffic) == request_count, 'disconnect must stop robot data communication'
            if not args.live:
                assert server.active_camera is None, 'disconnect must release the native preview lease'
            if not args.live:
                # Switch to a second saved card without entering any IP address.
                page.get_by_role('button', name='同步作业', exact=True).click()
                page.get_by_role('dialog').get_by_role('button', name='真机孪生').click()
                second = page.get_by_role('dialog', name='真机孪生', exact=True)
                expect(second.get_by_role('radio', name=f'测试机器人 A {address}', exact=True)).to_be_checked()
                second.get_by_text('测试机器人 B', exact=True).click()
                assert len(traffic) == request_count, 'card selection alone must not connect'
                ports_before = len(robot_ports)
                second.get_by_label('管理员密码', exact=True).fill(backup_server.password)
                second.get_by_role('button', name='连接并同步', exact=True).click()
                expect(second.locator('.robot-twin-success')).to_contain_text('连接成功')
                expect(second).not_to_be_visible(timeout=2500)
                expect(canvas).to_have_attribute('data-robot-x', '8.500000')
                assert set(robot_ports[ports_before:]) == {backup_server.server_port}, 'card B must connect only to robot B'
                page.get_by_role('button', name='停止同步', exact=True).click()
                page.wait_for_timeout(100)
                request_count = len(traffic)
                page.wait_for_timeout(1200)
                assert len(traffic) == request_count, 'stopping robot B must stop all its requests'
                # Stopping inside the form must not turn the same click into
                # another form submit and silently reconnect. Unready feedback
                # keeps the dialog open instead of displaying a success check.
                fixture['stale'] = True
                page.get_by_role('button', name='同步作业', exact=True).click()
                page.get_by_role('dialog').get_by_role('button', name='真机孪生').click()
                panel = page.get_by_role('dialog', name='真机孪生', exact=True)
                # Cached A fails once after its password changes; B is retained.
                server.password = 'fixture-robot-A-changed'
                panel.get_by_text('测试机器人 A', exact=True).click()
                expect(panel.get_by_role('alert')).to_contain_text('重新输入管理员密码')
                expect(panel.get_by_label('管理员密码', exact=True)).to_be_focused()
                credentials = page.evaluate("JSON.parse(localStorage.getItem('atlas-route-studio:robot-twin-credentials-v1')).credentials")
                assert len(credentials) == 1 and credentials[0]['address'] == 'http://' + backup_address
                panel.get_by_label('管理员密码', exact=True).fill(server.password)
                panel.get_by_role('button', name='连接并同步', exact=True).click()
                expect(panel.locator('.robot-twin-panel__state')).to_contain_text('数据暂不可用')
                page.wait_for_timeout(1300)
                expect(panel).to_be_visible()
                expect(panel.locator('.robot-twin-success')).to_have_count(0)
                panel.get_by_role('button', name='停止同步', exact=True).click()
                expect(page.get_by_role('dialog')).to_have_count(0)
                expect(page.get_by_role('button', name='同步作业', exact=True)).to_be_visible()
                request_count = len(traffic)
                page.wait_for_timeout(1200)
                assert len(traffic) == request_count, 'modal stop must not resubmit connection form'
                fixture['stale'] = False
            page.set_viewport_size({'width': 390, 'height': 844})
            page.get_by_role('button', name='同步作业', exact=True).click()
            page.get_by_role('dialog').get_by_role('button', name='真机孪生').click()
            dialog = page.get_by_role('dialog', name='真机孪生', exact=True)
            assert dialog.evaluate('(el) => el.getBoundingClientRect().width <= innerWidth')
            page.screenshot(path=str(artifacts / 'narrow-dialog.png'))
            page.reload(wait_until='networkidle')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded', timeout=180000)
            assert reading(canvas)['pose'] == before['pose'], 'live pose must not overwrite the saved offline workspace'
            if not args.live:
                page.get_by_role('button', name='同步作业', exact=True).click()
                page.get_by_role('dialog').get_by_role('button', name='真机孪生').click()
                restored = page.get_by_role('dialog', name='真机孪生', exact=True)
                expect(restored.get_by_role('radio', name=f'测试机器人 A {address}', exact=True)).to_be_checked()
                expect(restored.get_by_role('radio', name=f'测试机器人 B {backup_address}', exact=True)).to_have_count(1)
                expect(restored.get_by_label('管理员密码', exact=True)).to_have_count(0)
                stored = page.evaluate("localStorage.getItem('atlas-route-studio:robot-twin-profiles-v1')")
                assert 'do-not-persist-this-password' not in stored and 'password' not in stored
                assert len(json.loads(stored)['profiles']) == 3

                def saved_credentials():
                    return page.evaluate("JSON.parse(localStorage.getItem('atlas-route-studio:robot-twin-credentials-v1')).credentials")

                assert {item['address']: item['password'] for item in saved_credentials()} == {
                    'http://' + address: server.password, 'http://' + backup_address: backup_server.password}
                request_count = len(traffic)
                restored.get_by_role('button', name='删除机器人 测试机器人 B', exact=True).click()
                expect(restored.get_by_role('radio', name=f'测试机器人 A {address}', exact=True)).to_be_checked()
                assert len(saved_credentials()) == 1, 'deleting an unselected card also removes its saved password'
                restored.get_by_role('button', name='撤销删除').click()
                assert len(saved_credentials()) == 2
                assert len(traffic) == request_count, 'deleting or undoing a cached card must not connect'
                page.screenshot(path=str(artifacts / 'remembered-robot-cards.png'))

                # A temporary outage retains the cache. Clicking an already
                # selected card retries automatically, including after a reload.
                page.route('**/__atlas/robot-twin/sessions', lambda route: route.fulfill(status=502,
                    content_type='application/json', body=json.dumps({'error': '连接测试：服务暂不可用'})), times=1)
                restored.get_by_text('测试机器人 A', exact=True).click()
                expect(restored.get_by_role('alert')).to_contain_text('服务暂不可用')
                expect(restored.get_by_label('管理员密码', exact=True)).to_have_count(0)
                assert len(saved_credentials()) == 2
                assert len(traffic) == request_count
                restored.get_by_text('测试机器人 A', exact=True).click()
                expect(restored.locator('.robot-twin-success')).to_contain_text('连接成功')
                expect(restored).not_to_be_visible(timeout=2500)

                # Invalidated authentication while streaming reopens the modal,
                # exits the twin and asks for this robot's password only.
                server.password = 'fixture-robot-A-invalidated'
                expect(restored).to_be_visible()
                expect(restored.get_by_role('alert')).to_contain_text('重新输入管理员密码')
                expect(restored.get_by_label('管理员密码', exact=True)).to_be_focused()
                assert len(saved_credentials()) == 1 and saved_credentials()[0]['address'] == 'http://' + backup_address
                request_count = len(traffic)
                page.wait_for_timeout(1200)
                assert len(traffic) == request_count, 'auth failure waits for input without retrying a rejected password'
                ports_before = len(robot_ports)
                restored.get_by_text('测试机器人 B', exact=True).click()
                expect(restored.locator('.robot-twin-success')).to_contain_text('连接成功')
                expect(restored).not_to_be_visible(timeout=2500)
                assert set(robot_ports[ports_before:]) == {backup_server.server_port}
                page.get_by_role('button', name='停止同步', exact=True).click()
                page.get_by_role('button', name='同步作业', exact=True).click()
                page.get_by_role('dialog').get_by_role('button', name='真机孪生').click()
                request_count = len(traffic)
                restored.get_by_role('button', name='编辑机器人 测试机器人 B', exact=True).click()
                restored.get_by_label('机器人名称', exact=True).fill('已重命名机器人 B')
                restored.get_by_role('button', name='保存机器人', exact=True).click()
                assert len(saved_credentials()) == 1, 'renaming preserves the saved password'
                restored.get_by_role('button', name='编辑机器人 已重命名机器人 B', exact=True).click()
                restored.get_by_label('机器人地址', exact=True).fill('127.0.0.1:1')
                restored.get_by_role('button', name='保存机器人', exact=True).click()
                expect(restored.get_by_label('管理员密码', exact=True)).to_have_value('')
                assert not saved_credentials(), 'changing the address must not reuse the old robot password'
                for name in ['测试机器人 A', '已重命名机器人 B', 'ABX 机器人']:
                    restored.get_by_role('button', name=f'删除机器人 {name}', exact=True).click()
                expect(restored.get_by_role('radio')).to_have_count(0)
                expect(restored.get_by_role('button', name='连接并同步', exact=True)).to_be_disabled()
                assert len(traffic) == request_count, 'card management never connects'
                page.reload(wait_until='networkidle')
                page.get_by_role('button', name='同步作业', exact=True).click()
                page.get_by_role('dialog').get_by_role('button', name='真机孪生').click()
                expect(restored.get_by_role('radio')).to_have_count(0)
            assert not errors, errors
            print(json.dumps({'mode': 'live robot' if args.live else 'fixture', 'snapshots': len(snapshots),
                              'livePose': live['pose'], 'jointCount': len(NAMES), 'offlineRestored': True,
                              'pageErrors': errors}, ensure_ascii=False))
        except Exception:
            print('Visible dialogs:', page.get_by_role('dialog').all_inner_texts())
            print('Fixture requests:', len(traffic), 'Latest:', traffic[-12:])
            print('Page errors:', errors)
            page.screenshot(path=str(artifacts / 'failure.png'))
            raise
        finally:
            browser.close()
finally:
    if server:
        server.shutdown()
        backup_server.shutdown()
        assert all((method == 'POST' and path in ['/api/v1/access/login', '/api/v1/body-cameras/preview', '/api/v1/body-cameras/frame']) or
            (method == 'GET' and (path in ['/api/v1/control-session', '/api/v1/slam', '/api/v1/state', '/api/v1/model', '/api/v1/execution', '/api/v1/execution/activity', '/api/v1/body-cameras']
            or re.fullmatch(r'/api/v1/execution/captures\?run_id=[a-f0-9]{32}&offset=0', path)
            or path == '/api/v1/cameras/jobs/' + 'e' * 32)) for method, path in traffic), traffic
