"""Temporary waist planning permission preserves global locks across mode changes."""
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from archive_helpers import start_project_download, read_exported_project
from polyline_teaching_ui_smoke import BASE, project_point
from polyline_base_ui_smoke import base_pose
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test-artifacts/polyline-waist'


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    urdf = (ROOT / 'tests/fixtures/polyline-robot.urdf').read_text()
    urdf = urdf.replace('<parent link="base_link"/>', '<parent link="waist_L"/>')
    urdf = urdf.replace('lower="-1" upper="1"', 'lower="-0.12" upper="0.12"')
    urdf = urdf.replace('</robot>', '''<link name="waist_L"/>
      <joint name="waist_lift_J" type="prismatic"><parent link="base_link"/><child link="waist_L"/>
      <axis xyz="0 0 1"/><limit lower="-0.25" upper="0.25" effort="10" velocity="0.1"/></joint></robot>''')
    surface = '''ply
format ascii 1.0
element vertex 5
property float x
property float y
property float z
element face 2
property list uchar int vertex_indices
end_header
0.5 0.1 0.5
0.5 0.6 0.5
0.5 0.6 1.1
0.5 0.1 1.1
0 0 0
3 0 1 2
3 0 2 3
'''
    descriptor = dict(id='polyline-test.urdf', relativePath='polyline-test.urdf', name='polyline_test_robot', fileName='polyline-test.urdf',
                      format='urdf', url='/__atlas/robot-files/polyline-test.urdf', packageName='', packagePath='', packageBaseUrl='/__atlas/robot-files/', manifestUrl=None)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        page = browser.new_page(viewport={'width': 1680, 'height': 1100})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('**/__atlas/robots', lambda route: route.fulfill(json={'robots': [descriptor]}))
        page.route('**/__atlas/robot-files/polyline-test.urdf', lambda route: route.fulfill(content_type='application/xml', body=urdf))
        try:
            page.goto(BASE + '/workbench', wait_until='networkidle')
            page.locator('[data-session-state=ready]').wait_for()
            page.locator('input[type=file][accept=".ply"]').set_input_files({'name': 'waist-surface.ply', 'mimeType': 'application/octet-stream', 'buffer': surface.encode()})
            page.locator('.loading-curtain').wait_for(state='hidden')
            topbar_action(page, name='加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 polyline_test_robot', exact=True).click()
            canvas = page.locator('.three-canvas')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
            initial_locks = '["waist_lift_J"]'
            expect(canvas).to_have_attribute('data-robot-joint-locked-names', initial_locks)
            # Hide the robot while authoring on the vertical surface directly
            # beside it; model visibility does not alter collision checking.
            page.get_by_role('button', name='显示设置', exact=True).click()
            display = page.get_by_role('dialog', name='3D 显示设置', exact=True)
            display.get_by_role('switch', name='显示机器人模型', exact=True).click()
            display.get_by_role('button', name='关闭显示设置', exact=True).click()
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            panel = page.get_by_role('region', name='表面折线示教', exact=True)
            waist = panel.get_by_role('checkbox', name='协同', exact=True)
            maximum = panel.get_by_role('checkbox', name='最大保障', exact=True)
            expect(waist).not_to_be_checked()
            maximum.check()
            panel.locator('summary').filter(has_text='虚拟笔尖偏移').click()
            offset = panel.get_by_role('spinbutton', name='笔尖偏移 X mm', exact=True)
            offset.fill('100'); offset.press('Enter')
            panel.locator('summary').filter(has_text='虚拟笔尖偏移').click()
            for point in [[.5, .32, .55], [.5, .32, .86]]:
                xy = project_point(page, point); page.mouse.click(xy['x'], xy['y'])
            expect(panel).to_have_attribute('data-point-count', '2')
            initial_joints, initial_base = json.loads(canvas.get_attribute('data-robot-joint-values')), base_pose(canvas)
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-plan-partial', 'true', timeout=60000)
            first_distance = float(panel.get_attribute('data-planned-distance'))
            assert first_distance < .125
            waist.check()
            expect(panel.get_by_role('button', name='解锁腰部关节', exact=True)).to_have_count(0)
            expect(panel).to_contain_text('全局关节锁定保持不变')
            expect(canvas).to_have_attribute('data-robot-joint-locked-names', initial_locks)
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            expect(panel).to_have_attribute('data-plan-partial', 'false')
            assert float(panel.get_attribute('data-planned-distance')) > .3
            expect(canvas).to_have_attribute('data-robot-joint-locked-names', initial_locks)
            # Disabling assistance restores arm-only planning immediately.
            waist.uncheck()
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-plan-partial', 'true', timeout=60000)
            assert abs(float(panel.get_attribute('data-planned-distance')) - first_distance) < 1e-8
            waist.check()
            # Mode switches retain the preference, but it only applies to a fixed base.
            for mode in ['移动', '自搜索']:
                panel.get_by_role('checkbox', name=mode, exact=True).check()
                expect(waist).to_be_disabled(); expect(waist).to_be_checked()
                panel.get_by_role('checkbox', name='静止', exact=True).check()
                expect(waist).to_be_enabled()
                expect(canvas).to_have_attribute('data-robot-joint-locked-names', initial_locks)

            # The external control panel keeps the original locked state on
            # exit. If the user changes it outside teaching, preserve that new
            # state too: no stale snapshot may relock it on the next exit.
            page.get_by_role('button', name='图谱控制台', exact=True).click()
            expect(canvas).to_have_attribute('data-robot-joint-locked-names', initial_locks)
            page.get_by_role('button', name='打开全关节浮动窗口', exact=True).click()
            locked = page.get_by_role('button', name='解除 waist_lift_J 关节', exact=True)
            expect(locked).to_have_attribute('aria-pressed', 'true')
            locked.click()
            expect(canvas).to_have_attribute('data-robot-joint-locked-names', '[]')
            page.get_by_role('button', name='隐藏全关节浮动窗口', exact=True).click()
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            expect(waist).to_be_checked()
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            page.get_by_role('button', name='图谱控制台', exact=True).click()
            expect(canvas).to_have_attribute('data-robot-joint-locked-names', '[]')
            page.get_by_role('button', name='打开全关节浮动窗口', exact=True).click()
            unlocked = page.get_by_role('button', name='锁定 waist_lift_J 关节', exact=True)
            expect(unlocked).to_have_attribute('aria-pressed', 'false')
            unlocked.click()
            expect(canvas).to_have_attribute('data-robot-joint-locked-names', initial_locks)
            page.get_by_role('button', name='隐藏全关节浮动窗口', exact=True).click()
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            expect(panel).to_have_attribute('data-plan-partial', 'false')
            assert float(panel.get_attribute('data-planned-distance')) > .3
            page.get_by_role('button', name='显示设置', exact=True).click()
            display.get_by_role('switch', name='显示机器人模型', exact=True).click()
            display.get_by_role('button', name='关闭显示设置', exact=True).click()
            panel.get_by_role('button', name='执行划线', exact=True).click()
            expect(waist).to_be_disabled()
            expect(canvas).to_have_attribute('data-robot-joint-locked-names', initial_locks)
            expect(panel).to_have_attribute('data-status', 'completed', timeout=60000)
            joints = json.loads(canvas.get_attribute('data-robot-joint-values'))
            assert joints['waist_lift_J'] > .18, joints
            assert joints['right_J1'] == initial_joints['right_J1']
            assert base_pose(canvas) == initial_base
            expect(canvas).to_have_attribute('data-robot-joint-locked-names', initial_locks)
            page.screenshot(path=str(ARTIFACTS / 'completed.png'), full_page=True)
            panel.get_by_role('button', name='保存', exact=True).click()
            expect(panel).to_contain_text('已保存至当前示教任务')
            page.get_by_role('button', name='图谱控制台', exact=True).click()
            expect(canvas).to_have_attribute('data-robot-joint-locked-names', initial_locks)
            with page.expect_download() as download:
                start_project_download(page)
            saved = read_exported_project(download.value)['virtualTeaching']['tasks'][0]['polylines'][0]
            assert saved['base']['waistAssist'] is True and saved['base']['allowPartial'] is True
            assert not saved['base']['sync'] and not saved['base']['search']
            page.reload(wait_until='networkidle')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
            expect(canvas).to_have_attribute('data-robot-joint-locked-names', initial_locks)
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            panel.locator('summary').filter(has_text='已保存折线').click()
            panel.locator('.polyline-teaching__library button').filter(has_text='表面折线').click()
            expect(waist).to_be_checked(); expect(maximum).to_be_checked()
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            expect(panel).to_have_attribute('data-plan-partial', 'false')
            expect(canvas).to_have_attribute('data-robot-joint-locked-names', initial_locks)
            assert not errors, errors
            print('Polyline waist UI: automatic temporary permission, unchanged external locks in both states, mode changes, full vs partial planning, execution and project restoration passed.')
        except Exception:
            page.screenshot(path=str(ARTIFACTS / 'failure.png'), full_page=True)
            (ARTIFACTS / 'failure.json').write_text(json.dumps({'errors': errors, 'text': page.locator('body').inner_text()}, ensure_ascii=False, indent=2))
            raise
        finally:
            browser.close()


if __name__ == '__main__':
    run()
