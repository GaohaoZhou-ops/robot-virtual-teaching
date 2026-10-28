"""Real multi-touch input in the three browser 3D viewports (iPad-sized screen)."""
import json
import math
from playwright.sync_api import expect, sync_playwright
from model_editor_ui_smoke import BASE_URL, CHROME, FIXTURES
from viewport_navigation_ui_smoke import vector_delta, length


def exercise(browser, mode):
    context = browser.new_context(viewport={'width': 1194, 'height': 834}, has_touch=True, is_mobile=True)
    page = context.new_page()
    page.add_init_script('''window.touchTrace = []; for (const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture'])
      window.addEventListener(type, event => { if (event.pointerType === 'touch') {
        window.touchTrace.push([type,event.pointerId,event.clientX,event.clientY]); if(window.touchTrace.length > 40)window.touchTrace.shift();
      } }, true);''')
    page.set_default_timeout(30000)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    editor = mode == 'editor'
    fixture = str(FIXTURES / 'rotation-map.ply')
    if editor:
        page.goto(BASE_URL + '/model-editor', wait_until='networkidle')
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
        page.wait_for_url(BASE_URL + '/workbench')
        page.locator('.loading-curtain').wait_for(state='hidden')
        canvas = page.get_by_label('三维点云交互画布', exact=True)
    expect(canvas).to_have_attribute('data-touch-navigation', 'pinch-zoom-two-finger-pan')
    page.wait_for_timeout(150)
    cdp = context.new_cdp_session(page)
    rect = canvas.bounding_box()
    cx, cy = rect['x'] + rect['width'] / 2, rect['y'] + rect['height'] / 2
    spread = min(50, rect['width'] / 8)

    def camera():
        data = canvas.evaluate('(element) => ({...element.dataset})')
        return {'position': json.loads(data['cameraPosition']) if editor else [float(data[f'camera{a}']) for a in 'XYZ'],
                'target': json.loads(data['cameraTarget']) if editor else [float(data[f'target{a}']) for a in 'XYZ'],
                'up': json.loads(data['cameraUp']) if editor else [float(data[f'cameraUp{a}']) for a in 'XYZ'],
                'effective': float(data['effectiveCameraDistance'])}

    def touch(kind, positions):
        cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [
            {'id': identity, 'x': x, 'y': y, 'radiusX': 3, 'radiusY': 3, 'force': 1}
            for identity, x, y in positions]})
        page.wait_for_timeout(40)

    def pair(width=spread, dx=0, dy=0):
        return [(1, cx - width + dx, cy + dy), (2, cx + width + dx, cy + dy)]

    before = camera()
    touch('touchStart', pair())
    for step in range(1, 9):
        touch('touchMove', pair(spread * (1 + step / 8)))
    touch('touchEnd', [])
    after = camera()
    assert math.isclose(after['effective'] / before['effective'], 0.5, rel_tol=1e-5), (mode, before, after)
    assert length(vector_delta(after['target'], before['target'])) < 1e-5, 'pinching must not introduce a pan'
    assert length(vector_delta(after['up'], before['up'])) < 1e-6, 'pinching must not rotate'
    expect(canvas).to_have_attribute('data-last-zoom-source', 'touch-pinch')

    before = camera()
    touch('touchStart', pair())
    for step in range(1, 9):
        touch('touchMove', pair(dx=step * 6, dy=step * 3))
    after = camera()
    translation = vector_delta(after['target'], before['target'])
    assert length(translation) > 0.01
    assert length(vector_delta(translation, vector_delta(after['position'], before['position']))) < 1e-5
    assert math.isclose(after['effective'], before['effective'], rel_tol=1e-6)
    assert length(vector_delta(after['up'], before['up'])) < 1e-6

    # The remaining finger is consumed, rather than becoming a rotate or pick.
    # Chrome's WebTouchEvent path takes the lifted points for a partial end.
    touch('touchEnd', [pair(dx=48, dy=24)[1]])
    touch('touchMove', [(1, cx - spread + 70, cy + 40)])
    assert length(vector_delta(camera()['position'], after['position'])) < 1e-5, (mode, after, camera(), page.evaluate('touchTrace'))
    touch('touchEnd', [])
    before = camera()
    touch('touchStart', [(1, cx, cy)])
    for step in range(1, 5):
        touch('touchMove', [(1, cx + step * 12, cy + step * 3)])
    touch('touchEnd', [])
    assert length(vector_delta(camera()['position'], before['position'])) > 0.01, 'a new single-finger gesture still rotates'

    # Adding/removing a third finger and browser cancellation must not jump or
    # leave camera input latched. Both pan and zoom can happen in one gesture.
    touch('touchStart', pair())
    touch('touchStart', [(3, cx, cy + 80)])
    before = camera()
    touch('touchMove', pair(dx=15) + [(3, cx + 15, cy + 80)])
    assert length(vector_delta(camera()['position'], before['position'])) < 1e-5
    touch('touchEnd', [(3, cx + 15, cy + 80)])
    assert length(vector_delta(camera()['position'], before['position'])) < 1e-5
    touch('touchMove', pair(spread * 1.5, dx=30, dy=15))
    assert camera()['effective'] < before['effective']
    assert length(vector_delta(camera()['target'], before['target'])) > 0.01
    touch('touchCancel', [])

    touch('touchStart', [(1, cx, cy)])
    page.evaluate("window.dispatchEvent(new Event('blur'))")
    touch('touchCancel', [])
    before = camera()
    touch('touchStart', [(1, cx, cy)])
    touch('touchMove', [(1, cx + 40, cy)])
    touch('touchEnd', [])
    assert length(vector_delta(camera()['position'], before['position'])) > 0.01, 'returning after blur must not retain old touch pointers'

    # Pinch uses the same optical-detail floor as the desktop wheel.
    for _ in range(7):
        touch('touchStart', pair(6))
        touch('touchMove', pair(60))
        touch('touchEnd', [])
        if canvas.get_attribute('data-zoom-stage') == 'optical':
            break
    expect(canvas).to_have_attribute('data-zoom-stage', 'optical')
    touch('touchStart', pair())
    touch('touchMove', pair(dx=20, dy=10))
    touch('touchEnd', [])
    expect(canvas).to_have_attribute('data-pan-implementation', 'precision-offset')
    assert not errors, errors
    page.screenshot(path=f'/tmp/atlas-{mode}-ipad-touch.png')
    context.close()
    print(f'{mode}: pinch, two-finger pan, combined gestures, finger transitions, cancellation and optical detail passed')


if __name__ == '__main__':
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, **({'executable_path': str(CHROME)} if CHROME.exists() else {}))
        try:
            for mode in ['map', 'independent', 'editor']:
                exercise(browser, mode)
        finally:
            browser.close()
