"""3D navigation names follow the camera and retain independent display preferences."""
from viewer_tools_helpers import display_settings_section
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from archive_helpers import read_exported_project, start_project_download
from export_separation_ui_smoke import load_project
from teaching_transfer_ui_smoke import BASE_URL, CHROME, ready, snapshot
from topbar_tools_helpers import topbar_action
from viewer_tools_helpers import viewer_tool


POINTS = {
    "map": [[12, 15, 0.2], [24, 15, 0.2], [24, 26, 0.2], [1000000, 0, 0]],
    "independent": [[10, 19.5, 0.8], [11, 20.5, 1.2], [12, 20, 1.8], [1000000, 0, 0]],
}
NAMES = ["停车点一", "检修区 B", "充电点", "视野外导航点"]


def seed(page):
    page.goto(BASE_URL, wait_until="networkidle")
    page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
    page.evaluate("""async ({points, names}) => {
      const { teachingTransfer3DFixture } = await import('/tests/teaching_transfer_helpers.mjs');
      const store = await import('/src/features/workspace/model/sessionStore.js');
      const { sessionId } = await store.fetchServiceSession();
      for (const mode of ['map', 'independent']) {
        const fixture = teachingTransfer3DFixture(mode);
        const project = fixture.config.config.project;
        project.virtualTeaching.tasks = [];
        project.workspace.activeTeachingTaskId = null;
        project.workspace.activeTeachingParkingPointId = null;
        project.waypoints = points[mode].map(([x, y, z], index) => ({
          id: `P${index}`, name: names[index], pose: {x, y, z, roll: 0, pitch: 0, yaw: 0},
        }));
        project.paths = [{id: 'P0-P1', from: 'P0', to: 'P1', directed: true}];
        // Exercise old projects that do not yet have the display preference.
        delete project.workspace.showWaypointNames3D;
        delete fixture.config.config.ui.showWaypointNames3D;
        delete project.workspace.showPathNames3D;
        delete fixture.config.config.ui.showPathNames3D;
        await store.saveWorkspaceMap(sessionId, fixture.map.mapId, fixture.map.name, fixture.map, mode);
        await store.saveWorkspaceConfig(sessionId, fixture.map.mapId, fixture.config.config, mode);
      }
      await store.activateWorkspaceMode(sessionId, 'map');
    }""", {"points": POINTS, "names": NAMES})
    page.goto(f"{BASE_URL}/workbench", wait_until="networkidle")
    ready(page, "map")


def display_settings(page):
    trigger = page.get_by_role("button", name="显示设置", exact=True)
    if trigger.get_attribute("aria-expanded") != "true":
        trigger.click()
    return page.get_by_role("dialog", name="3D 显示设置", exact=True)


def check_projection(page, mode):
    """Reconstruct the camera independently, including rolled views and HiDPI."""
    page.wait_for_function("""() =>
      [...document.querySelectorAll('.waypoint-name-label')]
        .some(label => getComputedStyle(label).visibility === 'visible')
    """)
    labels = page.evaluate("""async points => {
      const THREE = await import('/node_modules/three/build/three.module.js');
      const canvas = document.querySelector('.three-canvas');
      const data = canvas.dataset, box = canvas.getBoundingClientRect();
      const camera = new THREE.PerspectiveCamera(Number(data.cameraFov), box.width / box.height,
        Number(data.cameraNear), Number(data.cameraFar));
      camera.position.set(...['X', 'Y', 'Z'].map(axis => Number(data[`camera${axis}`])));
      camera.up.set(...['X', 'Y', 'Z'].map(axis => Number(data[`cameraUp${axis}`])));
      camera.zoom = Number(data.opticalZoom);
      camera.lookAt(...['X', 'Y', 'Z'].map(axis => Number(data[`target${axis}`])));
      camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
      return [...document.querySelectorAll('.waypoint-name-label')].map((label, index) => {
        const world = new THREE.Vector3(...points[index]);
        const depth = -world.clone().applyMatrix4(camera.matrixWorldInverse).z;
        const projected = world.project(camera);
        const expectedVisible = depth > 0 && [projected.x, projected.y, projected.z]
          .every(value => Math.abs(value) <= 1);
        const rect = label.getBoundingClientRect(), style = getComputedStyle(label);
        const x = box.x + (projected.x + 1) * box.width / 2;
        const y = box.y + (1 - projected.y) * box.height / 2;
        return {id: label.dataset.waypointId, text: label.textContent, x, y,
          centerX: rect.x + rect.width / 2, bottom: rect.bottom, fontSize: style.fontSize,
          visible: style.visibility === 'visible', expectedVisible,
          pointerEvents: style.pointerEvents};
      });
    }""", POINTS[mode])
    assert len(labels) == 4
    for index, label in enumerate(labels):
        assert label["text"] == NAMES[index], label
        assert label["visible"] == label["expectedVisible"], label
        assert label["fontSize"] == "12px" and label["pointerEvents"] == "none", label
        if label["visible"]:
            # Grid columns can have fractional CSS sizes; renderer client sizes
            # are integer pixels, so allow less than one CSS pixel of rounding.
            assert abs(label["centerX"] - label["x"]) < 1, label
            assert abs(label["bottom"] + 10 - label["y"]) < 1, label
    assert not labels[3]["visible"], labels[3]
    return labels


