"""Per-edge start ghosts for full/partial/stopped/mobile drawing runs."""
import json
import math
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from polyline_teaching_ui_smoke import BASE, project_point, camera_state
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test-artifacts/polyline-segment-ghost'


def set_model_visibility(page, visible):
    page.get_by_role('button', name='显示设置', exact=True).click()
    display = page.get_by_role('dialog', name='3D 显示设置', exact=True)
    toggle = display.get_by_role('switch', name='显示机器人模型', exact=True)
    if (toggle.get_attribute('aria-checked') == 'true') != visible:
        toggle.click()
    display.get_by_role('button', name='关闭显示设置', exact=True).click()


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        for mode in ['full', 'partial', 'stopped', 'mobile']:
            page = browser.new_page(viewport={'width': 1680, 'height': 1100})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            descriptor = dict(id='polyline-test.urdf', relativePath='polyline-test.urdf', name='polyline_test_robot', fileName='polyline-test.urdf',
                              format='urdf', url='/__atlas/robot-files/polyline-test.urdf', packageName='', packagePath='', packageBaseUrl='/__atlas/robot-files/', manifestUrl=None)
            urdf = (ROOT / 'tests/fixtures/polyline-robot.urdf').read_text()
            if mode in ['partial', 'mobile']:
                limit = '0.12' if mode == 'partial' else '0.03'
                urdf = urdf.replace('lower="-1" upper="1"', f'lower="-1" upper="{limit}"', 1)
            page.route('**/__atlas/robots', lambda route: route.fulfill(json={'robots': [descriptor]}))
            page.route('**/__atlas/robot-files/polyline-test.urdf', lambda route: route.fulfill(content_type='application/xml', body=urdf))
            try:
                page.goto(BASE + '/workbench', wait_until='networkidle')
                page.locator('[data-session-state=ready]').wait_for()
                page.locator('input[type=file][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/polyline-surface.ply'))
                page.locator('.loading-curtain').wait_for(state='hidden')
                topbar_action(page, name='加载机器人', exact=True).click()
                page.get_by_role('option', name='加载机器人 polyline_test_robot', exact=True).click()
                canvas = page.locator('.three-canvas')
                expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
                set_model_visibility(page, False)
                page.get_by_role('button', name='表面折线示教', exact=True).click()
                panel = page.get_by_role('region', name='表面折线示教', exact=True)
                distance = panel.get_by_role('spinbutton', name='末端距线段 mm', exact=True)
                distance.fill('250'); distance.press('Tab')
                if mode == 'partial':
                    panel.get_by_role('checkbox', name='最大保障', exact=True).check()
                if mode == 'mobile':
                    panel.get_by_role('checkbox', name='移动', exact=True).check()
                    yaw = panel.get_by_role('spinbutton', name='底盘转向范围 °', exact=True)
                    yaw.fill('0'); yaw.press('Tab')
                vertices = [[.4, .3, .55], [.46, .3, .55], [.6, .3, .55], [.6, .4, .55]]
                for vertex in vertices:
                    point = project_point(page, vertex); page.mouse.click(point['x'], point['y'])
                expect(panel).to_have_attribute('data-point-count', '4')
                set_model_visibility(page, True)
                panel.get_by_role('button', name='检查路径', exact=True).click()
                expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
                expect(canvas).to_have_attribute('data-polyline-execution-ghost-count', '0')
                camera = camera_state(canvas)
                execute = panel.get_by_role('button', name='执行可达部分' if mode == 'partial' else '执行划线', exact=True)
                execute.click()
                page.wait_for_function('Number(document.querySelector(".polyline-teaching").dataset.toolTravelMm) > 5')
                panel.get_by_role('button', name='暂停', exact=True).click()
                expect(canvas).to_have_attribute('data-polyline-execution-ghost-count', '0')
                panel.get_by_role('button', name='继续', exact=True).click()
                expect(canvas).to_have_attribute('data-polyline-execution-ghost-count', '1', timeout=30000)
                panel.get_by_role('button', name='暂停', exact=True).click()
                expect(canvas).to_have_attribute('data-polyline-execution-ghost-state', 'visible')
                first = json.loads(canvas.get_attribute('data-polyline-execution-ghosts'))[0]
                assert first['segmentIndex'] == 0 and math.dist(first['target'], vertices[0]) < .001
                assert int(canvas.get_attribute('data-polyline-execution-ghost-mesh-count')) > 0
                assert camera_state(canvas) == camera, 'adding ghosts must not refocus the camera'
                if mode == 'stopped':
                    panel.get_by_role('button', name='继续', exact=True).click()
                    page.wait_for_function('Number(document.querySelector(".three-canvas").dataset.polylineCompletedMm) > 85')
                    panel.get_by_role('button', name='暂停', exact=True).click()
                    expect(canvas).to_have_attribute('data-polyline-execution-ghost-count', '1')
                    panel.get_by_role('button', name='停止折线任务', exact=True).click()
                else:
                    panel.get_by_role('button', name='继续', exact=True).click()
                    expect(panel).to_have_attribute('data-status', 'completed', timeout=60000)
                expected_count = 2 if mode in ['partial', 'stopped'] else 3
                expect(canvas).to_have_attribute('data-polyline-execution-ghost-count', str(expected_count))
                snapshots = json.loads(canvas.get_attribute('data-polyline-execution-ghosts'))
                assert snapshots[0] == first, 'earlier segment ghosts remain frozen'
                for index, ghost in enumerate(snapshots):
                    assert ghost['segmentIndex'] == index
                    base, joints = ghost['basePose']['position'], ghost['joints']
                    tcp = [base[0] + .4 + joints['left_J1'], base[1] + .3 + joints['left_J2'], base[2] + .7 + joints['left_J3'] - .25]
                    assert math.dist(tcp, vertices[index]) < .0011, (mode, index, tcp)
                    assert joints['right_J1'] == 0
                if mode == 'mobile':
                    assert snapshots[-1]['basePose']['position'][0] > snapshots[0]['basePose']['position'][0] + .1
                page.screenshot(path=str(ARTIFACTS / f'{mode}.png'), full_page=True)
                set_model_visibility(page, False)
                expect(canvas).to_have_attribute('data-polyline-execution-ghost-state', 'hidden')
                expect(canvas).to_have_attribute('data-polyline-execution-ghost-count', str(expected_count))
                set_model_visibility(page, True)
                expect(canvas).to_have_attribute('data-polyline-execution-ghost-state', 'visible')
                assert json.loads(canvas.get_attribute('data-polyline-execution-ghosts')) == snapshots
                if mode == 'full':
                    execute.click()
                    panel.get_by_role('button', name='暂停', exact=True).click()
                    expect(canvas).to_have_attribute('data-polyline-execution-ghost-count', '0')
                    panel.get_by_role('button', name='停止折线任务', exact=True).click()
                    expect(canvas).to_have_attribute('data-polyline-execution-ghost-count', '0')
                else:
                    panel.get_by_role('button', name='检查路径', exact=True).click()
                    expect(canvas).to_have_attribute('data-polyline-execution-ghost-count', '0')
                    expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
                page.get_by_role('button', name='图谱控制台', exact=True).click()
                expect(canvas).to_have_attribute('data-polyline-execution-ghost-state', 'hidden')
                assert not errors, errors
                print(f'Segment ghosts ({mode}): exact starts, frozen history, interruption/partial endpoints, base poses, no refocus, visibility and reset passed.', flush=True)
            except Exception:
                page.screenshot(path=str(ARTIFACTS / f'failure-{mode}.png'), full_page=True)
                print(panel.inner_text() if page.locator('.polyline-teaching').count() else errors)
                raise
            finally:
                page.close()
        browser.close()


if __name__ == '__main__':
    run()
