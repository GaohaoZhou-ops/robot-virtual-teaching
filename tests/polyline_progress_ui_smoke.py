"""Check actual rendered pixels within one edge, including surface warnings.

Run with: uv run --with playwright --with pillow python tests/polyline_progress_ui_smoke.py
"""
from io import BytesIO
from pathlib import Path
from PIL import Image
from playwright.sync_api import expect, sync_playwright
from polyline_teaching_ui_smoke import BASE, project_point
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test-artifacts/polyline-progress'


def assert_pixels(page, name, expected):
    image = Image.open(BytesIO(page.screenshot(path=str(ARTIFACTS / f'{name}.png')))).convert('RGB')
    for world_x, color in expected:
        screen = project_point(page, [world_x, .3, .55])
        x, y = round(screen['x']), round(screen['y'])
        pixels = [image.getpixel((x + dx, y + dy)) for dx in range(-2, 3) for dy in range(-2, 3)]
        cyan = lambda rgb: rgb[0] < 140 and rgb[1] > 170 and rgb[2] > 170
        orange = lambda rgb: rgb[0] > 210 and 145 < rgb[1] < 205 and rgb[2] < 110
        desired, wrong = (cyan, orange) if color == 'cyan' else (orange, cyan)
        assert sum(map(desired, pixels)) >= 3, f'{name}: x={world_x} should render {color}, pixels={pixels}'
        assert not any(map(wrong, pixels)), f'{name}: x={world_x} has an incorrect overlaid stroke'


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        # Exercise the reported orange warning overlay first, then a clear edge.
        for warnings in [True, False]:
            page = browser.new_page(viewport={'width': 1680, 'height': 1100})
            errors, workers = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('worker', lambda worker: workers.append(worker.url) if 'polylineTeaching.worker' in worker.url else None)
            descriptor = dict(id='polyline-test.urdf', relativePath='polyline-test.urdf', name='polyline_test_robot', fileName='polyline-test.urdf',
                              format='urdf', url='/__atlas/robot-files/polyline-test.urdf', packageName='', packagePath='', packageBaseUrl='/__atlas/robot-files/', manifestUrl=None)
            page.route('**/__atlas/robots', lambda route: route.fulfill(json={'robots': [descriptor]}))
            page.route('**/__atlas/robot-files/polyline-test.urdf', lambda route: route.fulfill(content_type='application/xml', body=(ROOT / 'tests/fixtures/polyline-robot.urdf').read_text()))
            try:
                page.goto(BASE + '/workbench', wait_until='networkidle')
                page.locator('[data-session-state=ready]').wait_for()
                surface = 'polyline-surface-wrinkles.ply' if warnings else 'polyline-surface.ply'
                page.locator('input[type=file][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures' / surface))
                page.locator('.loading-curtain').wait_for(state='hidden')
                topbar_action(page, name='加载机器人', exact=True).click()
                page.get_by_role('option', name='加载机器人 polyline_test_robot', exact=True).click()
                canvas = page.locator('.three-canvas')
                expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
                page.get_by_role('button', name='显示设置', exact=True).click()
                display = page.get_by_role('dialog', name='3D 显示设置', exact=True)
                display.get_by_role('switch', name='显示机器人模型', exact=True).click()
                display.get_by_role('button', name='关闭显示设置', exact=True).click()
                page.get_by_role('button', name='表面折线示教', exact=True).click()
                panel = page.get_by_role('region', name='表面折线示教', exact=True)
                for point in [[.4, .3, .55], [.6, .3, .55]]:
                    target = project_point(page, point); page.mouse.click(target['x'], target['y'])
                expect(panel).to_have_attribute('data-point-count', '2')
                panel.get_by_role('button', name='检查路径', exact=True).click()
                expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
                warning_list = panel.get_by_role('list', name='表面警告列表', exact=True)
                if warnings:
                    assert int(panel.get_attribute('data-warning-count')) > 0
                    expect(warning_list).to_contain_text('P0 → P1')
                expect(canvas).to_have_attribute('data-polyline-completed-mm', '0')
                assert_pixels(page, f'checked-warnings-{warnings}', [(.44, 'cyan'), (.55, 'cyan')])
                execute = panel.get_by_role('button', name='执行划线', exact=True)
                execute.click()
                page.wait_for_function('Number(document.querySelector(".three-canvas").dataset.polylineCompletedMm) > 65')
                panel.get_by_role('button', name='暂停', exact=True).click()
                expect(panel).to_have_attribute('data-status', 'paused')
                completed = float(canvas.get_attribute('data-polyline-completed-mm'))
                assert 65 < completed < 95
                assert_pixels(page, f'mid-edge-warnings-{warnings}', [(.44, 'orange'), (.55, 'cyan')])
                preview = panel.get_by_role('checkbox', name='显示笔尖路径预览', exact=True)
                preview.uncheck(); preview.check()
                assert_pixels(page, f'reshown-mid-edge-warnings-{warnings}', [(.44, 'orange'), (.55, 'cyan')])
                panel.get_by_role('button', name='继续', exact=True).click()
                expect(panel).to_have_attribute('data-status', 'completed', timeout=30000)
                assert_pixels(page, f'completed-warnings-{warnings}', [(.44, 'orange'), (.55, 'orange')])
                execute.click()
                expect(panel).to_have_attribute('data-status', 'playing')
                panel.get_by_role('button', name='暂停', exact=True).click()
                expect(canvas).to_have_attribute('data-polyline-completed-mm', '0')
                expect(canvas).to_have_attribute('data-polyline-trace-points', '0')
                assert_pixels(page, f'restarted-warnings-{warnings}', [(.44, 'cyan'), (.55, 'cyan')])
                if warnings:
                    expect(warning_list).to_contain_text('P0 → P1')
                assert len(workers) == 1 and not errors, (workers, errors)
            except Exception:
                page.screenshot(path=str(ARTIFACTS / f'failure-warnings-{warnings}.png'))
                raise
            finally:
                page.close()
        browser.close()
    print('Polyline pixels: clear/warning edges start cyan, only the traveled portion is orange, resume/show/hide preserve the boundary, repeat resets both traces and warning diagnostics remain visible.')


if __name__ == '__main__':
    run()
