"""Two independent loopback robots: real mesh picking, monitoring and lifecycle."""
import json
import os
import subprocess
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:22061')
ARTIFACTS = ROOT / 'test-artifacts' / 'robot-twin-fleet'
ARTIFACTS.mkdir(parents=True, exist_ok=True)
# Both robots deliberately return the same run/capture IDs. Their poses,
# administrator passwords and task progress differ.
FIXTURE = r'''
import { createFakeRobotServer } from './scripts/lib/fake_robot_server.mjs';
import { createInterface } from 'node:readline';
const times = [0, 0], offsets = [0, 0], down = [false, false];
const servers = [0, 1].map((index) => {
  const server = createFakeRobotServer({ instance: 'same-task-ids', password: `admin-${index}`, clock: () => times[index] });
  const handler = server.listeners('request')[0]; server.removeAllListeners('request');
  server.on('request', (req, res) => {
    if (down[index] && req.url.startsWith('/api/')) { res.writeHead(503); res.end('{}'); return; }
    const end = res.end.bind(res), writeHead = res.writeHead.bind(res);
    if (req.url === '/api/v1/slam' || req.url === '/api/v1/execution') {
      let headers, code;
      res.writeHead = (status, values) => { code = status; headers = values; return res; };
      res.end = (bytes, ...args) => {
      try {
        const payload = JSON.parse(bytes);
        if (payload.sample?.pose) { payload.sample.pose.x_m = (index ? 1.7 : -1.7) + offsets[index]; payload.sample.pose.y_m = 0; payload.sample.pose.yaw_rad = 0; }
        if (payload.run) payload.run.task_name = index ? '二号巡检任务' : '一号巡检任务';
        bytes = Buffer.from(JSON.stringify(payload)); headers = { ...headers, 'Content-Length': bytes.length };
      } catch {}
      writeHead(code, headers); return end(bytes, ...args);
      };
    }
    void handler(req, res);
  }); return server;
});
await Promise.all(servers.map((server) => new Promise((done) => server.listen(0, '127.0.0.1', done))));
times[0] = 19000; times[1] = 39000;
console.log(JSON.stringify(servers.map((server) => `http://127.0.0.1:${server.address().port}`)));
createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line);
  if (command.move) { offsets[0] += 0.25; offsets[1] -= 0.25; times[0] += 300; times[1] += 300; }
  if (command.down !== undefined) down[1] = command.down;
});
'''
fixture = subprocess.Popen(['node', '--input-type=module', '-e', FIXTURE], cwd=ROOT,
                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
addresses = json.loads(fixture.stdout.readline())
profiles = [{'id': f'robot-{i}', 'name': f'{i+1} 号机器人', 'address': address} for i, address in enumerate(addresses)]
def command(value):
    fixture.stdin.write(json.dumps(value) + '\n'); fixture.stdin.flush()
def status(index):
    with urlopen(addresses[index] + '/__fake_robot/status', timeout=3) as response:
        return json.load(response)
def requests(index):
    return {key: count for key, count in status(index)['requests'].items() if '/api/' in key}

VIEW_KEYS = ['cameraX', 'cameraY', 'cameraZ', 'targetX', 'targetY', 'targetZ',
             'cameraUpX', 'cameraUpY', 'cameraUpZ', 'opticalZoom', 'precisionPanX', 'precisionPanY']
def camera_view(canvas):
    return canvas.evaluate('(canvas, keys) => keys.map(key => Number(canvas.dataset[key]))', VIEW_KEYS)
def expect_view(page, view):
    page.wait_for_function('''([keys, expected]) => {
      const data = document.querySelector('.three-canvas').dataset;
      return keys.every((key, i) => Math.abs(Number(data[key]) - expected[i]) < 1e-6);
    }''', arg=[VIEW_KEYS, view])

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get(
            'PLAYWRIGHT_CHROMIUM_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
        page = browser.new_page(viewport={'width': 1560, 'height': 1000})
        page.set_default_timeout(25000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script('''window.twinSuccessAnimations = 0;
          document.addEventListener('animationstart', event => {
            if (event.target.classList.contains('robot-twin-success__check')) window.twinSuccessAnimations++;
          }, true);''')
        page.add_init_script('localStorage.setItem("atlas-route-studio:robot-twin-profiles-v1", ' +
                             json.dumps(json.dumps({'version': 1, 'profiles': profiles, 'selectedIds': []})) + ');')
        held_connections = []
        hold_connections = True
        def safe_connect(route):
            assert route.request.post_data_json['address'] in addresses, 'Only connect to these two local fixtures'
            if hold_connections:
                held_connections.append(route)
            else:
                route.continue_()
        page.route('**/__atlas/robot-twin/sessions', safe_connect)
        try:
            page.goto(BASE + '/workbench', wait_until='networkidle')
            page.locator('[data-session-state="ready"]').wait_for()
            page.locator('input[type="file"][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/rotation-map.ply'))
            page.locator('.loading-curtain').wait_for(state='hidden')
            topbar_action(page, name='加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70', exact=True).click()
            canvas = page.locator('.three-canvas')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded', timeout=180000)
            offline = [canvas.get_attribute(f'data-robot-{key}') for key in ['x', 'y', 'z', 'yaw']]
            offline_view = camera_view(canvas)
            offline_signature = canvas.get_attribute('data-view-signature')
            page.get_by_role('button', name='同步作业', exact=True).click()
            page.get_by_role('dialog').get_by_role('button', name='真机孪生').click()
            dialog = page.get_by_role('dialog', name='真机孪生', exact=True)
            for profile in profiles:
                dialog.get_by_role('checkbox', name=profile['name'] + ' ' + profile['address'].removeprefix('http://'), exact=True).check()
            dialog.get_by_label('1 号机器人 · 管理员密码', exact=True).fill('admin-0')
            dialog.get_by_label('2 号机器人 · 管理员密码', exact=True).fill('incorrect')
            page.screenshot(path=str(ARTIFACTS / 'multi-selection.png'))
            dialog.get_by_role('button', name='连接并同步', exact=True).click()
            expect(dialog.get_by_role('checkbox').first).to_be_disabled()
            assert dialog.get_by_role('checkbox').evaluate_all(
                '(inputs) => inputs.every(input => getComputedStyle(input).opacity === "0")'), 'disabled native checkboxes must remain invisible'
            expect(dialog.locator('.robot-twin-success')).to_have_count(0)
            page.screenshot(path=str(ARTIFACTS / 'connecting-cards.png'))
            hold_connections = False
            for connection in held_connections:
                connection.continue_()
            expect(dialog.get_by_role('alert')).to_contain_text('密码')
            expect(dialog).to_be_visible()
            page.wait_for_function('JSON.parse(document.querySelector(".three-canvas").dataset.twinRobots).length === 1')
            login_a = requests(0)['POST /api/v1/access/login']
            dialog.get_by_label('2 号机器人 · 管理员密码', exact=True).fill('admin-1')
            dialog.get_by_role('button', name='重试并同步所选机器人', exact=True).click()
            expect(dialog.locator('.robot-twin-success')).to_be_visible()
            assert dialog.locator('.robot-twin-success__check').evaluate('(el) => el.getAnimations().length') > 0
            # One robot can temporarily lose a poll during the success mark.
            # Recovery must not remount/replay the batch's animation.
            command({'down': True})
            expect(page.locator('.robot-twin-scene-label.is-stale')).to_have_count(1)
            expect(dialog.locator('.robot-twin-success')).to_be_visible()
            command({'down': False})
            expect(dialog).not_to_be_visible(timeout=4000)
            assert page.evaluate('window.twinSuccessAnimations') == 1
            assert requests(0)['POST /api/v1/access/login'] == login_a
            page.wait_for_function('JSON.parse(document.querySelector(".three-canvas").dataset.twinRobots).length === 2')
            monitor = page.get_by_role('complementary', name='任务监控台', exact=True)
            expect(monitor).to_have_attribute('data-robot-id', 'robot-0')
            expect(monitor).to_contain_text('一号巡检任务')
            page.screenshot(path=str(ARTIFACTS / 'two-robots.png'))
            pose_before = json.loads(canvas.get_attribute('data-twin-robots'))
            assert len({robot['color'] for robot in pose_before}) == 2
            assert all(robot['bodyMeshes'] > 20 and robot['preservedMeshes'] >= 2 for robot in pose_before)
            command({'move': True})
            page.wait_for_function('before => JSON.parse(document.querySelector(".three-canvas").dataset.twinRobots).every((p, i) => p.x !== before[i].x)', arg=pose_before)
            camera = monitor.get_by_role('region', name='本体相机', exact=True)
            camera.get_by_role('switch', name='本体相机实时画面').click()
            expect(camera).to_have_attribute('data-camera-phase', 'live')
            # Click actual canvas geometry; labels/select are not used here.
            def click_robot(robot_id):
                records = json.loads(canvas.get_attribute('data-twin-robots'))
                target = next(record for record in records if record['id'] == robot_id)
                bounds = canvas.bounding_box()
                page.mouse.click(bounds['x'] + target['screenX'], bounds['y'] + target['screenY'])
                expect(canvas).to_have_attribute('data-last-pick-type', 'twin-robot')
                expect(canvas).to_have_attribute('data-last-pick-id', robot_id)
                expect(monitor).to_have_attribute('data-robot-id', robot_id)
            click_robot('robot-1')
            expect(monitor).to_contain_text('二号巡检任务')
            expect(camera.get_by_role('switch', name='本体相机实时画面')).to_have_attribute('aria-checked', 'false')
            assert status(0)['activeCamera'] is None
            capture = monitor.get_by_role('region', name='Zivid 采集结果', exact=True)
            expect(capture.get_by_role('img', name='左 Zivid拍摄图像')).to_be_visible()
            capture_b = capture.get_attribute('data-capture-id')
            camera.get_by_role('switch', name='本体相机实时画面').click()
            expect(camera).to_have_attribute('data-camera-phase', 'live')
            click_robot('robot-0')
            expect(monitor).to_contain_text('一号巡检任务')
            expect(capture).not_to_have_attribute('data-capture-id', capture_b)
            expect(capture.get_by_role('img', name='左 Zivid拍摄图像')).to_be_visible()
            assert status(1)['activeCamera'] is None
            # A drag is camera navigation, not robot selection.
            before = canvas.get_attribute('data-selected-twin-robot')
            bounds = canvas.bounding_box()
            page.mouse.move(bounds['x'] + 90, bounds['y'] + 150)
            page.mouse.down(); page.mouse.move(bounds['x'] + 125, bounds['y'] + 175, steps=5); page.mouse.up()
            expect(canvas).to_have_attribute('data-selected-twin-robot', before)
            # Sidebar fallback handles robots outside the view or occupying the same position.
            monitor.get_by_role('combobox', name='当前监控机器人').select_option('robot-1')
            expect(monitor).to_contain_text('二号巡检任务')
            command({'down': True})
            expect(page.locator('.robot-twin-scene-label.is-selected')).to_have_class('robot-twin-scene-label is-selected is-stale')
            monitor.get_by_role('combobox', name='当前监控机器人').select_option('robot-0')
            expect(monitor).to_have_attribute('data-monitor-phase', 'live')
            assert len(json.loads(canvas.get_attribute('data-twin-robots'))) == 2
            command({'down': False})
            assert any(abs(a-b) > .01 for a, b in zip(camera_view(canvas), offline_view)), 'fleet observation changes the live camera'
            assert canvas.get_attribute('data-view-signature') == offline_signature, 'twin navigation must not replace the saved offline view'
            page.screenshot(path=str(ARTIFACTS / 'monitor-switch.png'))
            page.get_by_role('button', name='停止同步', exact=True).click()
            expect(monitor).to_have_count(0)
            expect(canvas).to_have_attribute('data-twin-robots', '[]')
            expect_view(page, offline_view)
            assert [canvas.get_attribute(f'data-robot-{key}') for key in ['x', 'y', 'z', 'yaw']] == offline
            expect(page.locator('.robot-twin-scene-label')).to_have_count(0)
            page.wait_for_timeout(700)
            before = [requests(0), requests(1)]
            page.wait_for_timeout(1600)
            assert [requests(0), requests(1)] == before, 'all polling must stop'
            # A new session must capture the newly edited offline view, not the
            # first session's camera. Stop while following this time.
            canvas.press('ArrowUp')
            page.wait_for_function('''original => {
              const d = document.querySelector('.three-canvas').dataset;
              return Math.abs(Number(d.cameraZ) - original[2]) > .001;
            }''', arg=offline_view)
            second_view = camera_view(canvas)
            # Remembered credentials work for the whole selection without auto-connecting on a card click.
            page.get_by_role('button', name='同步作业', exact=True).click()
            page.get_by_role('dialog').get_by_role('button', name='真机孪生').click()
            expect(dialog.locator('input[type=password]')).to_have_count(0)
            assert dialog.get_by_role('checkbox').evaluate_all('(inputs) => inputs.every(input => input.checked)')
            dialog.get_by_role('button', name='连接并同步', exact=True).click()
            expect(dialog.locator('.robot-twin-success')).to_be_visible()
            expect(dialog).not_to_be_visible(timeout=4000)
            assert page.evaluate('window.twinSuccessAnimations') == 2, 'exactly one animation per connection attempt'
            page.wait_for_function('JSON.parse(document.querySelector(".three-canvas").dataset.twinRobots).length === 2')
            follow = page.get_by_role('button', name='机器人后上方跟随视角', exact=True)
            follow.click()
            expect(follow).to_have_attribute('aria-pressed', 'true')
            page.get_by_role('button', name='停止同步', exact=True).click()
            expect_view(page, second_view)
            expect(canvas).to_have_attribute('data-twin-follow-enabled', 'false')
            # Normal workspace persistence must also keep the restored view.
            page.reload(wait_until='networkidle')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded', timeout=180000)
            expect_view(page, second_view)
            assert not errors, errors
            for index in [0, 1]:
                assert all(key.startswith('GET ') or key in ['POST /api/v1/access/login', 'POST /api/v1/body-cameras/preview', 'POST /api/v1/body-cameras/frame'] for key in requests(index))
            print(json.dumps({'robots': 2, 'meshPicking': True, 'independentMonitoring': True, 'partialFailureRetry': True,
                              'cameraIsolation': True, 'offlineRestored': True, 'errors': errors}))
        except Exception:
            page.screenshot(path=str(ARTIFACTS / 'failure.png'))
            print('Browser errors:', errors)
            print('Canvas:', canvas.get_attribute('data-twin-robots'))
            raise
        finally:
            browser.close()
finally:
    fixture.terminate(); fixture.wait(timeout=5)
