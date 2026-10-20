"""Exercise the same real mouse gestures in all three main 3D pages."""
import json
import math

from playwright.sync_api import expect, sync_playwright

from model_editor_ui_smoke import BASE_URL, CHROME, FIXTURES
from viewer_tools_helpers import open_viewer_tools


def vector_delta(a, b):
    return [x - y for x, y in zip(a, b)]


def length(vector):
    return math.sqrt(sum(value * value for value in vector))


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def unit(vector):
    size = length(vector)
    return [value / size for value in vector]


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def exercise(browser, mode):
    context = browser.new_context(viewport={'width': 1440, 'height': 900})
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.set_default_timeout(30000)
    editor = mode == 'editor'
    fixture = str(FIXTURES / 'rotation-map.ply')
    if editor:
        page.goto(f'{BASE_URL}/model-editor', wait_until='networkidle')
        page.get_by_label('导入模型文件', exact=True).set_input_files(fixture)
        expect(page.locator('[data-app-page="model-editor"]')).to_have_attribute('data-editor-state', 'ready')
        canvas = page.get_by_label('模型编辑三维预览', exact=True)
    else:
        page.goto(BASE_URL, wait_until='networkidle')
        page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
        page.get_by_role('radio', name='独立示教' if mode == 'independent' else '地图示教').click()
        with page.expect_file_chooser() as chooser:
            page.get_by_role('button', name='新建工程', exact=True).click()
        chooser.value.set_files(fixture)
        page.wait_for_url(f'{BASE_URL}/workbench')
        page.locator('.loading-curtain').wait_for(state='hidden')
        expect(page.locator('.app-shell[data-app-page="workbench"]')).to_have_attribute('data-teaching-space-mode', mode)
        canvas = page.get_by_label('三维点云交互画布', exact=True)
    expect(canvas).to_have_attribute('data-control-mode', 'free-trackball')
    expect(canvas).to_have_attribute('data-zoom-mode', 'hybrid-continuous-detail')
    page.wait_for_timeout(150)

    def camera():
        data = canvas.evaluate('element => ({...element.dataset})')
        return {
            'position': json.loads(data['cameraPosition']) if editor else [float(data[f'camera{a}']) for a in 'XYZ'],
            'target': json.loads(data['cameraTarget']) if editor else [float(data[f'target{a}']) for a in 'XYZ'],
            'up': json.loads(data['cameraUp']) if editor else [float(data[f'cameraUp{a}']) for a in 'XYZ'],
            'distance': float(data['cameraDistance']),
            'effective': float(data['effectiveCameraDistance']),
        }

    def center():
        rect = canvas.bounding_box()
        return rect['x'] + rect['width'] / 2, rect['y'] + rect['height'] / 2

    def wheel(delta):
        previous = camera()['effective']
        page.mouse.wheel(0, delta)
        page.wait_for_function("""({canvas, previous, direction}) =>
          (Number(canvas.dataset.effectiveCameraDistance) - previous) * direction > 0
        """, arg={'canvas': canvas.element_handle(), 'previous': previous,
                  'direction': 1 if delta > 0 else -1})

    def drag(button='left', dx=80, dy=40):
        x, y = center()
        page.mouse.move(x, y)
        page.mouse.down(button=button)
        page.mouse.move(x + dx, y + dy, steps=8)
        page.mouse.up(button=button)
        page.wait_for_timeout(70)

    def toggle():
        if not editor:
            open_viewer_tools(page)
        page.locator('.viewer-interaction-mode').click()

    def check_pan(before, after, dx=80, dy=40):
        translation = vector_delta(after['target'], before['target'])
        assert length(vector_delta(translation, vector_delta(after['position'], before['position']))) < 1e-6
        assert length(vector_delta(before['up'], after['up'])) < 1e-6
        assert abs(after['distance'] - before['distance']) < 1e-5
        backward = unit(vector_delta(before['position'], before['target']))
        right = unit(cross(before['up'], backward))
        screen_up = cross(backward, right)
        scale = 2 * before['effective'] * math.tan(math.radians(23)) / canvas.evaluate('element => element.clientHeight')
        # All pages follow the teaching workspace's screen-plane direction
        # and one-pixel sensitivity, regardless of camera orientation or size.
        assert math.isclose(dot(translation, right), -dx * scale, rel_tol=1e-5, abs_tol=1e-6), (mode, dot(translation, right), -dx * scale)
        assert math.isclose(dot(translation, screen_up), dy * scale, rel_tol=1e-5, abs_tol=1e-6), (mode, dot(translation, screen_up), dy * scale)

    # Equal horizontal drag fractions produce the same angle in every page.
    before = camera()
    drag(dx=canvas.bounding_box()['width'] * 0.08, dy=0)
    after = camera()
    assert length(vector_delta(before['target'], after['target'])) < 1e-6
    angle = math.acos(max(-1, min(1, dot(unit(vector_delta(before['position'], before['target'])), unit(vector_delta(after['position'], after['target']))))))
    assert math.isclose(angle, 0.08 * 2 * 1.35, abs_tol=0.005), (mode, angle)
    check_pan(after, (drag('right') or camera()))

    before = camera()
    canvas.focus()
    page.keyboard.down('Shift')
    expect(canvas).to_have_attribute('data-effective-interaction-mode', 'shift-pan')
    drag()
    page.keyboard.up('Shift')
    check_pan(before, camera())
    expect(canvas).to_have_attribute('data-effective-interaction-mode', 'rotate')
    expect(canvas).to_have_attribute('data-last-pointer-gesture', 'shift-pan')

    # Shift can also take ownership after a rotation has already started.
    x, y = center()
    page.mouse.move(x, y); page.mouse.down()
    page.mouse.move(x + 30, y, steps=4)
    page.wait_for_timeout(50)
    page.keyboard.down('Shift')
    before = camera()
    page.mouse.move(x + 110, y + 40, steps=8)
    page.mouse.up(); page.keyboard.up('Shift')
    page.wait_for_timeout(70)
    check_pan(before, camera())

    toggle()
    expect(canvas).to_have_attribute('data-interaction-mode', 'pan')
    before = camera(); drag(); check_pan(before, camera())
    expect(canvas).to_have_attribute('data-last-pointer-gesture', 'mode-pan')
    page.keyboard.down('Shift'); page.keyboard.up('Shift')
    expect(canvas).to_have_attribute('data-effective-interaction-mode', 'pan')
    toggle()
    expect(canvas).to_have_attribute('data-interaction-mode', 'rotate')

    # Release outside the viewport, then ensure a new drag still works.
    x, y = center(); rect = canvas.bounding_box()
    page.mouse.move(x, y); page.mouse.down()
    page.mouse.move(rect['x'] - 10, y, steps=6); page.mouse.up()
    before = camera(); drag(dx=80, dy=0)
    assert length(vector_delta(before['position'], camera()['position'])) > 0.01

    # Continue far beyond the old six-radius cap, then recover the same view.
    before = camera()
    page.mouse.move(*center())
    for _ in range(20):
        wheel(160)
    assert camera()['effective'] > before['effective'] * 100
    for _ in range(20):
        wheel(-160)
    assert math.isclose(camera()['effective'], before['effective'], rel_tol=1e-6)

    # Same wheel direction and normal-scale response; deep zoom retains pan.
    before = camera(); page.mouse.move(*center()); page.mouse.wheel(0, -100)
    page.wait_for_timeout(100)
    ratio = camera()['effective'] / before['effective']
    assert 0.82 < ratio < 0.85, (mode, ratio)
    for _ in range(80):
        wheel(-160)
        if canvas.get_attribute('data-zoom-stage') == 'optical':
            break
    expect(canvas).to_have_attribute('data-zoom-stage', 'optical')
    offsets = [float(canvas.get_attribute(f'data-precision-pan-{a}')) for a in 'xy']
    drag('right')
    expect(canvas).to_have_attribute('data-pan-implementation', 'precision-offset')
    next_offsets = [float(canvas.get_attribute(f'data-precision-pan-{a}')) for a in 'xy']
    assert length(vector_delta(vector_delta(next_offsets, offsets), [-80, -40])) < 0.01

    if editor:
        page.get_by_role('button', name='适应模型视图', exact=True).click()
        expect(canvas).to_have_attribute('data-optical-zoom', '1')
        expect(canvas).to_have_attribute('data-precision-pan-x', '0.000')
        before = camera()
        page.get_by_label('原点 X', exact=True).focus()
        page.keyboard.down('Shift')
        expect(canvas).to_have_attribute('data-shift-pan-armed', 'false')
        page.keyboard.up('Shift')
        assert length(vector_delta(camera()['position'], before['position'])) < 1e-6
        canvas.focus(); page.keyboard.down('Shift')
        # A lost window focus cannot leave temporary panning latched on.
        page.evaluate("window.dispatchEvent(new Event('blur'))")
        expect(canvas).to_have_attribute('data-effective-interaction-mode', 'rotate')
        page.keyboard.up('Shift')
        page.screenshot(path='/tmp/model-editor-unified-navigation.png')
    assert not errors, errors
    print(f'{mode}: rotation/pan, uncapped zoom-out and return, wheel sensitivity and optical zoom passed')
    context.close()
    return angle


def run():
    with sync_playwright() as playwright:
        options = {'headless': True}
        if CHROME.exists():
            options['executable_path'] = str(CHROME)
        browser = playwright.chromium.launch(**options)
        angles = [exercise(browser, mode) for mode in ['map', 'independent', 'editor']]
        assert max(angles) - min(angles) < 0.005, angles
        browser.close()


if __name__ == '__main__':
    run()
