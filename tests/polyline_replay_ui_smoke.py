"""Repeat a completed stroke without replanning, resetting both visible traces."""
import json
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
from polyline_teaching_ui_smoke import BASE, project_point
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test-artifacts/polyline-replay'


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        for partial in [False, True]:
            page = browser.new_page(viewport={'width': 1680, 'height': 1100})
            errors, workers = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('worker', lambda worker: workers.append(worker.url) if 'polylineTeaching.worker' in worker.url else None)
            descriptor = dict(id='polyline-test.urdf', relativePath='polyline-test.urdf', name='polyline_test_robot', fileName='polyline-test.urdf',
                              format='urdf', url='/__atlas/robot-files/polyline-test.urdf', packageName='', packagePath='', packageBaseUrl='/__atlas/robot-files/', manifestUrl=None)
            urdf = (ROOT / 'tests/fixtures/polyline-robot.urdf').read_text()
            if partial:
                urdf = urdf.replace('lower="-1" upper="1"', 'lower="-1" upper="0.12"', 1)
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
                page.get_by_role('button', name='显示设置', exact=True).click()
                display = page.get_by_role('dialog', name='3D 显示设置', exact=True)
                display.get_by_role('switch', name='显示机器人模型', exact=True).click()
                display.get_by_role('button', name='关闭显示设置', exact=True).click()
                page.get_by_role('button', name='表面折线示教', exact=True).click()
                panel = page.get_by_role('region', name='表面折线示教', exact=True)
                if partial:
                    panel.get_by_role('checkbox', name='最大保障', exact=True).check()
                for point in [[.4, .3, .55], [.6, .3, .55]]:
                    target = project_point(page, point); page.mouse.click(target['x'], target['y'])
                expect(panel).to_have_attribute('data-point-count', '2')
                panel.get_by_role('button', name='检查路径', exact=True).click()
                expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
                assert len(workers) == 1
                pending_colors = json.loads(canvas.get_attribute('data-polyline-preview-colors'))
                execute = panel.get_by_role('button', name='执行可达部分' if partial else '执行划线', exact=True)
                execute.click()
                expect(panel).to_have_attribute('data-status', 'completed', timeout=30000)
                assert int(canvas.get_attribute('data-polyline-trace-points')) > 10
                assert float(canvas.get_attribute('data-polyline-completed-mm')) > 100
                expect(execute).to_be_enabled()
                last_pose = json.loads(canvas.get_attribute('data-robot-joint-values'))
                # Observe the synchronous reset before the next animation frame.
                reset = execute.evaluate('''button => {
                    button.click(); const data = document.querySelector('.three-canvas').dataset;
                    return {completed: data.polylineCompletedMm, trace: data.polylineTracePoints,
                        colors: JSON.parse(data.polylinePreviewColors), joints: JSON.parse(data.robotJointValues)};
                }''')
                assert reset['completed'] == '0' and reset['trace'] == '0'
                assert reset['colors'] == pending_colors
                assert reset['joints'] == last_pose, 'clicking repeat must not teleport the robot'
                expect(panel).to_have_attribute('data-status', 'playing')
                expect(panel.locator('[role=status]')).to_contain_text('返回 P0')
                panel.get_by_role('button', name='暂停', exact=True).click()
                expect(panel).to_have_attribute('data-status', 'paused')
                expect(canvas).to_have_attribute('data-polyline-trace-points', '0')
                expect(canvas).to_have_attribute('data-polyline-completed-mm', '0')
                assert float(panel.get_attribute('data-elapsed-ms')) < 1000
                assert float(panel.get_attribute('data-tool-travel-mm')) < 30, 'distance restarts from zero without counting an artificial jump'
                preview = panel.get_by_role('checkbox', name='显示笔尖路径预览', exact=True)
                preview.uncheck(); preview.check()
                assert json.loads(canvas.get_attribute('data-polyline-preview-colors')) == pending_colors
                page.screenshot(path=str(ARTIFACTS / f'reset-partial-{partial}.png'), full_page=True)
                panel.get_by_role('button', name='继续', exact=True).click()
                page.wait_for_function('Number(document.querySelector(".three-canvas").dataset.polylineCompletedMm) > 20')
                panel.get_by_role('button', name='暂停', exact=True).click()
                progress = canvas.get_attribute('data-polyline-completed-mm')
                trace = canvas.get_attribute('data-polyline-trace-points')
                colors = json.loads(canvas.get_attribute('data-polyline-preview-colors'))
                assert 'ffb02e' in colors and set(pending_colors).issubset(set(colors))
                assert 20 < float(progress) < 100
                continued = panel.get_by_role('button', name='继续', exact=True).evaluate('''button => {
                    button.click(); const data = document.querySelector('.three-canvas').dataset;
                    return [data.polylineCompletedMm, data.polylineTracePoints];
                }''')
                assert continued == [progress, trace], 'resume must preserve this run’s orange progress'
                expect(panel).to_have_attribute('data-status', 'completed', timeout=30000)
                assert len(workers) == 1, 'repeat and resume must reuse the checked plan'
                end_pose = json.loads(canvas.get_attribute('data-robot-joint-values'))
                assert all(abs(end_pose[key] - value) < 1e-9 for key, value in last_pose.items())
                execute.click()
                expect(canvas).to_have_attribute('data-polyline-completed-mm', '0')
                expect(canvas).to_have_attribute('data-polyline-trace-points', '0')
                assert len(workers) == 1, 'a third run also needs no planning'
                expect(panel).to_have_attribute('data-status', 'completed', timeout=30000)
                expect(execute).to_be_enabled()
                speed = panel.get_by_role('spinbutton', name='折线速度 mm/s', exact=True)
                speed.fill('60'); speed.press('Tab')
                expect(panel).to_have_attribute('data-status', 'editing')
                expect(panel.get_by_role('button', name='执行划线', exact=True)).to_be_disabled()
                assert not errors, errors
            except Exception:
                page.screenshot(path=str(ARTIFACTS / f'failure-{partial}.png'), full_page=True)
                print(page.locator('.polyline-teaching').inner_text() if page.locator('.polyline-teaching').count() else errors)
                raise
            finally:
                page.close()
        browser.close()
    print('Repeat UI: completed/full and partial runs, immediate cyan/green reset, erased orange trace, no teleport/replanning, return without ink, progressive orange, pause/resume and invalidation passed.')


if __name__ == '__main__':
    run()
