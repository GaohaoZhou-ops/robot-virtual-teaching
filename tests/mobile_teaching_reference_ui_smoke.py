import copy
import json
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from ipad_teaching_source_ui_smoke import fixture_data, import_result, ready
from mobile_teaching_solver_ui_smoke import await_saved
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:21990')
CHROME = os.environ.get('CHROME_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
ARTIFACTS = ROOT / 'test-artifacts/mobile-teaching-reference'


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    _, archive = fixture_data()
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME)
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            page.set_default_timeout(30000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('**/__atlas/ipad/**', lambda route: route.fulfill(
                status=503, content_type='application/json', body='{"error":"文件导入测试"}'))
            page.goto(BASE + '/workbench', wait_until='networkidle')
            ready(page)
            page.locator('[data-independent-teaching-input]').set_input_files(str(ROOT / 'tests/fixtures/rotation-map.ply'))
            ready(page)
            topbar_action(page, '加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70', exact=True).click()
            canvas = page.locator('.three-canvas')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded', timeout=180000)
            page.wait_for_function("document.querySelector('.three-canvas')?.dataset.zividLeftOpticalPosition")
            live_values = json.loads(canvas.get_attribute('data-robot-joint-values'))
            base = {axis: canvas.get_attribute(f'data-robot-{axis}') for axis in ['x', 'y', 'z', 'yaw']}
            position = [float(n) for n in canvas.get_attribute('data-zivid-left-optical-position').split(',')]
            quaternion = [float(n) for n in canvas.get_attribute('data-zivid-left-optical-quaternion').split(',')]
            archive['result']['samples'] = archive['result']['samples'][:1]
            archive['result']['samples'][0]['cameraPose'].update(
                position=dict(zip('xyz', position)), quaternion=dict(zip('xyzw', quaternion)))
            original_capture = copy.deepcopy(archive['result'])
            import_result(page, archive)
            page.get_by_role('button', name='计算机器人姿态', exact=True).click()
            dialog = page.get_by_role('dialog', name='计算机器人姿态', exact=True)
            selector = dialog.get_by_role('combobox', name='参考起始姿态', exact=True)
            preference = dialog.get_by_role('combobox', name='参考姿态偏好', exact=True)
            support = dialog.get_by_role('combobox', name='地面支撑', exact=True)
            expect(selector).to_have_value('current')
            expect(preference).to_have_value('upper-body')
            expect(support).to_have_value('level')
            expect(support).to_be_enabled()
            expect(selector.locator('option')).to_have_count(1)
            expect(dialog).to_contain_text('暂无当前机器人的预设')
            dialog.get_by_role('button', name='关闭姿态计算').click()

            # Create real library presets without applying them to the scene.
            for name, head, idle_arm in [('参考准备姿态', 30, 15), ('备用参考姿态', -10, -15)]:
                topbar_action(page, '新建预设姿态', exact=True).click()
                preset_dialog = page.get_by_role('dialog', name='新建预设姿态', exact=True)
                preset_dialog.get_by_role('textbox', name='预设姿态名称').fill(name)
                preset_dialog.get_by_role('spinbutton', name='head_yaw_J 预设关节值', exact=True).fill(str(head))
                preset_dialog.get_by_role('spinbutton', name='right_J1 预设关节值', exact=True).fill(str(idle_arm))
                preset_dialog.get_by_role('button', name='保存姿态', exact=True).click()
                expect(preset_dialog).to_have_count(0)

            page.get_by_role('button', name='计算机器人姿态', exact=True).click()
            expect(selector).to_have_value('current')
            expect(selector.locator('option')).to_have_count(3)
            dialog.get_by_role('combobox', name='停车点策略').select_option('fixed')
            expect(support).to_be_disabled()
            expect(dialog).to_contain_text('固定停车点保持当前底盘的完整位姿')
            dialog.get_by_role('combobox', name='参与求解机械臂').select_option('left')
            dialog.get_by_role('checkbox', name='碰撞筛选').uncheck()
            dialog.get_by_role('checkbox', name='自动调节胸部高度').uncheck()
            dialog.get_by_role('checkbox', name='遵守当前关节锁定').uncheck()
            dialog.get_by_role('button', name='开始计算', exact=True).click()
            dock = page.get_by_role('region', name='设备姿态后台计算')
            expect(dock).to_have_attribute('data-compute-status', 'completed', timeout=120000)
            config = await_saved(page, lambda c: c['project']['virtualTeaching']['tasks'][0].get('mobileSolve'))
            report = config['project']['virtualTeaching']['tasks'][0]['mobileSolve']
            assert report['options']['referencePose'] == {'type': 'current'}
            assert report['options']['referencePreference'] == 'upper-body'
            assert report['options']['baseSupport'] == 'level'
            assert report['feasibleCount'] == 1
            assert report['rows'][0]['solutions']['left']['referenceDeviation']['meanAngleDegrees'] < 1e-5
            for name, value in live_values.items():
                assert abs(report['initialJointValues'][name] - value) < 1e-5
            dock.get_by_role('button', name='查看结果', exact=True).click()
            selector.select_option(label='参考准备姿态')
            selected_id = selector.input_value()
            expect(dialog.get_by_role('button', name='应用左臂解', exact=True)).to_be_disabled()
            expect(dialog).to_contain_text('配置已修改，请重新计算')
            dialog.locator('.mobile-solve-body').evaluate('(element) => { element.scrollTop = 0; }')
            page.screenshot(path=str(ARTIFACTS / 'reference-1440.png'), full_page=True)
            page.set_viewport_size({'width': 1280, 'height': 800})
            expect(selector).to_be_visible()
            assert dialog.evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')
            page.screenshot(path=str(ARTIFACTS / 'reference-1280.png'), full_page=True)
            dialog.get_by_role('button', name='重新计算', exact=True).click()
            expect(dock).to_have_attribute('data-compute-status', 'completed', timeout=120000)
            config = await_saved(page, lambda c: c['project']['virtualTeaching']['tasks'][0]
                                 .get('mobileSolve', {}).get('options', {}).get('referencePose', {}).get('type') == 'preset')
            source = config['project']['virtualTeaching']['tasks'][0]
            report = source['mobileSolve']
            assert source['mobileCapture'] == original_capture
            assert report['options']['referencePose']['id'] == selected_id
            assert report['options']['referencePose']['name'] == '参考准备姿态'
            assert report['feasibleCount'] == 1
            for name, value in {'head_yaw_J': 30, 'right_J1': 15}.items():
                assert abs(report['initialJointValues'][name] - value) < 1e-5
                assert abs(report['rows'][0]['solutions']['left']['jointValues'][name] - value) < 1e-5
            assert json.loads(canvas.get_attribute('data-robot-joint-values')) == live_values
            assert {axis: canvas.get_attribute(f'data-robot-{axis}') for axis in base} == base

            page.reload(wait_until='networkidle')
            ready(page)
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded', timeout=180000)
            page.get_by_role('button', name='计算机器人姿态', exact=True).click()
            expect(selector).to_have_value(selected_id)
            expect(preference).to_have_value('upper-body')
            expect(support).to_have_value('level')
            expect(dialog).to_contain_text('本报告参考起始姿态 · 参考准备姿态')
            expect(dialog).to_contain_text('上半身关节相对参考的平均角度偏差')
            expect(dialog.get_by_role('button', name='应用左臂解', exact=True)).to_be_enabled()
            selector.select_option('current')
            preference.select_option('whole-body')
            expect(dialog.get_by_role('button', name='应用左臂解', exact=True)).to_be_disabled()
            dialog.get_by_role('button', name='重新计算', exact=True).click()
            expect(dock).to_have_attribute('data-compute-status', 'completed', timeout=120000)
            config = await_saved(page, lambda c: c['project']['virtualTeaching']['tasks'][0]
                                 .get('mobileSolve', {}).get('options', {}).get('referencePose') == {'type': 'current'})
            assert abs(config['project']['virtualTeaching']['tasks'][0]['mobileSolve']['initialJointValues']['head_yaw_J']
                       - live_values['head_yaw_J']) < 1e-5
            assert config['project']['virtualTeaching']['tasks'][0]['mobileSolve']['options']['referencePreference'] == 'whole-body'
            assert not errors, errors
            print('Reference posture UI: preset library, current pose, worker seeds, unchanged live/source data, report invalidation and reload persistence passed.')
        finally:
            browser.close()


if __name__ == '__main__':
    run()
