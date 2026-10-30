"""Find the loaded robot from either teaching workspace without changing its state."""
import math
import os
from pathlib import Path
import sys

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests'))
from topbar_tools_helpers import robot_model_menu
from viewer_tools_helpers import display_settings_section, viewer_tool
from end_effector_control_smoke import double_click_tool

BASE_URL = os.environ.get('BASE_URL', 'http://127.0.0.1:22176').rstrip('/')
ARTIFACTS = ROOT / 'test-artifacts/robot-focus'


def state(canvas):
    return canvas.evaluate('''canvas => {
      const d = canvas.dataset;
      return {
        pose: ['X', 'Y', 'Z', 'Roll', 'Pitch', 'Yaw'].map(axis => d['robot' + axis]),
        joints: JSON.parse(d.robotJointValues || '{}'),
        control: d.robotControlEnabled, keyboard: d.keyboardControlOwner,
        opacity: d.robotModelOpacity,
        chassis: d.chassisDragMode,
        endEffector: [d.endEffectorControlState, d.endEffectorSide, d.endEffectorMode],
      };
    }''')


def view(canvas):
    return canvas.evaluate('''canvas => {
      const d = canvas.dataset;
      return {
        position: ['X', 'Y', 'Z'].map(axis => Number(d['camera' + axis])),
        target: ['X', 'Y', 'Z'].map(axis => Number(d['target' + axis])),
        up: ['X', 'Y', 'Z'].map(axis => Number(d['cameraUp' + axis])),
        zoom: Number(d.opticalZoom), distance: Number(d.cameraDistance),
      };
    }''')


def direction(snapshot):
    delta = [x - y for x, y in zip(snapshot['position'], snapshot['target'])]
    size = math.sqrt(sum(x * x for x in delta))
    return [x / size for x in delta]


