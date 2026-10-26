"""Perpendicular tool checkbox, actual worker motion and saved preferences."""
import json
import math
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from archive_helpers import read_exported_project, start_project_download
from polyline_teaching_ui_smoke import BASE, project_point
from polyline_orientation_ui_smoke import set_orientation, observe_motion
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test-artifacts/polyline-perpendicular'


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    surface = ARTIFACTS / 'bent-surface.ply'
    vertices = [(x, y, z) for y in [.1, .6] for x, z in [(.2, .52), (.45, .6), (.7, .55)]]
    surface.write_text('ply\nformat ascii 1.0\nelement vertex 7\nproperty float x\nproperty float y\nproperty float z\n'
                       'element face 4\nproperty list uchar int vertex_indices\nend_header\n'
                       + ''.join(f'{x} {y} {z}\n' for x, y, z in vertices) + '0 0 0\n'
                       + '3 0 1 4\n3 0 4 3\n3 1 2 5\n3 1 5 4\n')
    urdf = (ROOT / 'tests/fixtures/polyline-robot.urdf').read_text().replace(
        '<joint name="left_tool_fixed" type="fixed"><parent link="left_L3"/><child link="tool_left"/><origin xyz="0 0 -0.1"/></joint>',
        '<joint name="left_J4" type="revolute"><parent link="left_L3"/><child link="tool_left"/><origin xyz="0 0 -0.1"/>'
        '<axis xyz="0 1 0"/><limit lower="-1.5" upper="1.5" effort="10" velocity="1"/></joint>')
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        page = browser.new_page(viewport={'width': 1680, 'height': 1100}, accept_downloads=True)
        page.set_default_timeout(30000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        descriptor = dict(id='polyline-test.urdf', relativePath='polyline-test.urdf', name='polyline_test_robot', fileName='polyline-test.urdf',
                          format='urdf', url='/__atlas/robot-files/polyline-test.urdf', packageName='', packagePath='', packageBaseUrl='/__atlas/robot-files/', manifestUrl=None)
        page.route('**/__atlas/robots', lambda route: route.fulfill(json={'robots': [descriptor]}))
        page.route('**/__atlas/robot-files/polyline-test.urdf', lambda route: route.fulfill(content_type='application/xml', body=urdf))
        try:
            page.goto(BASE + '/workbench', wait_until='networkidle')
            page.locator('[data-session-state=ready]').wait_for()
            page.locator('input[type=file][accept=".ply"]').set_input_files(str(surface))
            page.locator('.loading-curtain').wait_for(state='hidden')
            topbar_action(page, name='加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 polyline_test_robot', exact=True).click()
            canvas = page.locator('.three-canvas')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
            set_orientation(page, 25)
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            panel = page.get_by_role('region', name='表面折线示教', exact=True)
            completion = panel.get_by_role('group', name='完成度', exact=True)
            checkbox = completion.get_by_role('checkbox', name='垂直法向量', exact=True)
            expect(checkbox).not_to_be_checked()
            checkbox.check()
            # The three controls retain one row at the standard sidebar width.
            tops = completion.locator('label').evaluate_all('(labels) => labels.map(n => n.getBoundingClientRect().top)')
            assert max(tops) - min(tops) < 2, tops
            panel.get_by_role('button', name='查看算法约束说明', exact=True).click()
            help_dialog = page.get_by_role('dialog', name='算法约束与参数说明', exact=True)
            expect(help_dialog).to_contain_text('完成度：垂直法向量')
            expect(help_dialog).to_contain_text('成 90°')
            help_dialog.get_by_role('button', name='关闭算法约束说明', exact=True).click()
            panel.get_by_role('group', name='路径类型', exact=True).get_by_role('button', name='空间曲线', exact=True).click()
            for point in [[.3, .3, .552], [.45, .3, .6], [.6, .3, .57]]:
                xy = project_point(page, point); page.mouse.click(xy['x'], xy['y'])
            expect(panel).to_have_attribute('data-point-count', '3')
            before = canvas.get_attribute('data-robot-joint-values')
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(checkbox).to_be_disabled()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            assert canvas.get_attribute('data-robot-joint-values') == before
            page.screenshot(path=str(ARTIFACTS / 'perpendicular-ready.png'), full_page=True)
            observe_motion(page)
            panel.get_by_role('button', name='执行划线', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'completed', timeout=120000)
            samples = page.evaluate('() => { window.orientationObserver.disconnect(); return window.orientationSamples; }')
            angles = [s['left_J4'] for s in samples]
            assert len(angles) > 20 and min(angles) < -10 and max(angles) > 10, (len(angles), min(angles), max(angles))
            # The final XZ tangent has dz/dx=-0.2, so the perpendicular tool
            # Z direction is obtained by rotating about Y by atan(0.2).
            joints = json.loads(canvas.get_attribute('data-robot-joint-values'))
            assert abs(joints['left_J4'] - math.degrees(math.atan(.2))) < .6, joints
            expect(panel.get_by_label('已划线比例', exact=True).locator('b')).to_have_text('100.0%')
            panel.get_by_role('textbox', name='折线名称', exact=True).fill('垂直曲线测试')
            panel.get_by_role('button', name='保存', exact=True).click()
            expect(panel).to_contain_text('已保存至当前示教任务')
            page.get_by_role('button', name='图谱控制台', exact=True).click()
            with page.expect_download() as download:
                start_project_download(page)
            saved = next(path for task in read_exported_project(download.value)['virtualTeaching']['tasks']
                         for path in task.get('polylines', []) if path['name'] == '垂直曲线测试')
            assert saved['settings']['perpendicularTool'] is True
            page.reload(wait_until='networkidle')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
            page.get_by_role('button', name='查看折线 垂直曲线测试', exact=True).click()
            expect(checkbox).to_be_checked()
            panel.get_by_role('button', name='新建', exact=True).click()
            expect(checkbox).to_be_checked()
            checkbox.uncheck()
            page.get_by_role('button', name='图谱控制台', exact=True).click()
            page.reload(wait_until='networkidle')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            expect(checkbox).not_to_be_checked()
            page.set_viewport_size({'width': 1100, 'height': 780})
            page.screenshot(path=str(ARTIFACTS / 'perpendicular-compact.png'), full_page=True)
            assert not errors, errors
            print('PASS perpendicular UI: checkbox/help, actual worker rotation on a 3D curve, preserved live pose during checking, complete playback, ZIP/reload and remembered toggle.', flush=True)
        except Exception:
            page.screenshot(path=str(ARTIFACTS / 'failure.png'), full_page=True)
            print('page errors:', errors, flush=True)
            if page.locator('.polyline-teaching').count():
                print(page.locator('.polyline-teaching').inner_text(), flush=True)
            raise
        finally:
            browser.close()


if __name__ == '__main__':
    run()
