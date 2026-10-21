"""Resize the floating joint console without losing controls, values or window state."""
from playwright.sync_api import expect, sync_playwright

from robot_preset_management_ui_smoke import seed
from robot_presets_ui_smoke import scene_values
from teaching_transfer_ui_smoke import CHROME


def drag(page, handle, dx, dy):
    box = handle.bounding_box()
    x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + dx, y + dy, steps=8)
    page.mouse.up()


def expect_size(panel, width, height):
    expect(panel).to_have_css('width', f'{width}px')
    expect(panel).to_have_css('height', f'{height}px')


def expect_on_screen(page, panel):
    page.wait_for_function('''() => {
      const r = document.querySelector('.joint-float-window').getBoundingClientRect();
      return r.left >= 9 && r.top >= 9 && r.right <= innerWidth - 9 && r.bottom <= innerHeight - 9;
    }''')
    assert panel.is_visible()


def run():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            for mode in ('map', 'independent'):
                context = browser.new_context(viewport={'width': 1440, 'height': 1000})
                page = context.new_page()
                page.set_default_timeout(30_000)
                page.on('pageerror', lambda error: errors.append(str(error)))
                seed(page, mode)
                before = scene_values(page)
                page.get_by_role('button', name='打开全关节浮动窗口', exact=True).click()
                panel = page.get_by_role('dialog', name='全关节控制浮动窗口', exact=True)
                width = panel.get_by_role('button', name='调整全关节窗口宽度', exact=True)
                height = panel.get_by_role('button', name='调整全关节窗口高度', exact=True)
                corner = panel.get_by_role('button', name='调整全关节窗口宽高', exact=True)
                expect_size(panel, 520, 760)
                origin = panel.bounding_box()

                drag(page, width, 160, -40)
                expect_size(panel, 680, 760)
                drag(page, height, 40, -180)
                expect_size(panel, 680, 580)
                drag(page, corner, 100, 90)
                expect_size(panel, 780, 670)
                resized = panel.bounding_box()
                assert (resized['x'], resized['y']) == (origin['x'], origin['y'])
                assert scene_values(page) == before, 'resizing must not change robot joints'

                width.focus()
                page.keyboard.press('ArrowLeft')
                expect_size(panel, 770, 670)
                height.focus()
                page.keyboard.press('Shift+ArrowUp')
                expect_size(panel, 770, 630)
                corner.focus()
                page.keyboard.press('ArrowRight')
                page.keyboard.press('ArrowDown')
                expect_size(panel, 780, 640)
                assert scene_values(page) == before

                drag(page, corner, -2000, -2000)
                expect_size(panel, 420, 340)
                body = panel.locator('.joint-float-window__body')
                assert body.evaluate('el => el.scrollHeight > el.clientHeight')
                # The resize handles must leave the content scrollbar usable.
                bounds = body.bounding_box()
                assert bounds['x'] + bounds['width'] <= width.bounding_box()['x']
                page.mouse.move(bounds['x'] + bounds['width'] / 2, bounds['y'] + bounds['height'] / 2)
                page.mouse.wheel(0, 350)
                page.wait_for_function("document.querySelector('.joint-float-window__body').scrollTop > 0")
                field = panel.get_by_role('spinbutton', name='left_J1 关节值', exact=True)
                field.fill('43')
                field.press('Enter')
                page.wait_for_function("JSON.parse(document.querySelector('.three-canvas').dataset.robotJointValues).left_J1 === 43")
                adjusted = scene_values(page)
                drag(page, corner, 2000, 2000)
                expect_on_screen(page, panel)
                box = panel.bounding_box()
                assert abs(box['x'] + box['width'] - 1430) < 1
                assert abs(box['y'] + box['height'] - 990) < 1
                drag(page, corner, 720 - box['width'], 540 - box['height'])
                expect_size(panel, 720, 540)
                assert scene_values(page) == adjusted
                assert 'is-resizing' not in panel.get_attribute('class')

                # Moving and minimizing still work after resizing, and restoring keeps the chosen size.
                title = panel.locator('.joint-float-window__titlebar')
                title_box = title.bounding_box()
                page.mouse.move(title_box['x'] + 75, title_box['y'] + 20)
                page.mouse.down()
                page.mouse.move(title_box['x'] + 165, title_box['y'] + 70, steps=6)
                page.mouse.up()
                assert panel.bounding_box()['x'] > origin['x'] + 80
                title.dblclick(position={'x': 75, 'y': 20})
                expect_size(panel, 720, 540)
                assert abs(panel.bounding_box()['x'] - origin['x']) < 1
                panel.get_by_role('button', name='最小化全关节浮动窗口', exact=True).click()
                expect(panel).to_have_attribute('data-window-state', 'minimized')
                expect(corner).to_have_count(0)
                panel.get_by_role('button', name='展开全关节浮动窗口', exact=True).click()
                expect_size(panel, 720, 540)
                panel.get_by_role('button', name='关闭全关节浮动窗口', exact=True).click()
                page.get_by_role('button', name='打开全关节浮动窗口', exact=True).click()
                expect_size(panel, 720, 540)
                assert scene_values(page) == adjusted
                page.screenshot(path=f'/tmp/atlas-joint-resize-{mode}.png', animations='disabled')

                # Constrained screens must keep the title, close button and resize handle reachable.
                for viewport in ({'width': 390, 'height': 844}, {'width': 320, 'height': 300}):
                    page.set_viewport_size(viewport)
                    expect_on_screen(page, panel)
                    expect(corner).to_be_in_viewport()
                    expect(panel.get_by_role('button', name='关闭全关节浮动窗口', exact=True)).to_be_in_viewport()
                panel.get_by_role('button', name='最小化全关节浮动窗口', exact=True).click()
                expect_on_screen(page, panel)
                panel.get_by_role('button', name='展开全关节浮动窗口', exact=True).click()
                expect_on_screen(page, panel)
                page.set_viewport_size({'width': 1440, 'height': 1000})
                expect_size(panel, 720, 540)
                expect_on_screen(page, panel)
                context.close()
                print(f'{mode}: edge/corner/keyboard resizing, limits, scrolling, controls and size retention passed', flush=True)
            assert not errors, errors
        finally:
            browser.close()


if __name__ == '__main__':
    run()
