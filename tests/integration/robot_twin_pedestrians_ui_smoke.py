"""Real HTTP proxy, ABX-shaped fixtures and WebGL; no production robot access."""
import base64
import json
import math
import os
import sys
import time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests'))
from topbar_tools_helpers import topbar_action
from robot_twin_follow_helpers import select_follow_mode
from viewer_tools_helpers import display_settings_section

BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:22369')
ARTIFACTS = ROOT / 'test-artifacts' / 'robot-twin-pedestrians'
ARTIFACTS.mkdir(parents=True, exist_ok=True)
NAMES = ['ankle_pitch_J', 'knee_pitch_J', 'waist_pitch_J', 'waist_yaw_J', 'head_yaw_J', 'head_pitch_J'] + [f'{s}_J{i}' for s in ['left', 'right'] for i in range(1, 8)]
GROUPS = [('torso', 0, 4), ('head', 4, 6), ('left_arm', 6, 13), ('right_arm', 13, 20)]
fixture = {'stale': False, 'failure': False, 'empty': False, 'localization': True, 'joints': [0.] * 20,
    'motion_at': None, 'motion_base': 0, 'alternate': False, 'detection_frames': 0}
traffic = []
timing = []


def motion_offset():
    return fixture['motion_base'] + ((time.monotonic() - fixture['motion_at']) * .25 if fixture['motion_at'] is not None else 0)


class Robot(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, value):
        data = json.dumps(value).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        traffic.append((self.server.index, self.path))
        if self.path in ['/api/v1/slam', '/api/v1/lidars/detection/status']:
            timing.append((time.monotonic() * 1000, self.server.index, self.path))
        if self.path == '/api/v1/model':
            self.reply({'name': 'botx_abx_zivid_m70', 'joint_names_sdk_order': NAMES})
        elif self.path == '/api/v1/slam':
            self.reply({'fresh': fixture['localization'], 'age_ms': 1, 'sample': {'ok': True, 'source': 'slam_websocket',
                'scene': {'mode': 'kLocalization', 'operation_running': False},
                'pose': {'x_m': self.server.index * 4 + motion_offset(), 'y_m': 0, 'yaw_rad': math.pi / 2}}})
        elif self.path == '/api/v1/state':
            self.reply({'robot': {'valid': True, 'state_fresh': True, 'health_fresh': True, 'state_age_ms': 1,
                'joint_samples': {group: [{'valid': True, 'fresh': True, 'position_rad': value}
                    for value in fixture['joints'][start:end]] for group, start, end in GROUPS}}})
        elif self.path == '/api/v1/lidars/detection/status':
            if fixture['failure']:
                self.send_error(503)
                return
            fixture['detection_frames'] += 1
            empty = fixture['empty'] or fixture['alternate'] and fixture['detection_frames'] % 2 == 0
            self.reply({'ok': True, 'mode': 'resident', 'state': 'running', 'enabled': True, 'ready': True,
                'frame': 'base_link', 'captured_at_ms': time.time_ns() // 1000000, 'ttl_ms': 600,
                'source_age_ms': 10, 'result_age_ms': 700 if fixture['stale'] else 1,
                'boxes': [] if empty else [
                    {'label': 'person', 'center_m': [1.6, -.9, .85], 'size_m': [.45, .55, 1.7], 'yaw_rad': .2, 'score': .9},
                    {'label': 'person', 'center_m': [1.9, 1.2, .9], 'size_m': [.5, .6, 1.8], 'yaw_rad': -.6, 'score': .8}]})
        elif self.path == '/api/v1/body-cameras':
            self.reply({'ok': True, 'cameras': []})
        elif self.path == '/api/v1/execution/activity':
            self.reply({'ok': True, 'task_phase': 'idle', 'navigation_phase': 'idle'})
        elif self.path == '/api/v1/execution':
            self.reply({'ok': True, 'run': None})
        else:
            self.send_error(404)


servers = [ThreadingHTTPServer(('127.0.0.1', 0), Robot) for _ in range(2)]
for i, server in enumerate(servers):
    server.index = i
    Thread(target=server.serve_forever, daemon=True).start()


def detection_reads(index=None):
    return sum(path == '/api/v1/lidars/detection/status' and (index is None or robot == index) for robot, path in traffic)


