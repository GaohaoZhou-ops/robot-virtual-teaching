"""New strokes retain planning/tool settings without changing saved records."""
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
        urdf = (ROOT / 'tests/fixtures/polyline-robot.urdf').read_text()
        urdf = urdf.replace('<parent link="base_link"/>', '<parent link="waist_L"/>')
        urdf = urdf.replace('</robot>', '''<link name="waist_L"/>
          <joint name="waist_lift_J" type="prismatic"><parent link="base_link"/><child link="waist_L"/>
          <axis xyz="0 0 1"/><limit lower="-0.25" upper="0.25" effort="10" velocity="0.1"/></joint></robot>''')
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
            cancel_selection = panel.get_by_role('button', name='取消选择并新建折线', exact=True)
            library = panel.locator('.polyline-teaching__library')
            distance = panel.get_by_role('spinbutton', name='末端距线段 mm', exact=True)
            speed = panel.get_by_role('spinbutton', name='折线速度 mm/s', exact=True)
            direction = panel.get_by_role('combobox', name='末端距线段方向', exact=True)
            waist = panel.get_by_role('checkbox', name='协同', exact=True)
            maximum = panel.get_by_role('checkbox', name='最大保障', exact=True)
            uniform = panel.get_by_role('checkbox', name='匀速划线', exact=True)
            expect(speed).to_have_value('300')
            expect(speed).to_have_attribute('max', '300')
            distance.fill('250'); distance.press('Enter')
            speed.fill('80'); speed.press('Enter')
            waist.check(); maximum.check(); uniform.uncheck()
            def expect_settings():
                expect(distance).to_have_value('250'); expect(speed).to_have_value('80')
                expect(direction).to_have_value('-1')
                expect(waist).to_be_checked(); expect(maximum).to_be_checked(); expect(uniform).not_to_be_checked()
                expect(panel.get_by_role('checkbox', name='静止', exact=True)).to_be_checked()
                expect(canvas).to_have_attribute('data-robot-joint-locked-names', '["waist_lift_J"]')
            for vertex in [[.4, .3, .55], [.5, .3, .55]]:
                point = project_point(page, vertex); page.mouse.click(point['x'], point['y'])
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
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
            expect_settings()
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
            for key in ['side', 'tcpOffset', 'toolAxisDirection', 'settings', 'base']:
                assert baseline[0][key] == baseline[1][key], f'new nearby stroke changed {key}'
            first.click()
            page.set_viewport_size({'width': 1200, 'height': 760})
            expect(cancel_selection).to_be_in_viewport()
            assert panel.evaluate('el => el.scrollWidth <= el.clientWidth')
            page.screenshot(path=str(ARTIFACTS / 'selected-compact.png'), full_page=True)
            cancel_selection.click()
            expect(panel).to_have_attribute('data-path-id', '')
            expect(panel).to_have_attribute('data-point-count', '0')
            expect_settings()
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
            expect_settings()
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
            expect_settings()
            # New also preserves combined base modes/ranges and the selected
            # positive axis at zero distance, including disabled preferences.
            for mode in ['移动', '自搜索']:
                panel.get_by_role('checkbox', name=mode, exact=True).check()
            for name, value in [('底盘水平范围 m', '1.3'), ('底盘转向范围 °', '75')]:
                field = panel.get_by_role('spinbutton', name=name, exact=True)
                field.fill(value); field.press('Enter')
            direction.select_option('1'); distance.fill('0'); distance.press('Enter')
            panel.get_by_role('button', name='新建', exact=True).click()
            for mode in ['移动', '自搜索']:
                expect(panel.get_by_role('checkbox', name=mode, exact=True)).to_be_checked()
            expect(panel.get_by_role('spinbutton', name='底盘水平范围 m', exact=True)).to_have_value('1.3')
            expect(panel.get_by_role('spinbutton', name='底盘转向范围 °', exact=True)).to_have_value('75')
            expect(direction).to_have_value('1'); expect(distance).to_have_value('0')
            expect(waist).to_be_checked(); expect(maximum).to_be_checked()
            expect(uniform).not_to_be_checked(); expect(speed).to_have_value('80')
            # Committed parameters survive a refresh without saving a new line.
            # Uncommitted text, points, names and selected record IDs do not.
            speed.fill('275'); speed.press('Enter')
            panel.get_by_role('textbox', name='折线名称', exact=True).fill('未保存草稿')
            for vertex in [[.4, .3, .55], [.5, .3, .55]]:
                point = project_point(page, vertex); page.mouse.click(point['x'], point['y'])
            expect(panel).to_have_attribute('data-point-count', '2')
            speed.fill('125')
            page.reload(wait_until='networkidle')
            page.locator('[data-session-state=ready]').wait_for()
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            expect(panel).to_have_attribute('data-path-id', '')
            expect(panel).to_have_attribute('data-point-count', '0')
            expect(panel.get_by_role('textbox', name='折线名称', exact=True)).to_have_value('表面折线')
            expect(speed).to_have_value('275')
            expect(direction).to_have_value('1'); expect(distance).to_have_value('0')
            for mode in ['移动', '自搜索']:
                expect(panel.get_by_role('checkbox', name=mode, exact=True)).to_be_checked()
            expect(panel.get_by_role('spinbutton', name='底盘水平范围 m', exact=True)).to_have_value('1.3')
            expect(panel.get_by_role('spinbutton', name='底盘转向范围 °', exact=True)).to_have_value('75')
            expect(waist).to_be_checked(); expect(maximum).to_be_checked(); expect(uniform).not_to_be_checked()
            # Opening a saved record explicitly adopts its own configuration.
            library.locator('summary').click()
            library.get_by_role('button').filter(has_text='已保存基准折线').click()
            expect_settings()
            assert saved_records(page) == baseline, 'deselect/new/undo/replay must never overwrite or delete saved records'
            panel.get_by_role('button', name='关闭折线示教', exact=True).click()
            expect(panel).to_be_hidden()
            assert not errors, errors
        except Exception:
            page.screenshot(path=str(ARTIFACTS / 'failure.png'), full_page=True)
            raise
        finally:
            browser.close()
    print('Selection UI: 300 mm/s default; new/Esc/reload retain committed parameters; saved-record priority, nearby stroke planning, record isolation, narrow layout, undo and stop-before-deselect passed.')


if __name__ == '__main__':
    run()
