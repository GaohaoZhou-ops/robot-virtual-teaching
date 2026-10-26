"""Exercise curve authoring, worker planning, progressive playback and ZIP/reload in a fresh profile."""
import json
import math
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from archive_helpers import start_project_download, read_exported_project
from polyline_teaching_ui_smoke import BASE, project_point
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test-artifacts/polyline-spatial-curve'


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        page = browser.new_page(viewport={'width': 1680, 'height': 1100}, accept_downloads=True)
        page.set_default_timeout(30000)
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
            page.locator('input[type=file][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/polyline-surface.ply'))
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
            kinds = panel.get_by_role('group', name='路径类型', exact=True)
            line = kinds.get_by_role('button', name='折线', exact=True)
            spline = kinds.get_by_role('button', name='空间曲线', exact=True)
            expect(line).to_have_attribute('aria-pressed', 'true')
            vertices = [[.4, .3, .55], [.5, .3, .55], [.57, .4, .55], [.6, .3, .55]]
            for point in vertices:
                target = project_point(page, point); page.mouse.click(target['x'], target['y'])
            expect(panel).to_have_attribute('data-point-count', '4')
            expect(canvas).to_have_attribute('data-polyline-preview-segments', '3')
            source_points = panel.get_by_role('list', name='折线点列表', exact=True).inner_text()
            straight_length = float(panel.get_attribute('data-path-length'))
            spline.click()
            expect(panel).to_have_attribute('data-path-type', 'spline')
            assert int(canvas.get_attribute('data-polyline-preview-segments')) > 16
            curve_length = float(panel.get_attribute('data-path-length'))
            assert curve_length > straight_length
            assert panel.get_by_role('list', name='折线点列表', exact=True).inner_text() == source_points
            uniform = panel.get_by_role('checkbox', name='匀速划线', exact=True)
            uniform.uncheck()
            assert float(panel.get_attribute('data-path-length')) == curve_length
            assert int(canvas.get_attribute('data-polyline-preview-segments')) > 16
            uniform.check()
            closed = panel.get_by_role('checkbox', name='闭合曲线', exact=True)
            closed.check()
            assert float(panel.get_attribute('data-path-length')) > curve_length
            closed.uncheck()
            canvas.focus(); page.keyboard.press('Control+z')
            expect(closed).to_be_checked()
            closed.uncheck()
            line.click()
            expect(canvas).to_have_attribute('data-polyline-preview-segments', '3')
            spline.click()
            expect(panel).to_have_attribute('data-point-count', '4')
            page.screenshot(path=str(ARTIFACTS / 'curve-preview.png'), full_page=True)

            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(spline).to_be_disabled()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            assert len(workers) == 1
            assert math.isclose(float(panel.get_attribute('data-planned-distance')), curve_length, abs_tol=1e-6)
            expect(canvas).to_have_attribute('data-polyline-completed-mm', '0')
            panel.get_by_role('button', name='执行划线', exact=True).click()
            page.wait_for_function('Number(document.querySelector(".three-canvas").dataset.polylineCompletedMm) > 35')
            panel.get_by_role('button', name='暂停', exact=True).click()
            completed = float(canvas.get_attribute('data-polyline-completed-mm'))
            assert 35 < completed < curve_length * 800
            assert set(json.loads(canvas.get_attribute('data-polyline-preview-colors'))) == {'ffb02e', '50dce6'}
            assert math.isclose(completed + float(canvas.get_attribute('data-polyline-remaining-mm')), curve_length * 1000, abs_tol=.002)
            percent = panel.get_by_label('已划线比例', exact=True).locator('b')
            assert abs(float(percent.inner_text().rstrip('%')) - completed / (curve_length * 10)) < .06
            preview = panel.get_by_role('checkbox', name='显示笔尖路径预览', exact=True)
            preview.uncheck(); preview.check()
            assert math.isclose(float(canvas.get_attribute('data-polyline-completed-mm')), completed, abs_tol=.001)
            page.screenshot(path=str(ARTIFACTS / 'curve-partly-drawn.png'), full_page=True)
            panel.get_by_role('button', name='继续', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'completed', timeout=60000)
            expect(percent).to_have_text('100.0%')
            assert json.loads(canvas.get_attribute('data-polyline-preview-colors')) == ['ffb02e']
            repeat = panel.get_by_role('button', name='执行划线', exact=True)
            repeat.click()
            panel.get_by_role('button', name='暂停', exact=True).click()
            expect(canvas).to_have_attribute('data-polyline-completed-mm', '0')
            assert len(workers) == 1, 'unchanged curves repeat without a new worker'
            panel.get_by_role('button', name='继续', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'completed', timeout=60000)
            panel.get_by_role('textbox', name='折线名称', exact=True).fill('空间曲线试用')
            panel.get_by_role('button', name='保存', exact=True).click()
            expect(panel).to_contain_text('已保存至当前示教任务')
            identity = panel.get_attribute('data-path-id')
            page.get_by_role('button', name='图谱控制台', exact=True).click()
            expect(canvas).to_have_attribute('data-polyline-preview-visible', 'false')
            tree = page.locator(f'[data-polyline-id="{identity}"]')
            expect(tree).to_contain_text('空间曲线 · 左臂 · 4 点')
            with page.expect_download() as download:
                start_project_download(page)
            saved = next(stroke for task in read_exported_project(download.value)['virtualTeaching']['tasks'] for stroke in task.get('polylines', []) if stroke['id'] == identity)
            assert saved['pathType'] == 'spline' and saved['version'] == 2
            assert len(saved['points']) == 4 and not any(key in saved for key in ['segments', 'parts', 'plan'])
            for point, target in zip(saved['points'], vertices):
                assert math.dist(point['position'], target) < .002
            page.reload(wait_until='networkidle')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
            page.get_by_role('button', name='查看折线 空间曲线试用', exact=True).click()
            expect(spline).to_have_attribute('aria-pressed', 'true')
            expect(panel).to_have_attribute('data-path-id', identity)
            assert int(canvas.get_attribute('data-polyline-preview-segments')) > 16
            panel.get_by_role('button', name='新建', exact=True).click()
            expect(spline).to_have_attribute('aria-pressed', 'true')
            expect(panel).to_have_attribute('data-point-count', '0')
            page.get_by_role('button', name='图谱控制台', exact=True).click()
            topbar_action(page, name='打开示教数据管理页', exact=True).click()
            page.get_by_role('button', name='回放折线 空间曲线试用', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'playing', timeout=60000)
            expect(panel).to_have_attribute('data-path-type', 'spline')
            expect(panel).to_have_attribute('data-status', 'completed', timeout=60000)
            assert not errors, errors
            print('Spatial-curve UI: pointer picking, type switch, uniform/closed/undo, worker execution, arc progress/colors, repeat, ZIP, reload, remembered type and data-center replay passed.', flush=True)
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
