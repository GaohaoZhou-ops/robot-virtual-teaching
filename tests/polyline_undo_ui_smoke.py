"""Point picking shortcuts, native text undo and execution/gesture isolation."""
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
from polyline_parameters_ui_smoke import setup
from polyline_teaching_ui_smoke import project_point

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test-artifacts/polyline-undo'


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        page = browser.new_page(viewport={'width': 1680, 'height': 1100})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            panel, canvas = setup(page)
            points = panel.get_by_role('list', name='折线点列表', exact=True)
            robot = canvas.get_attribute('data-robot-joint-values')
            vertices = [[.4, .3, .55], [.5, .3, .55], [.5, .4, .55]]
            def pick(vertex):
                xy = project_point(page, vertex); page.mouse.click(xy['x'], xy['y'])
            for vertex in vertices:
                pick(vertex)
            expect(panel).to_have_attribute('data-point-count', '3')
            page.keyboard.press('Control+z')
            expect(panel).to_have_attribute('data-point-count', '2')
            expect(points).to_contain_text('0.500 / 0.300 / 0.550')
            expect(points).not_to_contain_text('0.500 / 0.400 / 0.550')
            page.keyboard.press('Meta+z')
            expect(panel).to_have_attribute('data-point-count', '1')
            page.keyboard.press('Control+z')
            expect(panel).to_have_attribute('data-point-count', '0')
            page.keyboard.press('Control+z')
            expect(panel).to_have_attribute('data-undo-count', '0')
            assert canvas.get_attribute('data-robot-joint-values') == robot
            expect(panel).to_be_visible()
            for vertex in vertices[:2]:
                pick(vertex)
            original = points.inner_text()
            # Undo a middle insertion, not simply the last item in the list.
            panel.get_by_role('button', name='选择折线点 P0', exact=True).click()
            panel.get_by_role('button', name='在选中点后插入', exact=True).click()
            pick(vertices[2])
            expect(panel).to_have_attribute('data-point-count', '3')
            page.keyboard.press('Control+z')
            expect(panel).to_have_attribute('data-point-count', '2')
            assert points.inner_text() == original
            # Cancel an unfinished marker drag without consuming an earlier pick.
            depth = panel.get_attribute('data-undo-count')
            start, end = project_point(page, vertices[0]), project_point(page, [.45, .35, .55])
            page.mouse.move(start['x'], start['y']); page.mouse.down()
            page.mouse.move(end['x'], end['y'], steps=8)
            page.keyboard.press('Control+z'); page.mouse.up()
            assert points.inner_text() == original
            expect(panel).to_have_attribute('data-undo-count', depth)
            # Ctrl+Shift+Z is not interpreted as undo.
            page.keyboard.press('Control+Shift+z')
            expect(panel).to_have_attribute('data-undo-count', depth)
            name = panel.get_by_role('textbox', name='折线名称', exact=True)
            name.fill('点选撤销'); name.press('End'); name.press_sequentially(' extra')
            name.press('Control+z')
            expect(panel).to_have_attribute('data-point-count', '2')
            name.press('Meta+z')
            expect(name).to_have_value('点选撤销')
            expect(panel).to_have_attribute('data-point-count', '2')
            speed = panel.get_by_role('spinbutton', name='折线速度 mm/s', exact=True)
            speed.fill('80'); speed.press('Control+z')
            expect(panel).to_have_attribute('data-point-count', '2')
            speed.press('Escape')
            panel.get_by_role('button', name='查看算法约束说明', exact=True).click()
            help_dialog = page.get_by_role('dialog', name='算法约束与参数说明', exact=True)
            page.keyboard.press('Control+z')
            expect(help_dialog).to_be_visible()
            expect(panel).to_have_attribute('data-undo-count', depth)
            page.keyboard.press('Escape')
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            panel.get_by_role('button', name='执行划线', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'playing')
            page.keyboard.press('Control+z')
            expect(panel).to_have_attribute('data-point-count', '2')
            expect(panel).to_have_attribute('data-status', 'playing')
            panel.get_by_role('button', name='暂停', exact=True).click()
            page.keyboard.press('Control+z')
            expect(panel).to_have_attribute('data-status', 'paused')
            expect(panel).to_have_attribute('data-point-count', '2')
            panel.get_by_role('button', name='停止折线任务', exact=True).click()
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            page.keyboard.press('Control+z')
            expect(panel).to_have_attribute('data-point-count', '1')
            expect(panel).to_have_attribute('data-status', 'editing')
            expect(panel.get_by_role('button', name='执行划线', exact=True)).to_be_disabled()
            pick(vertices[1])
            expect(panel).to_have_attribute('data-point-count', '2')
            page.screenshot(path=str(ARTIFACTS / 'undo-and-continue.png'), full_page=True)
            assert not errors, errors
        except Exception:
            page.screenshot(path=str(ARTIFACTS / 'failure.png'), full_page=True)
            print(panel.inner_text() if panel.count() else errors)
            raise
        finally:
            browser.close()
    print('Polyline undo: Ctrl/Command+Z, repeated picks, middle insertion, drag cancellation, native text undo, modal/playback isolation and plan invalidation passed.')


if __name__ == '__main__':
    run()
