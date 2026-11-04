"""Real proxy, capture cache, worker, WebGL and display switches; loopback robots only."""
import base64
import json
import os
from pathlib import Path
import sys
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import urlsplit, parse_qs

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests'))
from topbar_tools_helpers import topbar_action
from viewer_tools_helpers import display_settings_section

BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:22368')
ARTIFACTS = ROOT / 'test-artifacts' / 'robot-twin-projection'
ARTIFACTS.mkdir(parents=True, exist_ok=True)
NAMES = ['ankle_pitch_J', 'knee_pitch_J', 'waist_pitch_J', 'waist_yaw_J', 'head_yaw_J', 'head_pitch_J'] + [f'{side}_J{i}' for side in ['left', 'right'] for i in range(1, 8)]
GROUPS = [('torso', 0, 4), ('head', 4, 6), ('left_arm', 6, 13), ('right_arm', 13, 20)]
RUN = 'a' * 32
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
fixture = {'joints': [0.] * 20, 'x': 0, 'y': 0, 'yaw': 0, 'captures': [], 'move': 0}
traffic = []


class Robot(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, value, mime='application/json'):
        data = json.dumps(value).encode() if mime == 'application/json' else value
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        traffic.append(('POST', self.path))
        assert self.path == '/api/v1/access/login'
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        self.reply({'ok': True})

    def do_GET(self):
        traffic.append(('GET', self.path))
        path = urlsplit(self.path).path
        if path == '/api/v1/control-session':
            self.reply({'token': 'b' * 64})
        elif path == '/api/v1/model':
            self.reply({'name': 'botx_abx_zivid_m70', 'joint_names_sdk_order': NAMES})
        elif path == '/api/v1/slam':
            self.reply({'fresh': True, 'age_ms': 1, 'sample': {'ok': True, 'source': 'slam_websocket',
                'scene': {'mode': 'kLocalization', 'operation_running': False},
                'pose': {'x_m': fixture['x'] + self.server.offset + fixture['move'], 'y_m': fixture['y'], 'yaw_rad': fixture['yaw']}}})
        elif path == '/api/v1/state':
            self.reply({'robot': {'valid': True, 'state_fresh': True, 'health_fresh': True, 'state_age_ms': 1,
                'joint_samples': {group: [{'valid': True, 'fresh': True, 'position_rad': value + fixture['move'] * .05}
                    for value in fixture['joints'][start:end]] for group, start, end in GROUPS}}})
        elif path == '/api/v1/body-cameras':
            self.reply({'ok': True, 'cameras': []})
        elif path == '/api/v1/execution/activity':
            self.reply({'ok': True, 'task_phase': 'running', 'navigation_phase': 'idle'})
        elif path == '/api/v1/execution':
            self.reply({'ok': True, 'run': {'id': RUN, 'phase': 'running', 'task_name': '表面投影回归',
                'completed_captures': len(fixture['captures']), 'algorithm_mode': 'execute', 'stage': 'capture'}})
        elif path == '/api/v1/execution/captures':
            records = [{'id': item['id'], 'side': side, 'sequence': i * 2 + j + 1, 'point_name': '投影采集'}
                for i, item in enumerate(fixture['captures']) for j, side in enumerate(item['sides'])]
            offset = int(parse_qs(urlsplit(self.path).query)['offset'][0])
            self.reply({'ok': True, 'run_id': RUN, 'captures': records[offset:], 'total': len(records), 'next_offset': len(records)})
        elif path.startswith('/api/v1/cameras/jobs/'):
            parts = path.split('/')
            item = next(value for value in fixture['captures'] if value['id'] == parts[5])
            if path.endswith('/png'):
                self.reply(PNG, 'image/png')
            else:
                self.reply({'job': {'state': 'complete', 'created_utc': item['created'], 'robot_pose': item['pose'],
                    'cameras': {side: {'files': [{'kind': 'png', 'url': f'{path}/{side}/png'}], 'inspection': {'state': 'skipped'}} for side in item['sides']}}})
        else:
            self.send_error(404)


