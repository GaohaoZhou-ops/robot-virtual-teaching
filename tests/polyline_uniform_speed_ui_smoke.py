"""Constraint checkbox, worker planning, playback invalidation and persistence."""
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
from archive_helpers import start_project_download, read_exported_project
from polyline_teaching_ui_smoke import BASE, project_point
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test-artifacts/polyline-uniform-speed'


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
            constraints = panel.get_by_role('group', name='算法约束', exact=True)
            uniform = constraints.get_by_role('checkbox', name='匀速划线', exact=True)
            expect(uniform).to_be_checked()
            expect(panel.get_by_role('group', name='底盘规划', exact=True)).to_have_count(0)
            for mode in ['移动', '自搜索']:
                constraints.get_by_role('checkbox', name=mode, exact=True).check()
                expect(uniform).to_be_enabled(); expect(uniform).to_be_checked()
            constraints.get_by_role('checkbox', name='静止', exact=True).check()
            expect(uniform).to_be_checked()
            for point in [[.4, .3, .55], [.6, .3, .55], [.6, .5, .55]]:
                target = project_point(page, point); page.mouse.click(target['x'], target['y'])
            expect(panel).to_have_attribute('data-point-count', '3')
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            result = panel.get_by_label('匀速划线结果', exact=True)
            expect(result).to_contain_text('规划划线速度：')
            expect(result).to_contain_text('圆角偏移 ≤ 0.50 mm')
            result.scroll_into_view_if_needed()
            page.screenshot(path=str(ARTIFACTS / 'uniform-constraints.png'), full_page=True)
            panel.get_by_role('button', name='执行划线', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'playing')
            expect(uniform).to_be_disabled()
            page.wait_for_function('Number(document.querySelector(".polyline-teaching").dataset.toolTravelMm) > 1')
            panel.get_by_role('button', name='暂停', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'paused')
            expect(uniform).to_be_disabled()
            panel.get_by_role('button', name='停止折线任务', exact=True).click()
            expect(uniform).to_be_enabled()
            uniform.uncheck()
            expect(panel).to_have_attribute('data-status', 'editing')
            expect(result).to_have_count(0)
            expect(panel.get_by_role('button', name='执行划线', exact=True)).to_be_disabled()
            panel.get_by_role('button', name='撤销', exact=True).click()
            expect(uniform).to_be_checked()
            uniform.uncheck()
            panel.get_by_role('textbox', name='折线名称', exact=True).fill('匀速设置回归')
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            expect(result).to_have_count(0)
            expect(panel).to_contain_text('严格直线连接 · 拐角停顿')
            panel.get_by_role('button', name='保存', exact=True).click()
            expect(panel).not_to_have_attribute('data-status', 'saving')
            with page.expect_download() as download:
                start_project_download(page)
            exported = read_exported_project(download.value)
            saved = [path for task in exported['virtualTeaching']['tasks'] for path in task.get('polylines', [])]
            assert len(saved) == 1 and saved[0]['settings']['uniformSpeed'] is False
            panel.get_by_role('button', name='新建', exact=True).click()
            expect(uniform).to_be_checked()
            page.reload(wait_until='networkidle')
            page.locator('[data-session-state=ready]').wait_for()
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            panel.locator('summary').filter(has_text='已保存折线').click()
            panel.locator('.polyline-teaching__library button').filter(has_text='匀速设置回归').click()
            expect(uniform).not_to_be_checked()
            expect(panel).to_have_attribute('data-point-count', '3')
            assert not errors, errors
        except Exception:
            page.screenshot(path=str(ARTIFACTS / 'failure.png'), full_page=True)
            print(page.locator('.polyline-teaching').inner_text() if page.locator('.polyline-teaching').count() else errors)
            raise
        finally:
            browser.close()
    print('Uniform UI: default/all base modes, worker result, playback, locks, invalidation, undo, strict mode, export and reload passed.')


if __name__ == '__main__':
    run()
