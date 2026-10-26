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
CUSTOM_LIMITS = {}
for node in ET.parse(ROOT / 'robots/botx_abx_zivid_m70/urdf/botx_abx_zivid_m70.urdf').findall('joint'):
    if node.get('name').startswith(('left_J', 'right_J')):
        hard = [math.degrees(float(node.find('limit').get(key))) for key in ['lower', 'upper']]
        margin = (hard[1] - hard[0]) * 0.025
        LIMITS[node.get('name')] = [hard[0] + margin, hard[1] - margin]
        margin = (hard[1] - hard[0]) * 0.1
        CUSTOM_LIMITS[node.get('name')] = [hard[0] + margin, hard[1] - margin]


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

            # Tightening a configured range must update the loaded model, its
            # controls and persistence without another URDF/mesh request.
            field = page.get_by_role('spinbutton', name='right_J2 关节值', exact=True)
            field.fill('999'); field.press('Enter'); applied('right_J2', LIMITS['right_J2'][1])
            requests = []
            page.on('request', lambda request: requests.append(request.url) if '/__atlas/robot-files/' in request.url else None)
            robot_menu = page.locator('[data-workbench-menu-trigger="robot"]')
            robot_menu.click()
            percent = page.get_by_role('spinbutton', name='关节软限位百分比', exact=True)
            ratio_slider = page.get_by_role('slider', name='关节软限位比例滑块', exact=True)
            expect(percent).to_have_value('95')
            percent.fill('80'); percent.press('Enter')
            applied('right_J2', CUSTOM_LIMITS['right_J2'][1])
            right_slider = page.get_by_role('slider', name='right_J2 关节滑块', exact=True)
            assert abs(float(right_slider.get_attribute('min')) - CUSTOM_LIMITS['right_J2'][0]) < 1e-7
            assert abs(float(right_slider.get_attribute('max')) - CUSTOM_LIMITS['right_J2'][1]) < 1e-7
            expect(robot_menu).to_have_attribute('aria-expanded', 'true')
            ratio_slider.focus(); ratio_slider.press('ArrowRight')
            expect(percent).to_have_value('81')
            expect(robot_menu).to_have_attribute('aria-expanded', 'true')
            ratio_slider.press('Tab'); expect(percent).to_be_focused()
            percent.fill(''); percent.press('Enter'); expect(percent).to_have_value('81')
            for raw, bounded in [('200', '100'), ('-10', '1')]:
                percent.fill(raw); percent.press('Enter'); expect(percent).to_have_value(bounded)
            percent.fill('80'); percent.press('Tab')
            expect(robot_menu).to_have_attribute('aria-expanded', 'false')
            robot_menu.click()
            expect(ratio_slider).to_have_value('80')
            assert not requests, requests
            page.screenshot(path=str(OUTPUT / 'adjustable-limits-menu.png'))
            saved = False
            expected_joint = values()['right_J2']
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                saved = page.evaluate('''async (expected) => {
                const db = await new Promise(resolve => {
                    const request = indexedDB.open('atlas-route-studio', 1);
                    request.onsuccess = () => resolve(request.result);
                });
                try { return await new Promise(resolve => {
                    const transaction = db.transaction('workspace-session');
                    const request = transaction.objectStore('workspace-session').get('workspace-config:map');
                    transaction.oncomplete = () => resolve(request.result?.config?.project?.robot?.armSoftLimitRatio === 0.8
                        && Math.abs(request.result.config.project.robot.joints.right_J2 - expected) < 1e-7);
                }); } finally { db.close(); }
                }''', expected_joint)
                if saved: break
                page.wait_for_timeout(100)
            assert saved, 'custom ratio and current pose must finish saving before reload'
            page.reload(wait_until='networkidle')
            page.wait_for_function("document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'")
            robot_menu.click(); expect(percent).to_have_value('80')
            page.get_by_role('button', name='恢复默认软限位', exact=True).click()
            expect(percent).to_have_value('95')
            expect(robot_menu).to_have_attribute('aria-expanded', 'true')
            percent.press('Escape')
            expect(robot_menu).to_have_attribute('aria-expanded', 'false')
            page.get_by_role('tab', name='示教', exact=True).click()
            page.get_by_role('button', name='打开全关节浮动窗口').click()
            print('PASS adjustable ratio, live clamping without reload, keyboard editing, bounds, reset and workspace restore', flush=True)

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
            robot_menu.click()
            percent.fill('80'); percent.press('Enter')
            percent.press('Escape')
            remote = wait(lambda s: abs(next((j['upper'] for j in s.get('joints', []) if j['name'] == 'right_J2'), 0)
                - CUSTOM_LIMITS['right_J2'][1]) < 1e-7, 'updated custom limits shared with iPad')
            for joint in remote['joints']:
                if joint['name'] in CUSTOM_LIMITS:
                    lower, upper = CUSTOM_LIMITS[joint['name']]
                    assert abs(joint['lower'] - lower) < 1e-8
                    assert abs(joint['upper'] - upper) < 1e-8
            command = {'robotId': remote['robotId'], 'sequence': 3, 'name': 'right_J2', 'value': 999}
            (OUTPUT / 'command.json').write_text(json.dumps({'page': 'joints', 'commands': [command], 'created': int(time.time() * 1000)}))
            wait(lambda s: s.get('ack') == 3, 'custom-limit remote acknowledgement')
            applied('right_J2', CUSTOM_LIMITS['right_J2'][1])
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
