"""Read-only twin UI regression. --live explicitly uses the supplied LAN robot."""
import argparse
import json
import math
import os
import re
from pathlib import Path
from threading import Thread
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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
fixture = {'stale': False, 'x': 2.5, 'task_phase': 'running', 'task_failure': False, 'processing': True,
           'run_id': 'd' * 32, 'task_name': '设备巡检任务', 'captures': 1}


class RobotFixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        traffic.append(('GET', self.path))
        if self.path == '/api/v1/model':
            payload = {'name': 'botx_abx_zivid_m70', 'joint_names_sdk_order': NAMES}
        elif self.path == '/api/v1/slam':
            payload = {'fresh': not fixture['stale'], 'age_ms': 10, 'sample': {'ok': True, 'source': 'slam_websocket',
                'scene': {'mode': 'kLocalization', 'operation_running': False},
                'pose': {'x_m': fixture['x'], 'y_m': -3.25, 'yaw_rad': 1}}}
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
        self.send_error(405)


server = None
if args.live:
    address = os.environ.get('ROBOT_TWIN_ADDRESS', '192.168.0.112:9090')
    password = os.environ.get('ROBOT_TWIN_PASSWORD', '')
else:
    server = ThreadingHTTPServer(('127.0.0.1', 0), RobotFixture)
    Thread(target=server.serve_forever, daemon=True).start()
    address = f'127.0.0.1:{server.server_port}'
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
                dialog.get_by_label('机器人地址', exact=True).fill('invalid-address')
                dialog.get_by_role('button', name='连接并同步', exact=True).click()
                expect(dialog.locator('.robot-twin-panel__state')).to_contain_text('连接失败')
                page.wait_for_timeout(1300)
                expect(dialog).to_be_visible()
                expect(dialog.locator('.robot-twin-success')).to_have_count(0)
            dialog.get_by_label('机器人地址', exact=True).fill(address)
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
                fixture['task_phase'] = 'paused'
                expect(monitor.locator('.task-monitor__section-title').first).to_contain_text('已暂停')
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
                # Stopping inside the form must not turn the same click into
                # another form submit and silently reconnect. Unready feedback
                # keeps the dialog open instead of displaying a success check.
                fixture['stale'] = True
                page.get_by_role('button', name='同步作业', exact=True).click()
                page.get_by_role('dialog').get_by_role('button', name='真机孪生').click()
                panel = page.get_by_role('dialog', name='真机孪生', exact=True)
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
        assert all(method == 'GET' and (path in ['/api/v1/slam', '/api/v1/state', '/api/v1/model', '/api/v1/execution', '/api/v1/execution/activity']
            or re.fullmatch(r'/api/v1/execution/captures\?run_id=[a-f0-9]{32}&offset=0', path)
            or path == '/api/v1/cameras/jobs/' + 'e' * 32) for method, path in traffic), traffic