def exercise(browser, mode):
    context = browser.new_context(viewport={'width': 1440, 'height': 900})
    page = context.new_page()
    page.set_default_timeout(30000)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        page.goto(BASE_URL, wait_until='networkidle')
        page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
        page.get_by_role('radio', name='独立示教' if mode == 'independent' else '地图示教').click()
        with page.expect_file_chooser() as chooser:
            page.get_by_role('button', name='新建工程', exact=True).click()
        chooser.value.set_files(str(ROOT / 'tests/fixtures/rotation-map.ply'))
        page.wait_for_url(f'{BASE_URL}/workbench')
        page.locator('.loading-curtain').wait_for(state='hidden')
        canvas = page.get_by_label('三维点云交互画布', exact=True)
        heading = page.locator('.panel-3d .panel-heading')
        expect(heading.get_by_role('group', name='机器人实时坐标')).to_have_count(0)
        expect(heading.get_by_role('button', name='找到机器人')).to_have_count(0)
        picker = robot_model_menu(page)
        find = page.get_by_role('button', name='找到机器人', exact=True)
        opacity = picker.get_by_role('slider', name='机器人透明度', exact=True)
        expect(find).to_be_visible()
        expect(find).to_be_disabled()
        expect(opacity).to_be_disabled()
        expect(opacity).to_have_value('100')
        expect(picker.locator('.robot-picker__coordinates b')).to_have_text(['—', '—', '—'])
        page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70').click()
        expect(canvas).to_have_attribute('data-robot-model-state', 'loaded', timeout=180000)

        robot_model_menu(page)
        visibility = picker.get_by_role('switch', name='显示机器人', exact=True)
        visibility.focus()
        page.keyboard.press('Tab')
        expect(opacity).to_be_focused()
        expect(opacity).to_be_enabled()
        opacity.press('Home')
        expect(canvas).to_have_attribute('data-robot-model-opacity', '0')
        opacity.press('End')
        expect(canvas).to_have_attribute('data-robot-model-opacity', '1')
        opacity.press('ArrowLeft')
        expect(picker).to_be_visible()
        expect(opacity).to_be_focused()
        expect(canvas).to_have_attribute('data-robot-model-opacity', '0.99')
        # Pointer adjustment stays in the flyout and updates the shared renderer.
        box = opacity.bounding_box()
        page.mouse.move(box['x'] + box['width'] - 5, box['y'] + box['height'] / 2)
        page.mouse.down()
        page.mouse.move(box['x'] + box['width'] * 0.35, box['y'] + box['height'] / 2, steps=10)
        page.mouse.up()
        percentage = int(opacity.input_value())
        assert 30 <= percentage <= 40, percentage
        expect(canvas).to_have_attribute('data-robot-model-opacity', str(percentage / 100))
        visibility.click()
        expect(canvas).to_have_attribute('data-robot-layer-visible', 'false')
        visibility.click()
        expect(canvas).to_have_attribute('data-robot-layer-visible', 'true')
        expect(opacity).to_have_value(str(percentage))
        page.keyboard.press('Escape')
        page.keyboard.press('Escape')
        settings = display_settings_section(page, '机器人与相机')
        original_opacity = settings.get_by_role('slider', name='机器人模型透明度', exact=True)
        expect(original_opacity).to_have_value(str(percentage))
        original_opacity.press('ArrowRight')
        expect(canvas).to_have_attribute('data-robot-model-opacity', str((percentage + 1) / 100))
        settings.get_by_role('button', name='关闭显示设置', exact=True).click()
        robot_model_menu(page)
        expect(opacity).to_have_value(str(percentage + 1))

        def locate():
            robot_model_menu(page)
            expect(find).to_be_enabled()
            before_state = state(canvas)
            before_view = view(canvas)
            revision = canvas.get_attribute('data-synchronized-focus-revision')
            find.click()
            expect(picker).to_have_count(0)
            expect(canvas).not_to_have_attribute('data-synchronized-focus-revision', revision or '')
            expect(canvas).to_have_attribute('data-synchronized-focus-type', 'robot')
            expect(canvas).to_have_attribute('data-synchronized-focus-state', 'settled')
            assert state(canvas) == before_state, (mode, before_state, state(canvas))
            after = view(canvas)
            assert after['zoom'] == 1
            assert max(abs(x - y) for x, y in zip(direction(before_view), direction(after))) < 1e-5
            assert after['up'] == before_view['up']
            assert 1 < after['distance'] < 20

        locate()
        expect(canvas).to_have_attribute('data-robot-control-enabled', 'false')
        page.screenshot(path=str(ARTIFACTS / f'{mode}.png'), full_page=True)
        robot_model_menu(page)
        coordinates = picker.get_by_role('group', name='机器人实时坐标')
        expect(coordinates).to_contain_text('VIRTUAL_ORIGIN' if mode == 'independent' else 'MAP')
        expect(coordinates.locator('.robot-picker__position-name')).to_have_text('botx_abx_zivid_m70')
        for axis, key, digits in [('x', 'X', 3), ('y', 'Y', 3), ('yaw', 'Yaw', 1)]:
            value = float(canvas.get_attribute(f'data-robot-{key.lower()}'))
            expect(coordinates.locator(f'[data-axis="{axis}"] b')).to_have_text(f'{value:.{digits}f}')
        page.screenshot(path=str(ARTIFACTS / f'{mode}-menu.png'), full_page=True)
        page.keyboard.press('Escape')
        page.keyboard.press('Escape')

        double_click_tool(page, canvas, 'left')
        expect(page.get_by_label('机械臂末端空间球', exact=True)).to_be_visible()
        expect(canvas).to_have_attribute('data-end-effector-side', 'left')
        locate()
        expect(canvas).to_have_attribute('data-end-effector-side', 'left')
        canvas.press('Escape')
        expect(canvas).to_have_attribute('data-end-effector-control-state', 'idle')

        # Finding a hidden model restores its visibility without driving it.
        settings = display_settings_section(page, '机器人与相机')
        settings.get_by_role('switch', name='显示机器人模型', exact=True).click()
        expect(canvas).to_have_attribute('data-robot-layer-visible', 'false')
        locate()
        expect(canvas).to_have_attribute('data-robot-layer-visible', 'true')

        # Existing keyboard ownership survives the separate camera action.
        viewer_tool(page, name='定位机器人模型').click()
        expect(canvas).to_have_attribute('data-robot-control-enabled', 'true')
        # The relocated readout follows actual chassis motion, not a menu snapshot.
        original_x = float(canvas.get_attribute('data-robot-x'))
        canvas.press('w')
        page.wait_for_function('x => Math.abs(Number(document.querySelector(".three-canvas").dataset.robotX) - x) > 0.01', arg=original_x)
        robot_model_menu(page)
        moved_x = float(canvas.get_attribute('data-robot-x'))
        expect(picker.locator('[data-axis="x"] b')).to_have_text(f'{moved_x:.3f}')
        locate()
        viewer_tool(page, name='定位机器人模型').click()
        expect(canvas).to_have_attribute('data-robot-control-enabled', 'false')
        locate()  # Close the menu as well as locating.

        if mode == 'map':
            page.get_by_role('button', name='折叠3D窗口', exact=True).click()
            expect(page.locator('.panel-3d')).to_have_attribute('data-collapsed', 'true')
            locate()
            expect(page.locator('.panel-3d')).to_have_attribute('data-collapsed', 'false')

        # New requests replace the previous animation; real wheel input cancels it.
        revision = int(canvas.get_attribute('data-synchronized-focus-revision'))
        for _ in range(2):
            robot_model_menu(page)
            find.click()
        expect(canvas).to_have_attribute('data-synchronized-focus-revision', str(revision + 2))
        expect(canvas).to_have_attribute('data-synchronized-focus-state', 'settled')
        robot_model_menu(page)
        find.click()
        expect(canvas).to_have_attribute('data-synchronized-focus-state', 'animating')
        box = canvas.bounding_box()
        page.mouse.move(box['x'] + box['width'] * 0.85, box['y'] + box['height'] * 0.2)
        page.mouse.wheel(0, 300)
        expect(canvas).to_have_attribute('data-synchronized-focus-state', 'interrupted')
        interrupted = view(canvas)
        page.wait_for_timeout(650)
        assert view(canvas) == interrupted, 'cancelled animation moved the camera again'
        locate()

        page.set_viewport_size({'width': 1120, 'height': 900})
        locate()
        robot_model_menu(page)
        assert find.evaluate('el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }')
        expect(find.locator('span')).to_be_visible()
        page.screenshot(path=str(ARTIFACTS / f'{mode}-narrow.png'), full_page=True)
        assert not errors, errors
        print(f'PASS {mode}: hover menu, shared opacity, slider keyboard/drag, live coordinates, visibility, controls, framing and narrow layout', flush=True)
    except Exception:
        page.screenshot(path=str(ARTIFACTS / f'{mode}-failure.png'), full_page=True)
        raise
    finally:
        context.close()


if __name__ == '__main__':
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or None)
        try:
            for mode in ['map', 'independent']:
                exercise(browser, mode)
        finally:
            browser.close()
