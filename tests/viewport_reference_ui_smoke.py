"""Verify the distance ruler against independently projected world coordinates."""
import math

from playwright.sync_api import expect, sync_playwright

from teaching_transfer_ui_smoke import CHROME, ready, seed, snapshot
from topbar_tools_helpers import topbar_action
from waypoint_names_ui_smoke import display_settings


def check_scale(page):
    ruler = page.get_by_role("complementary", name="三维距离比例尺", exact=True)
    expect(ruler).to_have_attribute("data-ready", "true")
    # Project a segment at the focus depth. This checks the displayed ruler
    # against Three.js projection rather than repeating its FOV formula.
    metrics = page.evaluate("""async () => {
      const THREE = await import('/node_modules/three/build/three.module.js');
      const canvas = document.querySelector('.three-canvas');
      const data = canvas.dataset, ruler = document.querySelector('.viewport-distance-scale');
      const width = canvas.clientWidth, height = canvas.clientHeight;
      const camera = new THREE.PerspectiveCamera(Number(data.cameraFov), width / height, 0.001, 10000);
      camera.position.set(...['X', 'Y', 'Z'].map(axis => Number(data[`camera${axis}`])));
      camera.up.set(...['X', 'Y', 'Z'].map(axis => Number(data[`cameraUp${axis}`])));
      const target = new THREE.Vector3(...['X', 'Y', 'Z'].map(axis => Number(data[`target${axis}`])));
      // Absolute position telemetry is rounded. At optical zoom its subtraction
      // loses relative precision, so use the separately reported camera distance.
      const direction = camera.position.clone().sub(target).normalize();
      camera.position.copy(target).addScaledVector(direction, Number(data.cameraDistance));
      camera.zoom = Number(data.opticalZoom);
      camera.lookAt(target); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
      const meters = Number(ruler.dataset.meters);
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      const start = target.clone().project(camera);
      const end = target.clone().addScaledVector(right, meters).project(camera);
      return { projectedPixels: Math.abs(end.x - start.x) * width / 2,
        rulerPixels: ruler.querySelector('.viewport-distance-scale__bar').getBoundingClientRect().width,
        metersPerPixel: Number(ruler.dataset.metersPerPixel),
        effective: Number(data.effectiveCameraDistance),
        meters, height, zoom: camera.zoom };
    }""")
    assert math.isclose(metrics["projectedPixels"], metrics["rulerPixels"], abs_tol=0.03), metrics
    assert 47.9 <= metrics["rulerPixels"] <= 120.1, metrics
    mode = page.locator('.point-cloud-view').get_attribute('data-teaching-space-mode')
    expect(ruler).to_contain_text("网格 1 m" if mode == 'independent' else "三维距离")
    if mode == 'map':
        expect(ruler).not_to_contain_text("网格 1 m")
    expect(ruler).to_contain_text("视图焦点处比例")
    return metrics


def check_layout(page):
    style = page.locator(".viewport-distance-scale").evaluate("""element => {
      const style = getComputedStyle(element);
      return {background: style.backgroundColor, blur: style.backdropFilter,
        borders: ['Top', 'Right', 'Bottom', 'Left'].map(side => style[`border${side}Width`])};
    }""")
    assert style["background"] == "rgba(0, 0, 0, 0)", style
    assert style["blur"] == "none" and style["borders"] == ["0px"] * 4, style
    ruler = page.locator(".viewport-distance-scale").bounding_box()
    view = page.locator(".point-cloud-view").bounding_box()
    legend_element = page.locator(".height-color-legend")
    legend = legend_element.bounding_box() if legend_element.count() else None
    assert ruler["x"] > view["x"] + view["width"] / 2
    assert ruler["x"] + ruler["width"] <= view["x"] + view["width"]
    assert ruler["y"] + ruler["height"] <= view["y"] + view["height"]
    if legend:
        assert ruler["x"] + ruler["width"] < legend["x"]
        assert math.isclose(legend["y"] + legend["height"], ruler["y"] + ruler["height"], abs_tol=1)
    right_margin = view['x'] + view['width'] - ruler['x'] - ruler['width']
    assert math.isclose(right_margin, 112 if legend else 14, abs_tol=1), right_margin
    help_rows = page.locator('.viewer-help__row')
    expect(help_rows).to_have_count(2)
    first, second = (row.bounding_box() for row in help_rows.all())
    assert first['y'] + first['height'] < second['y']
    assert first['height'] <= 13 and second['height'] <= 13
    assert second['y'] + second['height'] <= view['y'] + view['height']
    for box in (first, second):
        assert box['x'] + box['width'] < ruler['x']


