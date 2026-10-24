"""Real mesh defects warn on approach/drawing without blocking virtual playback."""
import json
import os
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
from polyline_teaching_ui_smoke import project_point
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:22199')
ARTIFACTS = ROOT / 'test-artifacts/polyline-surface-warnings'


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROME_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
        page = browser.new_page(viewport={'width': 1680, 'height': 1100})
        page.set_default_timeout(30000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        descriptor = dict(id='polyline-test.urdf', relativePath='polyline-test.urdf', name='polyline_test_robot', fileName='polyline-test.urdf',
                          format='urdf', url='/__atlas/robot-files/polyline-test.urdf', packageName='', packagePath='', packageBaseUrl='/__atlas/robot-files/', manifestUrl=None)
        page.route('**/__atlas/robots', lambda route: route.fulfill(json={'robots': [descriptor]}))
        page.route('**/__atlas/robot-files/polyline-test.urdf', lambda route: route.fulfill(content_type='application/xml', body=(ROOT / 'tests/fixtures/polyline-robot.urdf').read_text()))
        try:
            page.goto(BASE + '/workbench', wait_until='networkidle')
            page.locator('[data-session-state=ready]').wait_for()
            page.locator('input[type=file][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/polyline-surface-wrinkles.ply'))
            page.locator('.loading-curtain').wait_for(state='hidden')
            topbar_action(page, name='加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 polyline_test_robot', exact=True).click()
            canvas = page.locator('.three-canvas')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            panel = page.get_by_role('region', name='表面折线示教', exact=True)
            initial_joints = canvas.get_attribute('data-robot-joint-values')
            for point in [[.46, .3, .55], [.53, .3, .55], [.53, .4, .55]]:
                xy = project_point(page, point)
                page.mouse.click(xy['x'], xy['y'])
            expect(panel).to_have_attribute('data-point-count', '3')
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            assert canvas.get_attribute('data-robot-joint-values') == initial_joints
            expect(panel).to_contain_text('检查通过 · 有表面警告')
            warnings = panel.get_by_role('list', name='表面警告列表', exact=True)
            expect(warnings).to_contain_text('到起点的移动')
            expect(warnings).to_contain_text('P0 → P1')
            expect(warnings).to_contain_text('直线穿过物体表面')
            assert int(panel.get_attribute('data-warning-count')) >= 2
            expect(panel.get_by_role('button', name='执行划线', exact=True)).to_be_enabled()
            page.screenshot(path=str(ARTIFACTS / 'warnings.png'), full_page=True)
            panel.get_by_role('button', name='执行划线', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'completed', timeout=60000)
            expect(warnings).to_be_visible()
            joints = json.loads(canvas.get_attribute('data-robot-joint-values'))
            assert abs(joints['left_J1'] - .13) < .002 and abs(joints['left_J2'] - .1) < .002, joints
            page.screenshot(path=str(ARTIFACTS / 'completed.png'), full_page=True)

            # A fresh, clear path must not inherit warnings from the previous run.
            panel.get_by_role('button', name='新建', exact=True).click()
            expect(panel).to_have_attribute('data-warning-count', '0')
            for point in [[.53, .4, .55], [.55, .4, .55]]:
                xy = project_point(page, point)
                page.mouse.click(xy['x'], xy['y'])
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            expect(panel).to_have_attribute('data-warning-count', '0')
            expect(warnings).to_have_count(0)
            assert not errors, errors
            print('Surface warning UI: real mesh crossings on approach/drawing, enabled execution, completed playback and warning reset passed.')
        except Exception:
            page.screenshot(path=str(ARTIFACTS / 'failure.png'), full_page=True)
            print('errors:', errors, flush=True)
            print('panel:', page.locator('.polyline-teaching').inner_text() if page.locator('.polyline-teaching').count() else page.locator('body').inner_text()[:1200], flush=True)
            raise
        finally:
            browser.close()


if __name__ == '__main__':
    run()
