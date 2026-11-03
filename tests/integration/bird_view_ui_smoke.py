"""Exercise bird-view cycling and interruption through the actual camera controls."""
import math
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests'))
from teaching_transfer_ui_smoke import CHROME, ready, seed, snapshot
from topbar_tools_helpers import topbar_action
from viewer_tools_helpers import display_settings_section, viewer_tool


def view(canvas):
    return canvas.evaluate('''canvas => {
      const d = canvas.dataset;
      const vector = prefix => ['X', 'Y', 'Z'].map(axis => Number(d[prefix + axis]));
      return {position: vector('camera'), target: vector('target'), up: vector('cameraUp'),
        zoom: Number(d.opticalZoom)};
    }''')


def check_bird(page, step):
    settings = display_settings_section(page, '还原视角')
    settings.get_by_role('button', name='鸟瞰图', exact=True).click()
    expect(settings).to_be_visible()
    canvas = page.locator('.three-canvas')
    expect(canvas).to_have_attribute('data-view-state', 'preset-bird')
    result = view(canvas)
    x, y, z = [a - b for a, b in zip(result['position'], result['target'])]
    azimuth = math.degrees(math.atan2(y, x))
    error = (azimuth - (-135 + step * 45) + 180) % 360 - 180
    assert abs(error) < 0.001, (step, azimuth)
    assert math.isclose(math.degrees(math.atan2(z, math.hypot(x, y))), 45, abs_tol=0.001)
    assert result['zoom'] == 1
    assert result['up'] == [0, 0, 1]
    return result


def exercise(page, mode):
    canvas = page.locator('.three-canvas')
    # Let workspace loading normalize and autosave the synthetic fixture first.
    page.wait_for_timeout(1500)
    before = snapshot(page, mode)
    initial = check_bird(page, 0)
    for step in range(1, 9):
        current = check_bird(page, step % 8)
        assert current['target'] == initial['target']
        assert math.isclose(math.dist(current['position'], current['target']),
                            math.dist(initial['position'], initial['target']), rel_tol=1e-8)

    def close_settings():
        page.get_by_role('button', name='关闭显示设置', exact=True).click()

    # Closing/reopening the menu alone must not reset the rotation sequence.
    close_settings()
    check_bird(page, 1)

    def drag(button='left', shift=False):
        rect = canvas.bounding_box()
        x, y = rect['x'] + rect['width'] * 0.25, rect['y'] + rect['height'] * 0.6
        page.mouse.move(x, y)
        if shift:
            page.keyboard.down('Shift')
        page.mouse.down(button=button)
        page.mouse.move(x + 60, y + 25, steps=8)
        page.mouse.up(button=button)
        if shift:
            page.keyboard.up('Shift')

    def wheel():
        rect = canvas.bounding_box()
        page.mouse.move(rect['x'] + rect['width'] * 0.25, rect['y'] + rect['height'] * 0.6)
        page.mouse.wheel(0, -160)

    def keyboard(key):
        canvas.focus()
        page.keyboard.press(key)

    def preview_roundtrip():
        original = view(canvas)
        canvas.evaluate('''canvas => {
          for (const deltaX of [80, -80]) canvas.dispatchEvent(new CustomEvent('atlas-main-view-preview-control', {
            detail: {kind: 'pan', deltaX, deltaY: 0, sourceWidth: canvas.clientWidth, sourceHeight: canvas.clientHeight}
          }));
        }''')
        restored = view(canvas)
        assert math.dist(original['position'], restored['position']) < 1e-7
        assert math.dist(original['target'], restored['target']) < 1e-7

    cdp = page.context.new_cdp_session(page)

    def pinch():
        rect = canvas.bounding_box()
        x, y = rect['x'] + rect['width'] * 0.3, rect['y'] + rect['height'] * 0.6
        for index, spread in enumerate((25, 40, 55)):
            cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart' if index == 0 else 'touchMove',
                'touchPoints': [{'id': identity, 'x': x + offset, 'y': y}
                                for identity, offset in ((1, -spread), (2, spread))]})
            page.wait_for_timeout(50)
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})

    actions = [
        ('rotate', drag), ('pan', lambda: drag('right')), ('shift-pan', lambda: drag(shift=True)),
        ('wheel', wheel), ('keyboard-pan', lambda: keyboard('w')),
        ('keyboard-rotate', lambda: keyboard('ArrowLeft')), ('touch-pinch', pinch),
        ('preview-roundtrip', preview_roundtrip),
        ('other-preset', lambda: display_settings_section(page, '还原视角').get_by_role('button', name='俯视图', exact=True).click()),
        ('reset', lambda: viewer_tool(page, '重置3D视角').click()),
    ]
    for name, action in actions:
        close_settings()
        previous = view(canvas)
        action()
        page.wait_for_timeout(200)
        if name != 'preview-roundtrip':
            assert view(canvas) != previous, f'{name} did not move the camera'
        check_bird(page, 0)
        check_bird(page, 1)

    # A saved camera may reload at a rotated bird angle, but its click sequence is new.
    close_settings()
    page.reload(wait_until='networkidle')
    ready(page, mode)
    check_bird(page, 0)
    check_bird(page, 1)
    page.wait_for_timeout(1000)
    after = snapshot(page, mode)
    assert before['positions'] == after['positions']
    for key in ('waypoints', 'paths', 'robot'):
        assert before['project'][key] == after['project'][key], key
    print(f'PASS: {mode} full orbit, menu reuse, {len(actions)} interruption paths and refresh reset', flush=True)
    close_settings()


def run():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True,
            **({'executable_path': str(CHROME)} if CHROME.exists() else {}))
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 1000}, has_touch=True)
            page.set_default_timeout(30000)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            seed(page, ['map', 'independent'], 'map', fixture_name='teachingTransfer3DFixture')
            exercise(page, 'map')
            topbar_action(page, name='切换到独立示教', exact=True).click()
            ready(page, 'independent')
            exercise(page, 'independent')
            topbar_action(page, name='切换到地图示教', exact=True).click()
            ready(page, 'map')
            check_bird(page, 0)
            assert not errors, errors
        finally:
            browser.close()


if __name__ == '__main__':
    run()
