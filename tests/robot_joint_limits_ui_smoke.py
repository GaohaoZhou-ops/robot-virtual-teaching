"""Exercise real URDF loading, control paths and the iPad LAN protocol in an isolated browser."""
import json
import math
import os
import subprocess
import time
from xml.etree import ElementTree as ET
from playwright.sync_api import sync_playwright, expect
from ipad_screen_capture_ui_smoke import PEER, ROOT
from topbar_tools_helpers import topbar_action
from viewer_tools_helpers import viewer_tool
from joint_lock_smoke import double_click_tool

BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:21992').rstrip('/')
OUTPUT = ROOT / 'build/robot-soft-limits'
LIMITS = {}
for node in ET.parse(ROOT / 'robots/botx_abx_zivid_m70/urdf/botx_abx_zivid_m70.urdf').findall('joint'):
    if node.get('name').startswith(('left_J', 'right_J')):
        hard = [math.degrees(float(node.find('limit').get(key))) for key in ['lower', 'upper']]
        margin = (hard[1] - hard[0]) * 0.025
        LIMITS[node.get('name')] = [hard[0] + margin, hard[1] - margin]


def run():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name in ['state.json', 'command.json']:
        (OUTPUT / name).unlink(missing_ok=True)
    peer = None
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or None,
            args=['--use-angle=metal', '--enable-gpu'])
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        page.set_default_timeout(90000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))

        def windows_info(route):
            response = route.fetch(); info = response.json(); info['usbSupported'] = False
            route.fulfill(response=response, json=info)
        page.route('**/__atlas/ipad-screen/info', windows_info)

        def values():
            return json.loads(page.locator('.three-canvas').get_attribute('data-robot-joint-values'))

        def within_limits():
            current = values()
            for name, (lower, upper) in LIMITS.items():
                assert lower - 1e-7 <= current[name] <= upper + 1e-7, (name, current[name], lower, upper)

        def applied(name, value):
            page.wait_for_function('''([name, value]) => {
                const actual = JSON.parse(document.querySelector('.three-canvas')?.dataset.robotJointValues || '{}')[name];
                const row = document.querySelector(`[data-joint-name="${name}"]`);
                return Math.abs(actual - value) < 1e-7 && Math.abs(Number(row?.dataset.jointValue) - value) < 1e-7;
            }''', arg=[name, value])

        def state():
            file = OUTPUT / 'state.json'
            return json.loads(file.read_text()) if file.exists() else {}

        def wait(check, label):
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                current = state()
                if check(current): return current
                page.wait_for_timeout(100)
            raise AssertionError(label)

        try:
            page.goto(BASE + '/workbench', wait_until='networkidle')
            page.locator('[data-session-state="ready"]').wait_for()
            page.locator('input[type="file"][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/ipad-screen-targets.ply'))
            page.locator('.loading-curtain').wait_for(state='hidden')
            topbar_action(page, name='加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70').click()
            page.wait_for_function("document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'")
            page.get_by_role('tab', name='示教', exact=True).click()
            page.get_by_role('button', name='打开全关节浮动窗口').click()
            for name, (lower, upper) in LIMITS.items():
                slider = page.get_by_role('slider', name=name + ' 关节滑块', exact=True)
                field = page.get_by_role('spinbutton', name=name + ' 关节值', exact=True)
                for control in [slider, field]:
                    assert abs(float(control.get_attribute('min')) - lower) < 1e-8
                    assert abs(float(control.get_attribute('max')) - upper) < 1e-8
                for raw, limit in [('-999', lower), ('999', upper)]:
                    field.fill(raw); field.press('Enter'); applied(name, limit)
                field.fill('0'); field.press('Enter')
            slider = page.get_by_role('slider', name='right_J2 关节滑块', exact=True)
            slider.focus(); slider.press('End')
            page.wait_for_timeout(200)
            assert abs(values()['right_J2'] - LIMITS['right_J2'][1]) < 0.101
            within_limits()
            page.get_by_role('button', name='全部关节归零', exact=True).click()
            print('PASS all 14 real URDF slider/numeric bounds and out-of-range input', flush=True)

            # Persist a legacy pose outside the new operating range in this
            # isolated browser only, then exercise restore and pose application.
            page.get_by_role('textbox', name='新关节姿态名称').fill('旧边界姿态')
            page.get_by_role('button', name='记录当前关节姿态', exact=True).click()
            page.wait_for_timeout(1500)
            page.route(BASE + '/soft-limit-storage', lambda route: route.fulfill(content_type='text/html', body=''))
            page.goto(BASE + '/soft-limit-storage')
            await_storage = '''async (mutate) => {
                const db = await new Promise((resolve, reject) => {
                    const request = indexedDB.open('atlas-route-studio', 1);
                    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
                });
                try {
                    return await new Promise((resolve, reject) => {
                        const tx = db.transaction('workspace-session', mutate ? 'readwrite' : 'readonly');
                        const store = tx.objectStore('workspace-session'), request = store.getAll(); let saved;
                        request.onsuccess = () => {
                            const record = request.result.find(r => r.config?.project?.virtualTeaching?.jointPoses?.some(p => p.name === '旧边界姿态'));
                            if (!record) { tx.abort(); return; }
                            const pose = record.config.project.virtualTeaching.jointPoses.find(p => p.name === '旧边界姿态');
                            if (mutate) {
                                Object.assign(pose.joints.values, {left_J2: 8, right_J4: -138});
                                Object.assign(record.config.project.robot.joints, {left_J2: 8, right_J4: -138});
                                store.put(record);
                            }
                            saved = pose.joints.values;
                        };
                        tx.oncomplete = () => resolve(saved); tx.onerror = tx.onabort = () => reject(tx.error || new Error('missing saved test pose'));
                    });
                } finally { db.close(); }
            }'''
            page.evaluate(await_storage, True)
            page.goto(BASE + '/workbench', wait_until='networkidle')
            page.wait_for_function("document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'")
            page.get_by_role('tab', name='示教', exact=True).click()
            page.get_by_role('button', name='打开全关节浮动窗口').click()
            applied('left_J2', LIMITS['left_J2'][1]); applied('right_J4', LIMITS['right_J4'][0])
            page.get_by_role('button', name='全部关节归零', exact=True).click()
            page.get_by_role('button', name='执行关节姿态 旧边界姿态', exact=True).click()
            applied('left_J2', LIMITS['left_J2'][1]); applied('right_J4', LIMITS['right_J4'][0])
            assert page.evaluate(await_storage, False)['left_J2'] == 8, 'saved source pose must remain intact'
            page.get_by_role('button', name='全部关节归零', exact=True).click()
            print('PASS legacy workspace/pose application clamps actual state and preserves the saved record', flush=True)

            page.get_by_role('button', name='最小化全关节浮动窗口', exact=True).click()
            viewer_tool(page, name='定位机器人模型', exact=True).click()
            canvas = page.locator('.three-canvas')
            double_click_tool(page, canvas, 'left')
            endpoint = page.get_by_role('spinbutton', name='末端 X (m)', exact=True)
            endpoint.fill('10'); endpoint.press('Enter')
            page.wait_for_function("document.querySelector('.three-canvas')?.dataset.endEffectorIkStatus === 'limited'")
            within_limits()
            page.get_by_role('button', name='退出机械臂末端控制', exact=True).click()
            page.get_by_role('button', name='展开全关节浮动窗口', exact=True).click()
            page.get_by_role('button', name='全部关节归零', exact=True).click()
            print('PASS unreachable end-effector IK stays within both arms\' soft limits', flush=True)

            topbar_action(page, name='iPad / iPhone', exact=True).click()
            with page.expect_response(lambda r: r.url.endswith('/ipad-screen/session') and r.request.method == 'POST') as created:
                page.get_by_role('menuitem', name='画面协作', exact=True).click()
            ticket = created.value.json()
            credential = page.request.post(BASE + '/__atlas/ipad-screen/pair', data={
                'code': ticket['pairingCode'], 'deviceId': 'limits-test-ipad', 'deviceName': 'Limits test iPad'}).json()
            (OUTPUT / 'peer.json').write_text(json.dumps({'base': BASE, 'ticket': ticket, 'credential': credential}))
            peer = subprocess.Popen(['node', '--input-type=module', '-e', PEER, str(OUTPUT)], cwd=ROOT)
            dialog = page.get_by_role('dialog', name='画面协作', exact=True)
            expect(dialog.get_by_text('正在共享双臂画面', exact=True)).to_be_visible()
            dialog.get_by_role('button', name='关闭画面协作窗口', exact=True).click()
            remote = wait(lambda s: len(s.get('joints', [])) == 24, 'shared joint definitions')
            for joint in remote['joints']:
                if joint['name'] in LIMITS:
                    assert abs(joint['lower'] - LIMITS[joint['name']][0]) < 1e-8
                    assert abs(joint['upper'] - LIMITS[joint['name']][1]) < 1e-8
            for seq, (name, raw, bound) in enumerate([('left_J2', 999, 1), ('right_J4', -999, 0)], 1):
                command = {'robotId': remote['robotId'], 'sequence': seq, 'name': name, 'value': raw}
                (OUTPUT / 'command.json').write_text(json.dumps({'page': 'joints', 'commands': [command], 'created': int(time.time() * 1000)}))
                current = wait(lambda s: s.get('ack') == seq, 'remote command acknowledgement')
                applied(name, LIMITS[name][bound])
                assert abs(next(j['value'] for j in current['joints'] if j['name'] == name) - LIMITS[name][bound]) < 1e-7
            within_limits()
            page.get_by_role('button', name='结束画面协作', exact=True).click()
            assert not errors, errors
            page.screenshot(path=str(OUTPUT / 'desktop-limits.png'))
            print('PASS iPad LAN receives soft ranges and clamps remote commands; no browser errors', flush=True)
        finally:
            browser.close()
            if peer: peer.terminate(); peer.wait(timeout=10)
            (OUTPUT / 'peer.json').unlink(missing_ok=True)


if __name__ == '__main__':
    run()
