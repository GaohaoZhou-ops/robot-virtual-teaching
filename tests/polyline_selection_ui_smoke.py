"""Deselect saved polylines without leaving teaching or changing saved records."""
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from archive_helpers import start_project_download, read_exported_project
from polyline_teaching_ui_smoke import BASE, project_point
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test-artifacts/polyline-selection'


def saved_records(page):
    with page.expect_download() as download:
        start_project_download(page)
    project = read_exported_project(download.value)
    return [path for task in project['virtualTeaching']['tasks'] for path in task.get('polylines', [])]


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        page = browser.new_page(viewport={'width': 1680, 'height': 1100})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
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
            cancel_selection = panel.get_by_role('button', name='取消选择并新建折线', exact=True)
            library = panel.locator('.polyline-teaching__library')
            for vertex in [[.4, .3, .55], [.5, .3, .55]]:
                point = project_point(page, vertex); page.mouse.click(point['x'], point['y'])
            panel.get_by_role('textbox', name='折线名称', exact=True).fill('已保存基准折线')
            panel.get_by_role('button', name='保存', exact=True).click()
            expect(panel).to_contain_text('已保存至当前示教任务')
            first_id = panel.get_attribute('data-path-id')
            library.locator('summary').click()
            first = library.get_by_role('button').filter(has_text='已保存基准折线')
            first.click()
            expect(first).to_have_attribute('aria-pressed', 'true')
            expect(cancel_selection).to_be_in_viewport()
            page.screenshot(path=str(ARTIFACTS / 'selected.png'), full_page=True)
            page.keyboard.press('Escape')
            expect(panel).to_be_visible()
            expect(panel).to_have_attribute('data-path-id', '')
            expect(panel).to_have_attribute('data-point-count', '0')
            expect(first).to_have_attribute('aria-pressed', 'false')
            expect(cancel_selection).to_have_count(0)
            expect(panel.get_by_role('button', name='连续点选', exact=True)).to_have_attribute('aria-pressed', 'true')
            for vertex in [[.45, .4, .55], [.55, .4, .55]]:
                point = project_point(page, vertex); page.mouse.click(point['x'], point['y'])
            expect(panel).to_have_attribute('data-point-count', '2')
            panel.get_by_role('button', name='仅调整视角', exact=True).click()
            page.keyboard.press('Escape'); page.keyboard.press('Escape')
            expect(panel).to_be_visible()
            expect(panel).to_have_attribute('data-point-count', '2')
            expect(panel.get_by_role('button', name='连续点选', exact=True)).to_have_attribute('aria-pressed', 'true')
            panel.get_by_role('textbox', name='折线名称', exact=True).fill('新绘制折线')
            panel.get_by_role('button', name='保存', exact=True).click()
            expect(panel).to_contain_text('已保存至当前示教任务')
            second_id = panel.get_attribute('data-path-id')
            assert first_id and second_id and first_id != second_id
            baseline = saved_records(page)
            assert len(baseline) == 2 and all(len(path['points']) == 2 for path in baseline)
            first.click()
            page.set_viewport_size({'width': 1200, 'height': 760})
            expect(cancel_selection).to_be_in_viewport()
            assert panel.evaluate('el => el.scrollWidth <= el.clientWidth')
            page.screenshot(path=str(ARTIFACTS / 'selected-compact.png'), full_page=True)
            cancel_selection.click()
            expect(panel).to_have_attribute('data-path-id', '')
            expect(panel).to_have_attribute('data-point-count', '0')
            panel.get_by_role('button', name='撤销', exact=True).click()
            expect(panel).to_have_attribute('data-path-id', first_id)
            expect(panel).to_have_attribute('data-point-count', '2')
            panel.get_by_role('textbox', name='折线名称', exact=True).focus()
            page.keyboard.press('Escape')
            expect(panel).to_have_attribute('data-path-id', first_id)
            page.set_viewport_size({'width': 1680, 'height': 1100})
            panel.get_by_role('button', name='关闭折线示教', exact=True).click()
            tree = page.get_by_role('tree', name='虚拟示教任务停车点层级', exact=True)
            tree.get_by_role('button', name='查看折线 已保存基准折线', exact=True).click()
            expect(panel.get_by_role('button', name='返回表面点选', exact=True)).to_be_visible()
            canvas.focus(); page.keyboard.press('Escape')
            expect(panel).to_be_visible()
            expect(panel).to_have_attribute('data-path-id', '')
            expect(panel).to_have_attribute('data-point-count', '0')
            if not library.evaluate('element => element.open'):
                library.locator('summary').click()
            library.get_by_role('button').filter(has_text='新绘制折线').click()
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            panel.get_by_role('button', name='执行划线', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'playing')
            page.keyboard.press('Escape')
            expect(panel).to_have_attribute('data-status', 'editing')
            expect(panel).to_have_attribute('data-path-id', second_id)
            expect(panel).to_have_attribute('data-point-count', '2')
            page.keyboard.press('Escape')
            expect(panel).to_have_attribute('data-path-id', '')
            expect(panel).to_have_attribute('data-point-count', '0')
            assert saved_records(page) == baseline, 'deselect/new/undo/replay must never overwrite or delete saved records'
            panel.get_by_role('button', name='关闭折线示教', exact=True).click()
            expect(panel).to_be_hidden()
            assert not errors, errors
        except Exception:
            page.screenshot(path=str(ARTIFACTS / 'failure.png'), full_page=True)
            raise
        finally:
            browser.close()
    print('Selection UI: Esc/button deselect, immediate new points, unique records, highlight, narrow layout, undo, input priority, external open and stop-before-deselect passed.')


if __name__ == '__main__':
    run()