def capture(sides=('left', 'right'), old=False):
    captured = time.time_ns() - (3_600_000_000_000 if old else 0)
    fixture['captures'].append({'id': f'{len(fixture["captures"]) + 1:032x}', 'sides': sides,
        'created': datetime.fromtimestamp(captured / 1e9, timezone.utc).isoformat(),
        'pose': {'source': 'capture_request', 'captured_ns': str(captured), 'robot_model': 'botx_abx_zivid_m70',
            'joints_rad': {group: fixture['joints'][start:end] for group, start, end in GROUPS}}})


servers = [ThreadingHTTPServer(('127.0.0.1', 0), Robot) for _ in range(2)]
for i, server in enumerate(servers):
    server.offset = i * .12
    Thread(target=server.serve_forever, daemon=True).start()

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
        page = browser.new_page(viewport={'width': 1560, 'height': 1000})
        page.set_default_timeout(20000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda message: errors.append(message.text) if message.type == 'error' and 'THREE.WebGL' in message.text else None)
        profiles = {'version': 1, 'profiles': [{'id': f'robot-{i}', 'name': f'测试机器人 {i+1}',
            'address': f'http://127.0.0.1:{server.server_port}'} for i, server in enumerate(servers)], 'selectedIds': ['robot-0', 'robot-1']}
        page.add_init_script('localStorage.setItem("atlas-route-studio:robot-twin-profiles-v1",' + json.dumps(json.dumps(profiles)) + ')')
        try:
            page.goto(BASE + '/workbench', wait_until='networkidle')
            page.locator('[data-session-state="ready"]').wait_for()
            page.locator('input[type="file"][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/continuous-camera-projection-map.ply'))
            page.locator('.loading-curtain').wait_for(state='hidden')
            topbar_action(page, name='加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70', exact=True).click()
            canvas = page.locator('.three-canvas')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded', timeout=180000)
            joints = json.loads(canvas.get_attribute('data-robot-joint-values'))
            fixture['joints'] = [joints[name] * 3.141592653589793 / 180 for name in NAMES]
            fixture['x'] = float(canvas.get_attribute('data-robot-x'))
            fixture['y'] = float(canvas.get_attribute('data-robot-y'))
            fixture['yaw'] = float(canvas.get_attribute('data-robot-yaw')) * 3.141592653589793 / 180
            page.get_by_role('button', name='同步作业', exact=True).click()
            page.get_by_role('dialog').get_by_role('button', name='真机孪生').click()
            dialog = page.get_by_role('dialog', name='真机孪生', exact=True)
            for field in dialog.get_by_label('管理员密码', exact=True).all():
                field.fill('fixture')
            dialog.get_by_role('button', name='连接并同步', exact=True).click()
            expect(dialog).not_to_be_visible(timeout=10000)
            capture()
            expect(canvas).to_have_attribute('data-twin-projection-frame-count', '4')
            expect(canvas).to_have_attribute('data-twin-projection-state', 'ready')
            signature = canvas.get_attribute('data-twin-projection-poses')
            poses = json.loads(signature)
            assert len({value['key'] for value in poses}) == 4, 'same capture IDs on two robots remain distinct'
            left_poses = [value for value in poses if value['side'] == 'left']
            assert abs(abs(left_poses[0]['position']['x'] - left_poses[1]['position']['x']) - .12) < 1e-6
            assert int(canvas.get_attribute('data-twin-projection-mesh-count')) > 0
            assert int(canvas.get_attribute('data-twin-projection-covered-point-count')) > 0
            fixture['move'] = 2
            page.wait_for_function('(expected) => Math.abs(Number(document.querySelector(".three-canvas").dataset.robotX) - expected) < 1e-5', arg=fixture['x'] + 2)
            assert canvas.get_attribute('data-twin-projection-poses') == signature
            settings = display_settings_section(page, '机器人与相机')
            settings.get_by_role('switch', name='显示机器人模型', exact=True).click()
            settings.get_by_role('button', name='关闭显示设置', exact=True).click()
            display_settings_section(page, '还原视角').get_by_role('button', name='俯视图', exact=True).click()
            page.keyboard.press('Escape')
            visible_pixels = canvas.screenshot(path=str(ARTIFACTS / 'surface-visible.png'))
            settings = display_settings_section(page, '机器人与相机')
            left = settings.get_by_role('switch', name='显示左臂拍照投影', exact=True)
            right = settings.get_by_role('switch', name='显示右臂拍照投影', exact=True)
            expect(left).to_be_checked(); expect(right).to_be_checked()
            left.click()
            expect(canvas).to_have_attribute('data-twin-projection-visible-frame-count', '2')
            expect(canvas).to_have_attribute('data-twin-projection-right-visible', 'true')
            right.click()
            expect(canvas).to_have_attribute('data-twin-projection-visible-frame-count', '0')
            expect(canvas).to_have_attribute('data-twin-projection-covered-point-count', '0')
            expect(canvas).to_have_attribute('data-twin-projection-mesh-count', '0')
            settings.get_by_role('button', name='关闭显示设置', exact=True).click()
            hidden_pixels = canvas.screenshot(path=str(ARTIFACTS / 'surface-hidden.png'))
            assert visible_pixels != hidden_pixels, 'switches must change the actual WebGL surface'
            settings = display_settings_section(page, '机器人与相机')
            capture(('left',))
            expect(canvas).to_have_attribute('data-twin-projection-frame-count', '6')
            expect(canvas).to_have_attribute('data-twin-projection-visible-frame-count', '0')
            left.click()
            expect(canvas).to_have_attribute('data-twin-projection-visible-frame-count', '4')
            capture(old=True)
            expect(settings).to_contain_text('2 次采集缺少拍照时的有效定位或姿态')
            expect(canvas).to_have_attribute('data-twin-projection-frame-count', '6')
            page.screenshot(path=str(ARTIFACTS / 'display-switches.png'))
            right.click()
            settings.get_by_role('button', name='关闭显示设置', exact=True).click()
            fixture['move'] = 0
            page.screenshot(path=str(ARTIFACTS / 'projected-surface.png'))
            page.get_by_role('button', name='停止同步', exact=True).click()
            expect(canvas).to_have_attribute('data-twin-projection-state', 'inactive')
            expect(canvas).to_have_attribute('data-twin-projection-frame-count', '0')
            fixture['captures'] = []
            page.get_by_role('button', name='同步作业', exact=True).click()
            page.get_by_role('dialog').get_by_role('button', name='真机孪生').click()
            dialog.get_by_role('button', name='连接并同步', exact=True).click()
            expect(dialog).not_to_be_visible(timeout=10000)
            expect(canvas).to_have_attribute('data-twin-projection-frame-count', '0')
            capture(('right',))
            expect(canvas).to_have_attribute('data-twin-projection-frame-count', '2')
            expect(canvas).to_have_attribute('data-twin-projection-visible-frame-count', '2')
            page.get_by_role('button', name='停止同步', exact=True).click()
            expect(canvas).to_have_attribute('data-twin-projection-state', 'inactive')
            assert not [path for method, path in traffic if method == 'POST' and path != '/api/v1/access/login']
            assert not [path for _, path in traffic if path.endswith('/xyzbin')], 'projection does not download extra clouds'
            assert not errors, errors
            print('Twin projection UI passed: real capture metadata, fleet isolation, fixed surfaces, independent switches, hidden capture retention, disconnect cleanup and reconnect.')
        finally:
            if errors:
                print('Browser errors:', errors)
            page.screenshot(path=str(ARTIFACTS / 'last-state.png'))
            browser.close()
finally:
    for server in servers:
        server.shutdown(); server.server_close()
