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
fixture = {'stale': False, 'x': 2.5, 'task_phase': 'running', 'task_failure': False, 'processing': True,
           'run_id': 'd' * 32, 'task_name': '设备巡检任务', 'captures': 1, 'freeze_video': False}


class RobotFixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        traffic.append(('GET', self.path))
        robot_ports.append(self.server.server_port)
        if self.path == '/api/v1/model':
            payload = {'name': 'botx_abx_zivid_m70', 'joint_names_sdk_order': NAMES}
        elif self.path == '/api/v1/body-cameras':
            payload = {'ok': True, 'preview_fps': 6, 'cameras': [{'id': key, 'label': label, 'available': key != 'head-right'} for key, label in BODY_CAMERAS.items()]}
        elif self.path == '/api/v1/slam':
            payload = {'fresh': not fixture['stale'], 'age_ms': 10, 'sample': {'ok': True, 'source': 'slam_websocket',
                'scene': {'mode': 'kLocalization', 'operation_running': False},
                'pose': {'x_m': getattr(self.server, 'pose_x', fixture['x']), 'y_m': -3.25, 'yaw_rad': 1}}}
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
    Thread(target=server.serve_forever, daemon=True).start()
    address = f'127.0.0.1:{server.server_port}'
    backup_server = ThreadingHTTPServer(('127.0.0.1', 0), RobotFixture)
    backup_server.pose_x = 8.5
    Thread(target=backup_server.serve_forever, daemon=True).start()
    backup_address = f'127.0.0.1:{backup_server.server_port}'
    password = ''


def reading(canvas):
    return {'pose': {key: float(canvas.get_attribute(f'data-robot-{key}')) for key in ['x', 'y', 'z', 'roll', 'pitch', 'yaw']},
            'joints': json.loads(canvas.get_attribute('data-robot-joint-values'))}


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
            page.get_by_role('button', name='同步作业', exact=True).click()
            page.get_by_role('dialog').get_by_role('button', name='真机孪生').click()
            dialog = page.get_by_role('dialog', name='真机孪生', exact=True)
            if not args.live:
                expect(dialog.get_by_role('radio', name='ABX 机器人 192.168.0.112:9090', exact=True)).to_be_checked()
                dialog.get_by_role('button', name='编辑已选机器人').click()
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
                dialog.get_by_role('button', name='编辑已选机器人').click()
                dialog.get_by_label('机器人名称', exact=True).fill('测试机器人 B')
                dialog.get_by_role('button', name='保存机器人', exact=True).click()
                add_robot('重复地址', 'http://' + address + '/')
                expect(dialog.get_by_role('alert')).to_contain_text('此地址已保存为“测试机器人 A”')
                dialog.get_by_role('button', name='取消编辑').click()
                dialog.get_by_role('button', name='移除已选机器人').click()
                expect(dialog.get_by_role('radio', name=f'测试机器人 B {backup_address}', exact=True)).to_have_count(0)
                dialog.get_by_role('button', name='撤销移除').click()
                expect(dialog.get_by_role('radio', name=f'测试机器人 B {backup_address}', exact=True)).to_be_checked()
                dialog.get_by_label('管理员密码', exact=True).fill('do-not-persist-this-password')
                dialog.get_by_text('测试机器人 A', exact=True).click()
                expect(dialog.get_by_label('管理员密码', exact=True)).to_have_value('')
                assert not traffic, 'saving and selecting cards must not contact any robot'
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
                    dialog.get_by_role('button', name='编辑已选机器人').click()
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
                monitor.get_by_text('原始算法输出', exact=True).click()
                expect(monitor.locator('pre')).to_contain_text('"x": 20')
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
            page.get_by_role('button', name='停止同步', exact=True).click()
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
                panel.get_by_text('测试机器人 A', exact=True).click()
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
                expect(restored.get_by_label('管理员密码', exact=True)).to_have_value('')
                stored = page.evaluate("localStorage.getItem('atlas-route-studio:robot-twin-profiles-v1')")
                assert 'do-not-persist-this-password' not in stored and 'password' not in stored
                assert len(json.loads(stored)['profiles']) == 3
            assert not errors, errors
            print(json.dumps({'mode': 'live robot' if args.live else 'fixture', 'snapshots': len(snapshots),
                              'livePose': live['pose'], 'jointCount': len(NAMES), 'offlineRestored': True,
                              'pageErrors': errors}, ensure_ascii=False))
        except Exception:
            print('Visible dialogs:', page.get_by_role('dialog').all_inner_texts())
            print('Fixture traffic:', traffic)
            print('Page errors:', errors)
            page.screenshot(path=str(artifacts / 'failure.png'))
            raise
        finally:
            browser.close()
finally:
    if server:
        server.shutdown()
        backup_server.shutdown()
        assert all((method == 'POST' and path in ['/api/v1/body-cameras/preview', '/api/v1/body-cameras/frame']) or
            (method == 'GET' and (path in ['/api/v1/slam', '/api/v1/state', '/api/v1/model', '/api/v1/execution', '/api/v1/execution/activity', '/api/v1/body-cameras']
            or re.fullmatch(r'/api/v1/execution/captures\?run_id=[a-f0-9]{32}&offset=0', path)
            or path == '/api/v1/cameras/jobs/' + 'e' * 32)) for method, path in traffic), traffic