try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
        page = browser.new_page(viewport={'width': 1560, 'height': 1000})
        page.set_default_timeout(20000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        profiles = {'version': 1, 'profiles': [{'id': f'robot-{i}', 'name': f'感知测试机器人 {i+1}',
            'address': f'http://127.0.0.1:{server.server_port}'} for i, server in enumerate(servers)], 'selectedIds': ['robot-0', 'robot-1']}
        page.add_init_script('localStorage.setItem("atlas-route-studio:robot-twin-profiles-v1",' + json.dumps(json.dumps(profiles)) + ')')
        # Reject accidental connections outside this test's two loopback robots.
        def connect(route):
            assert route.request.post_data_json['address'] in [item['address'] for item in profiles['profiles']]
            route.continue_()
        page.route('**/__atlas/robot-twin/sessions', connect)
        try:
            page.goto(BASE + '/workbench', wait_until='networkidle')
            rendering = page.evaluate('''async () => {
                const { checkPedestrianFade } = await import('/tests/robot_twin_pedestrians_rendering.mjs');
                return checkPedestrianFade();
            }''')
            for image in rendering.pop('images'):
                for state in ['solid', 'faded']:
                    (ARTIFACTS / f'fade-{image["name"]}-{state}.png').write_bytes(base64.b64decode(image[state].split(',')[1]))
            (ARTIFACTS / 'fade-rendering.json').write_text(json.dumps(rendering, indent=2))
            page.locator('[data-session-state="ready"]').wait_for()
            page.locator('input[type="file"][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/continuous-camera-projection-map.ply'))
            page.locator('.loading-curtain').wait_for(state='hidden')
            topbar_action(page, name='加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70', exact=True).click()
            canvas = page.locator('.three-canvas')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded', timeout=180000)
            offline = canvas.get_attribute('data-robot-origin')
            joints = json.loads(canvas.get_attribute('data-robot-joint-values'))
            fixture['joints'] = [joints[name] * math.pi / 180 for name in NAMES]
            settings = display_settings_section(page, '机器人与相机')
            pedestrians = settings.get_by_role('region', name='行人感知', exact=True)
            switch = pedestrians.get_by_role('switch', name='显示行人感知', exact=True)
            expect(switch).to_be_disabled()
            expect(switch).to_have_attribute('aria-checked', 'false')
            expect(pedestrians.get_by_role('status')).to_have_count(0)
            expect(switch).to_have_attribute('title', '连接真机孪生后自动开启')
            assert detection_reads() == 0
            settings.get_by_role('button', name='关闭显示设置', exact=True).click()
            page.get_by_role('button', name='同步作业', exact=True).click()
            page.get_by_role('dialog').get_by_role('button', name='真机孪生').click()
            dialog = page.get_by_role('dialog', name='真机孪生', exact=True)
            for field in dialog.get_by_label('管理员密码', exact=True).all():
                field.fill('fixture')
            dialog.get_by_role('button', name='连接并同步', exact=True).click()
            expect(dialog).not_to_be_visible(timeout=10000)
            expect(page.get_by_role('complementary', name='任务监控台').get_by_role('switch', name='显示行人感知')).to_have_count(0)
            display_settings_section(page, '机器人与相机')
            expect(switch).to_be_enabled()
            expect(switch).to_have_attribute('aria-checked', 'true')
            page.wait_for_function('JSON.parse(document.querySelector(".three-canvas").dataset.twinPedestrians || "[]").length === 2')
            people = json.loads(canvas.get_attribute('data-twin-pedestrians'))
            assert abs(people[0]['x'] - .9) < 1e-6 and abs(people[0]['y'] - 1.6) < 1e-6
            expect(pedestrians.get_by_role('status')).to_have_count(0)
            expect(pedestrians).not_to_contain_text('当前检测到')
            expect(pedestrians).to_contain_text('当前监控：感知测试机器人 1')
            page.screenshot(path=str(ARTIFACTS / 'settings-enabled.png'))
            settings.get_by_role('button', name='关闭显示设置', exact=True).click()
            expect(switch).to_have_count(0)
            # Closing/unmounting the menu must not disable reading or the 3D layer.
            select_follow_mode(page)
            page.wait_for_timeout(300)
            page.screenshot(path=str(ARTIFACTS / 'enabled.png'))
            before = detection_reads()
            page.wait_for_timeout(1600)
            assert 2 <= detection_reads() - before <= 4
            assert detection_reads(1) == 0
            fixture['motion_at'] = time.monotonic()
            page.wait_for_timeout(1400)
            def readings(duration):
                return page.evaluate('''duration => new Promise(resolve => {
                  const rows = [], start = performance.now();
                  const tick = () => {
                    const c = document.querySelector('.three-canvas');
                    rows.push({time: performance.now(), robots: JSON.parse(c.dataset.twinRobots), people: JSON.parse(c.dataset.twinPedestrians)});
                    if (performance.now() - start >= duration) resolve(rows); else requestAnimationFrame(tick);
                  }; requestAnimationFrame(tick);
                })''', duration)
            moving = readings(2400)
            assert len(moving) > 30 and all(len(row['people']) == 2 for row in moving)
            phase_error = max(abs(row['people'][0]['x'] - next(r['x'] for r in row['robots'] if r['selected']) - .9) for row in moving)
            (ARTIFACTS / 'motion.json').write_text(json.dumps({'rows': moving, 'requests': timing, 'phaseErrorMetres': phase_error}))
            assert phase_error < .06, ('robot/pedestrian phase mismatch in metres', phase_error)
            stable_ids = [person['trackId'] for person in moving[-1]['people']]
            fixture['alternate'] = True
            intermittent = readings(2800)
            assert all([person['trackId'] for person in row['people']] == stable_ids for row in intermittent), 'an isolated miss must not remove/recreate people'
            assert all(person['opacity'] >= .999 for row in intermittent for person in row['people']), 'isolated misses must not dim people'
            maximum_step = max(abs(b['people'][0]['x'] - a['people'][0]['x']) for a, b in zip(intermittent, intermittent[1:]))
            assert maximum_step < .06, ('reacquisition jump', maximum_step)
            fixture['alternate'] = False
            # Stop at the current position instead of teleporting SLAM back to
            # zero, which would test reassociation after a map jump as well.
            fixture.update({'motion_base': motion_offset(), 'motion_at': None})
            page.wait_for_timeout(1700)
            display_settings_section(page, '机器人与相机')
            expect(switch).to_have_attribute('aria-checked', 'true')
            fixture['empty'] = True
            page.wait_for_function('JSON.parse(document.querySelector(".three-canvas").dataset.twinPedestrians).some(p => p.opacity < .9 && p.opacity > .5)')
            recovering_ids = [person['trackId'] for person in json.loads(canvas.get_attribute('data-twin-pedestrians'))]
            fixture['empty'] = False
            page.screenshot(path=str(ARTIFACTS / 'held.png'))
            recovery = readings(1600)
            (ARTIFACTS / 'presence.json').write_text(json.dumps({'intermittent': intermittent,
                'recoveringIds': recovering_ids, 'recovery': recovery, 'requests': timing}))
            assert all([person['trackId'] for person in row['people']] == recovering_ids for row in recovery), 'a returning observation must reuse the fading models'
            assert all(person['opacity'] == 1 for person in recovery[-1]['people'])
            fixture['empty'] = True
            expect(canvas).to_have_attribute('data-twin-pedestrians', '[]')
            expect(pedestrians.get_by_role('status')).to_have_count(0)
            expect(pedestrians).not_to_contain_text('当前检测到')
            fixture['empty'] = False
            page.wait_for_function('JSON.parse(document.querySelector(".three-canvas").dataset.twinPedestrians).length === 2')
            # Repeated waiting/error/live transitions cannot move controls below
            # the pedestrian row. Exercise real clicks at each transition.
            coordinate = settings.get_by_role('checkbox', name='显示全身坐标系', exact=True)
            coordinate.scroll_into_view_if_needed()
            page.evaluate('() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))')
            baseline = coordinate.bounding_box()
            original_checked = coordinate.is_checked()
            layout = []
            for failure, phase in [('stale', 'waiting'), ('failure', 'error'), ('stale', 'waiting')]:
                fixture[failure] = True
                expect(pedestrians).to_have_attribute('data-pedestrians-phase', phase)
                expect(pedestrians.get_by_role('status')).to_have_count(0)
                expect(pedestrians).not_to_contain_text('行人感知已过期')
                box = coordinate.bounding_box()
                assert abs(box['y'] - baseline['y']) < 1 and abs(box['x'] - baseline['x']) < 1, ('control moved', baseline, box)
                coordinate.click()
                expect(coordinate).to_be_checked(checked=not original_checked)
                coordinate.click()
                expect(coordinate).to_be_checked(checked=original_checked)
                layout.append({'phase': phase, 'box': box})
                fixture[failure] = False
                expect(pedestrians).to_have_attribute('data-pedestrians-phase', 'live')
                box = coordinate.bounding_box()
                assert abs(box['y'] - baseline['y']) < 1 and abs(box['x'] - baseline['x']) < 1
                layout.append({'phase': 'live', 'box': box})
            (ARTIFACTS / 'settings-layout.json').write_text(json.dumps(layout, indent=2))
            page.wait_for_function('JSON.parse(document.querySelector(".three-canvas").dataset.twinPedestrians).length === 2')
            fixture['localization'] = False
            expect(canvas).to_have_attribute('data-twin-pedestrians', '[]')
            fixture['localization'] = True
            page.wait_for_function('JSON.parse(document.querySelector(".three-canvas").dataset.twinPedestrians).length === 2')
            page.evaluate('Object.defineProperty(document, "hidden", {configurable:true, value:true}); document.dispatchEvent(new Event("visibilitychange"))')
            expect(canvas).to_have_attribute('data-twin-pedestrians', '[]')
            paused = detection_reads()
            page.wait_for_timeout(750)
            assert detection_reads() == paused
            page.evaluate('delete document.hidden; document.dispatchEvent(new Event("visibilitychange"))')
            page.wait_for_function('JSON.parse(document.querySelector(".three-canvas").dataset.twinPedestrians).length === 2')
            # A small viewport retains a usable switch and an uncut status.
            page.set_viewport_size({'width': 1060, 'height': 760})
            expect(switch).to_be_visible()
            page.wait_for_function('''() => {
              const box = document.querySelector('[aria-label="显示行人感知"]').getBoundingClientRect();
              return box.left >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight;
            }''')
            page.evaluate('() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))')
            assert switch.evaluate('''el => {
              const box = el.getBoundingClientRect();
              return box.right <= window.innerWidth && el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
            }'''), 'compact switch must remain inside the viewport and reachable'
            page.screenshot(path=str(ARTIFACTS / 'compact.png'))
            switch.click()
            expect(canvas).to_have_attribute('data-twin-pedestrians', '[]')
            stopped = detection_reads()
            page.wait_for_timeout(850)
            assert detection_reads() == stopped
            switch.click()
            page.wait_for_function('JSON.parse(document.querySelector(".three-canvas").dataset.twinPedestrians).length === 2')
            settings.get_by_role('button', name='关闭显示设置', exact=True).click()
            page.get_by_role('button', name='当前监控机器人', exact=True).click()
            page.get_by_role('option', name='感知测试机器人 2', exact=True).click()
            display_settings_section(page, '机器人与相机')
            expect(pedestrians).to_contain_text('当前监控：感知测试机器人 2')
            expect(switch).to_have_attribute('aria-checked', 'true')
            page.wait_for_function('JSON.parse(document.querySelector(".three-canvas").dataset.twinPedestrians)[0]?.robotId === "robot-1"')
            people = json.loads(canvas.get_attribute('data-twin-pedestrians'))
            assert abs(people[0]['x'] - 4.9 - motion_offset()) < 1e-6
            settings.get_by_role('button', name='关闭显示设置', exact=True).click()
            page.get_by_role('button', name='停止同步', exact=True).click()
            expect(canvas).to_have_attribute('data-twin-pedestrians', '[]')
            expect(canvas).to_have_attribute('data-robot-origin', offline)
            display_settings_section(page, '机器人与相机')
            expect(switch).to_be_disabled()
            expect(switch).to_have_attribute('aria-checked', 'false')
            stopped = detection_reads()
            page.wait_for_timeout(750)
            assert detection_reads() == stopped
            settings.get_by_role('button', name='关闭显示设置', exact=True).click()
            page.get_by_role('button', name='同步作业', exact=True).click()
            page.get_by_role('dialog').get_by_role('button', name='真机孪生').click()
            dialog.get_by_role('button', name='连接并同步', exact=True).click()
            expect(dialog).not_to_be_visible(timeout=10000)
            page.wait_for_function('JSON.parse(document.querySelector(".three-canvas").dataset.twinPedestrians).length === 2')
            display_settings_section(page, '机器人与相机')
            expect(switch).to_have_attribute('aria-checked', 'true')
            expect(pedestrians).not_to_contain_text('当前检测到')
            settings.get_by_role('button', name='关闭显示设置', exact=True).click()
            page.get_by_role('button', name='停止同步', exact=True).click()
            assert not errors, errors
            print(json.dumps({'ok': True, 'pedestrianReads': detection_reads(), 'phaseErrorMetres': phase_error,
                'maximumReacquisitionStepMetres': maximum_step, 'screenshots': str(ARTIFACTS)}, ensure_ascii=False))
        finally:
            if errors:
                print('Browser errors:', errors)
            page.screenshot(path=str(ARTIFACTS / 'last-state.png'))
            browser.close()
finally:
    for server in servers:
        server.shutdown()
        server.server_close()