def check_legend_toggle(page, mode):
    settings = display_settings(page)
    color = settings.get_by_role('button', name='切换点云颜色模式', exact=True)
    for _ in range(3):
        if color.get_attribute('data-color-mode') == 'height':
            break
        color.click()
    expect(page.locator('.height-color-legend')).to_be_visible()
    rows = settings.locator('.viewer-display-settings__color, .viewer-display-settings__height-legend, .viewer-display-settings__waypoint-names')
    assert rows.evaluate_all('els => els.map(el => el.firstElementChild.textContent.trim())') == ['点云颜色', '高程色卡', '停车点名']
    before = page.locator('.viewport-distance-scale').bounding_box()
    settings.get_by_role('button', name='隐藏高程色卡', exact=True).click()
    expect(settings.get_by_role('button', name='显示高程色卡', exact=True)).to_have_attribute('aria-pressed', 'false')
    expect(page.locator('.height-color-legend')).to_have_count(0)
    expect(color).to_have_attribute('data-color-mode', 'height')
    check_layout(page)
    after = page.locator('.viewport-distance-scale').bounding_box()
    assert before['y'] == after['y'] and before['height'] == after['height']
    # Switching color modes does not erase the explicit hidden preference.
    for color_mode in ('source', 'white', 'height'):
        color.click()
        expect(color).to_have_attribute('data-color-mode', color_mode)
        expect(settings.locator('.viewer-display-settings__height-legend')).to_have_count(1 if color_mode == 'height' else 0)
        expect(page.locator('.height-color-legend')).to_have_count(0)
        check_layout(page)
    page.keyboard.press('Escape')
    page.screenshot(path=f'/tmp/atlas-height-legend-hidden-{mode}.png', full_page=True)
    page.wait_for_function("""async mode => {
      const store = await import('/src/lib/sessionStore.js');
      const record = await store.loadWorkspaceConfig((await store.fetchServiceSession()).sessionId, mode);
      return record?.config.ui.showHeightLegend3D === false
        && record?.config.project.workspace.showHeightLegend3D === false;
    }""", arg=mode)
    page.reload(wait_until='networkidle')
    ready(page, mode)
    expect(page.locator('.height-color-legend')).to_have_count(0)
    check_scale(page)
    check_layout(page)


