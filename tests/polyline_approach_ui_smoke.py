"""Worker recovery, approach preview, fixed-base playback and drawing progress."""
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from polyline_teaching_ui_smoke import BASE, project_point
from polyline_base_ui_smoke import base_pose
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test-artifacts/polyline-approach'


def surface():
    # Drawing plane below the wrist, plus a wall crossing only the approach.
    vertices = [[.82, .2, .551], [1, .2, .551], [1, .45, .551], [.82, .45, .551], [0, 0, 0]]
    faces = [[0, 1, 2], [0, 2, 3]]
    start = len(vertices)
    vertices += [[x, y, z] for z in [.7, 1.0] for y in [.15, .45] for x in [.69, .71]]
    for quad in [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]:
        faces += [[start + quad[i] for i in tri] for tri in [[0, 1, 2], [0, 2, 3]]]
    return (f'ply\nformat ascii 1.0\nelement vertex {len(vertices)}\nproperty float x\nproperty float y\nproperty float z\n'
            f'element face {len(faces)}\nproperty list uchar int vertex_indices\nend_header\n'
            + '\n'.join(' '.join(map(str, point)) for point in vertices) + '\n'
            + '\n'.join('3 ' + ' '.join(map(str, face)) for face in faces) + '\n')


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    descriptor = dict(id='polyline-test.urdf', relativePath='polyline-test.urdf', name='polyline_test_robot', fileName='polyline-test.urdf',
                      format='urdf', url='/__atlas/robot-files/polyline-test.urdf', packageName='', packagePath='', packageBaseUrl='/__atlas/robot-files/', manifestUrl=None)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        page = browser.new_page(viewport={'width': 1680, 'height': 1100})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('**/__atlas/robots', lambda route: route.fulfill(json={'robots': [descriptor]}))
        page.route('**/__atlas/robot-files/polyline-test.urdf', lambda route: route.fulfill(content_type='application/xml', body=(ROOT / 'tests/fixtures/polyline-robot.urdf').read_text()))
        try:
            page.goto(BASE + '/workbench', wait_until='networkidle')
            page.locator('[data-session-state=ready]').wait_for()
            page.locator('input[type=file][accept=".ply"]').set_input_files({'name': 'approach-wall.ply', 'mimeType': 'application/octet-stream', 'buffer': surface().encode()})
            page.locator('.loading-curtain').wait_for(state='hidden')
            topbar_action(page, name='加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 polyline_test_robot', exact=True).click()
            canvas = page.locator('.three-canvas')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
            initial_base = base_pose(canvas)
            initial_joints = json.loads(canvas.get_attribute('data-robot-joint-values'))
            page.get_by_role('button', name='显示设置', exact=True).click()
            display = page.get_by_role('dialog', name='3D 显示设置', exact=True)
            display.get_by_role('switch', name='显示机器人模型', exact=True).click()
            display.get_by_role('button', name='关闭显示设置', exact=True).click()
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            panel = page.get_by_role('region', name='表面折线示教', exact=True)
            for point in [[.9, .27, .551], [.9, .35, .551]]:
                target = project_point(page, point)
                page.mouse.click(target['x'], target['y'])
            expect(panel).to_have_attribute('data-point-count', '2')
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            expect(panel).to_have_attribute('data-approach-mode', 'detour')
            expect(panel).to_contain_text('已规划绕行到 P0')
            assert abs(float(panel.get_attribute('data-planned-distance')) - .08) < .001
            expect(canvas).to_have_attribute('data-polyline-approach-visible', 'true')
            assert json.loads(canvas.get_attribute('data-robot-joint-values')) == initial_joints
            assert base_pose(canvas) == initial_base
            preview = panel.get_by_role('checkbox', name='显示笔尖路径预览', exact=True)
            preview.uncheck()
            expect(canvas).to_have_attribute('data-polyline-approach-visible', 'false')
            preview.check()
            expect(canvas).to_have_attribute('data-polyline-approach-visible', 'true')
            page.screenshot(path=str(ARTIFACTS / 'detour-preview.png'), full_page=True)
            page.get_by_role('button', name='显示设置', exact=True).click()
            display.get_by_role('switch', name='显示机器人模型', exact=True).click()
            display.get_by_role('button', name='关闭显示设置', exact=True).click()
            panel.get_by_role('button', name='执行划线', exact=True).click()
            page.wait_for_function('Number(document.querySelector(".polyline-teaching").dataset.toolTravelMm) > 10')
            assert float(canvas.get_attribute('data-polyline-completed-mm')) == 0, 'detour cannot count as drawn distance'
            expect(panel).to_have_attribute('data-status', 'completed', timeout=60000)
            assert abs(float(canvas.get_attribute('data-polyline-completed-mm')) - .08 * 1000) < 1
            assert base_pose(canvas) == initial_base
            assert json.loads(canvas.get_attribute('data-robot-joint-values'))['right_J1'] == initial_joints['right_J1']
            page.get_by_role('button', name='图谱控制台', exact=True).click()
            assert canvas.get_attribute('data-polyline-approach-visible') is None
            assert not errors, errors
        except Exception:
            page.screenshot(path=str(ARTIFACTS / 'failure.png'), full_page=True)
            print(page.locator('.polyline-teaching').inner_text() if page.locator('.polyline-teaching').count() else errors)
            raise
        finally:
            browser.close()
    print('Polyline approach UI: automatic worker detour, preview toggle/close, original stroke, continuous fixed-base playback and approach excluded from completed drawing passed.')


if __name__ == '__main__':
    run()