def switch_mode(page, mode):
    title = "地图示教" if mode == "map" else "独立示教"
    topbar_action(page, name=f"切换到{title}", exact=True).click()
    ready(page, mode)


def run():
    errors = []
    with tempfile.TemporaryDirectory(prefix="atlas-waypoint-names-") as temporary, sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=2)
            page.set_default_timeout(30_000)
            page.on("pageerror", lambda error: errors.append(str(error)))
            seed(page)
            # Materialize normalized legacy navigation data on both sides before
            # taking the baseline used to check that display changes are inert.
            switch_mode(page, "independent")
            switch_mode(page, "map")
            original = {mode: snapshot(page, mode)["project"] for mode in POINTS}
            labels = check_projection(page, "map")
            canvas = page.locator(".three-canvas")
            path_names = page.locator('.path-name-label')
            expect(path_names).to_have_count(0)
            settings = display_settings(page)
            expect(display_settings_section(page, '路径与标注').get_by_role('button', name='显示路径名', exact=True)).to_have_attribute('aria-pressed', 'false')
            display_settings_section(page, '路径与标注').get_by_role('button', name='显示路径名', exact=True).click()
            expect(path_names).to_have_count(1)
            expect(path_names).to_have_text('停车点一 → 检修区 B')
            expect(path_names).to_have_css('visibility', 'visible')
            expect(path_names).to_have_css('pointer-events', 'none')
            page.screenshot(path='/tmp/atlas-path-names-settings.png', full_page=True)
            page.keyboard.press('Escape')
            path_transform = path_names.evaluate('el => el.style.transform')
            page.get_by_role('tab', name='路径与导航', exact=True).click()
            page.locator('.route-index__item').click()
            expect(path_names).to_have_class('path-name-label is-selected')

            # Names cannot intercept selection, and the selected name highlights.
            target = next(label for label in labels if label["visible"])
            page.mouse.click(target["x"], target["y"])
            expect(canvas).to_have_attribute("data-last-pick-id", target["id"])
            expect(page.locator(f'.waypoint-name-label[data-waypoint-id="{target["id"]}"]')).to_have_class(
                "waypoint-name-label is-selected")
            viewer_tool(page, "隐藏3D路径点").click()
            page.keyboard.press("Escape")
            expect(canvas).to_have_attribute("data-waypoints-visible", "false")
            check_projection(page, "map")
            viewer_tool(page, "显示3D路径点").click()
            page.keyboard.press("Escape")

            # Escape returns from a submenu to its parent; close the parent too
            # so camera gestures cannot land on the display-settings overlay.
            trigger = page.get_by_role('button', name='显示设置', exact=True)
            if trigger.get_attribute('aria-expanded') == 'true':
                trigger.click()
            box = canvas.bounding_box()
            x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            page.mouse.move(x, y)
            page.mouse.wheel(0, 300)
            page.wait_for_timeout(200)
            check_projection(page, "map")
            page.mouse.down()
            page.mouse.move(x + 70, y + 40, steps=8)
            page.mouse.up()
            page.wait_for_timeout(200)
            check_projection(page, "map")
            page.set_viewport_size({"width": 1024, "height": 768})
            page.wait_for_timeout(200)
            check_projection(page, "map")

            settings = display_settings(page)
            assert path_names.evaluate('el => el.style.transform') != path_transform
            expect(display_settings_section(page, '路径与标注').get_by_role('button', name='隐藏路径名', exact=True)).to_have_attribute('aria-pressed', 'true')
            display_settings_section(page, '路径与标注').get_by_role('button', name='隐藏路径名', exact=True).click()
            expect(path_names).to_have_count(0)
            expect(page.locator('.waypoint-name-label')).to_have_count(4)
            display_settings_section(page, '路径与标注').get_by_role('button', name='显示路径名', exact=True).click()
            expect(path_names).to_have_count(1)
            expect(display_settings_section(page, '路径与标注').get_by_role("button", name="隐藏停车点名")).to_have_attribute("aria-pressed", "true")
            page.screenshot(path="/tmp/atlas-waypoint-names.png", full_page=True)
            display_settings_section(page, '路径与标注').get_by_role("button", name="隐藏停车点名", exact=True).click()
            expect(page.locator(".waypoint-name-label")).to_have_count(0)
            expect(path_names).to_have_count(1)
            expect(display_settings_section(page, '路径与标注').get_by_role("button", name="显示停车点名")).to_have_attribute("aria-pressed", "false")
            expect(canvas).to_have_attribute("data-waypoints-visible", "true")
            expect(canvas).to_have_attribute("data-route-edge-count", "1")
            page.keyboard.press("Escape")

            # Each workspace remembers its choice, including reload and ZIP import.
            switch_mode(page, "independent")
            check_projection(page, "independent")
            expect(path_names).to_have_count(0)
            settings = display_settings(page)
            display_settings_section(page, '路径与标注').get_by_role('button', name='显示路径名', exact=True).click()
            expect(path_names).to_have_text('停车点一 → 检修区 B')
            page.keyboard.press('Escape')
            # This fixture's default close-up puts the route below the viewport.
            # Zoom out before checking its projected name is visible.
            if trigger.get_attribute('aria-expanded') == 'true':
                trigger.click()
            box = canvas.bounding_box()
            page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
            for _ in range(4):
                page.mouse.wheel(0, 160)
                page.wait_for_timeout(150)
            expect(path_names).to_have_css('visibility', 'visible')
            page.screenshot(path='/tmp/atlas-path-names-independent.png', full_page=True)
            settings = display_settings(page)
            display_settings_section(page, '路径与标注').get_by_role('button', name='隐藏路径名', exact=True).click()
            expect(path_names).to_have_count(0)
            page.keyboard.press('Escape')
            switch_mode(page, "map")
            expect(path_names).to_have_count(1)
            expect(page.locator(".waypoint-name-label")).to_have_count(0)
            page.reload(wait_until="networkidle")
            ready(page, "map")
            expect(page.locator(".waypoint-name-label")).to_have_count(0)
            expect(path_names).to_have_count(1)
            for mode in POINTS:
                saved = snapshot(page, mode)["project"]
                assert saved["workspace"]["showWaypointNames3D"] is (mode == "independent")
                assert saved["workspace"]["showPathNames3D"] is (mode == "map")
                assert saved["waypoints"] == original[mode]["waypoints"], (
                    mode, original[mode]["waypoints"], saved["waypoints"])
                assert saved["paths"] == original[mode]["paths"], (
                    mode, original[mode]["paths"], saved["paths"])
            with page.expect_download() as downloaded:
                start_project_download(page, "waypoint-names")
            assert read_exported_project(downloaded.value)["workspace"]["showWaypointNames3D"] is False
            assert read_exported_project(downloaded.value)["workspace"]["showPathNames3D"] is True
            archive = Path(temporary) / "waypoint-names.zip"
            downloaded.value.save_as(archive)
            imported = browser.new_page(viewport={"width": 1440, "height": 1000})
            imported.on("pageerror", lambda error: errors.append(str(error)))
            load_project(imported, "map", archive)
            expect(imported.locator(".waypoint-name-label")).to_have_count(0)
            expect(imported.locator('.path-name-label')).to_have_text('停车点一 → 检修区 B')
            display_settings_section(imported, '路径与标注').get_by_role("button", name="显示停车点名", exact=True).click()
            check_projection(imported, "map")
            assert not errors, errors
            print("Waypoint/path names: default visibility, independent toggles, camera projection, picking, both workspaces, reload and ZIP round-trip passed")
        finally:
            browser.close()


if __name__ == "__main__":
    run()