def show_legend(page):
    settings = display_settings(page)
    settings.get_by_role('button', name='显示高程色卡', exact=True).click()
    expect(page.locator('.height-color-legend')).to_be_visible()
    page.keyboard.press('Escape')
    check_layout(page)


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True, **({"executable_path": str(CHROME)} if CHROME.exists() else {}))
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=2)
            page.set_default_timeout(30_000)
            page.on("pageerror", lambda error: errors.append(str(error)))
            seed(page, ["map", "independent"], "independent", fixture_name="teachingTransfer3DFixture")
            original = snapshot(page, "independent")
            original_map = snapshot(page, "map")
            canvas = page.locator(".three-canvas")
            expect(canvas).to_have_attribute("data-virtual-ground-z", "0")
            expect(canvas).to_have_attribute("data-reference-grid-spacing", "1")
            expect(canvas).to_have_attribute("data-reference-plane-position", "0,0,0")
            assert float(canvas.get_attribute("data-reference-grid-size")) >= 40
            before = check_scale(page)
            camera_distance_to_origin = math.sqrt(sum(
                float(canvas.get_attribute(f"data-camera-{axis}")) ** 2 for axis in "xyz"))
            ground_radius = float(canvas.get_attribute("data-reference-grid-size")) / math.sqrt(2)
            assert float(canvas.get_attribute("data-camera-far")) >= (
                camera_distance_to_origin + ground_radius) * (1 - 1e-7)
            box = canvas.bounding_box()
            x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            page.mouse.move(x, y)
            for _ in range(6):
                page.mouse.wheel(0, 160)
                page.wait_for_timeout(80)
            after = check_scale(page)
            assert after["metersPerPixel"] > before["metersPerPixel"] * 2
            check_layout(page)
            page.screenshot(path="/tmp/atlas-virtual-ground-scale.png", full_page=True)

            # Rotation changes the perspective without changing the focus scale.
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(x + 100, y + 60, steps=8)
            page.mouse.up()
            page.wait_for_timeout(80)
            rotated = check_scale(page)
            assert math.isclose(rotated["metersPerPixel"], after["metersPerPixel"], rel_tol=1e-6)

            page.set_viewport_size({"width": 1024, "height": 768})
            page.wait_for_timeout(120)
            resized = check_scale(page)
            assert resized["metersPerPixel"] > rotated["metersPerPixel"]
            check_layout(page)
            page.screenshot(path="/tmp/atlas-virtual-ground-scale-compact.png", full_page=True)

            # Optical zoom also participates in the ruler; CSS pixels must stay
            # correct on HiDPI screens and through the dolly/optical transition.
            box = canvas.bounding_box()
            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            for _ in range(80):
                previous = float(canvas.get_attribute("data-effective-camera-distance"))
                page.mouse.wheel(0, -160)
                page.wait_for_function("""previous =>
                  Number(document.querySelector('.three-canvas').dataset.effectiveCameraDistance) < previous
                """, arg=previous)
                if float(canvas.get_attribute("data-optical-zoom")) > 1.5:
                    break
            expect(canvas).to_have_attribute("data-zoom-stage", "optical")
            assert check_scale(page)["zoom"] > 1

            page.reload(wait_until="networkidle")
            ready(page, "independent")
            check_scale(page)
            expect(canvas).to_have_attribute("data-reference-grid-spacing", "1")
            check_legend_toggle(page, 'independent')
            topbar_action(page, name="切换到地图示教", exact=True).click()
            ready(page, "map")
            check_scale(page)
            check_layout(page)
            expect(page.locator('.height-color-legend')).to_be_visible()
            check_legend_toggle(page, 'map')
            show_legend(page)
            page.screenshot(path='/tmp/atlas-height-legend-map-visible.png', full_page=True)
            expect(canvas).to_have_attribute("data-reference-plane", "map-reference-plane")
            assert canvas.get_attribute("data-virtual-ground-z") is None
            assert snapshot(page, "map")["positions"] == original_map["positions"]

            topbar_action(page, name="切换到独立示教", exact=True).click()
            ready(page, "independent")
            check_scale(page)
            expect(page.locator('.height-color-legend')).to_have_count(0)
            show_legend(page)
            for width, height in ((1440, 1000), (1024, 768)):
                page.set_viewport_size({'width': width, 'height': height})
                page.wait_for_timeout(120)
                check_scale(page)
                check_layout(page)
            page.screenshot(path='/tmp/atlas-height-legend-independent-visible.png', full_page=True)
            expect(canvas).to_have_attribute("data-reference-plane-position", "0,0,0")
            final = snapshot(page, "independent")
            assert final["positions"] == original["positions"]
            assert final["pointCount"] == original["pointCount"]
            assert final["project"]["waypoints"] == original["project"]["waypoints"]
            assert final["project"]["paths"] == original["project"]["paths"]
            assert not errors, errors
        finally:
            browser.close()
    print("PASS: both rulers, projection/zoom, legend toggle/layout, two-line hints, HiDPI resize and per-workspace persistence")


if __name__ == "__main__":
    run()
