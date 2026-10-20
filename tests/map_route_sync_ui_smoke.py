import json
import math
import re

from playwright.sync_api import expect, sync_playwright

from teaching_transfer_ui_smoke import CHROME, open_transfer, ready, seed, snapshot
from topbar_tools_helpers import topbar_action
from parking_ghost_smoke import wait_for_pose
from viewer_tools_helpers import viewer_tool


def navigation(page):
    page.get_by_role("tab", name="路径与导航", exact=True).click()
    return page.get_by_role("group", name="路径操作", exact=True)


def temporary_options(page):
    return page.get_by_label("搜索导航点", exact=True).locator('option[value^="map-route-"]')


def check_map_origin(page):
    canvas = page.locator('.three-canvas')
    expect(canvas).to_have_attribute('data-map-origin-position', re.compile(r'^\['))
    position = json.loads(canvas.get_attribute('data-map-origin-position'))
    assert all(math.isclose(actual, expected, abs_tol=1e-10)
               for actual, expected in zip(position, [3, 5, -1])), position
    quaternion = json.loads(canvas.get_attribute('data-map-origin-quaternion'))
    assert all(math.isclose(actual, expected, abs_tol=1e-10)
               for actual, expected in zip(quaternion, [0, 0, -math.sqrt(0.5), math.sqrt(0.5)])), quaternion
    # The independent origin and its Z=0 ground must remain unchanged.
    expect(canvas).to_have_attribute('data-coordinate-origin', '0,0,0')
    expect(canvas).to_have_attribute('data-virtual-ground-z', '0')
    expect(page.locator('.map-origin-label')).to_have_count(1)


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True, **({"executable_path": str(CHROME)} if CHROME.exists() else {}))
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            page.set_default_timeout(30_000)
            page.on("pageerror", lambda error: errors.append(str(error)))
            seed(page, ["map", "independent"], "independent")
            actions = navigation(page)
            expect(page.get_by_role("group", name="路径导入导出", exact=True)).to_have_count(0)
            expect(actions.get_by_role("button", name="同步路径", exact=True)).to_be_disabled()
            expect(actions.get_by_role("button", name="同步路径", exact=True)).to_have_attribute("title", re.compile("建立转换关系"))
            expect(page.locator(".map-route-sync, .connectivity-card")).to_have_count(0)
            expect(page.locator('.map-origin-label')).to_have_count(0)

            # Establish the relation through the existing placement UI, then
            # load an absolute ABX route after placement, as in the user flow.
            dialog = open_transfer(page)
            dialog.get_by_label("放置定位基准").select_option("origin")
            for axis, value in {"X": 5, "Y": -3, "Z": 1, "Roll": 0, "Pitch": 0, "Yaw": 90}.items():
                dialog.get_by_label(f"放置 {axis}", exact=True).fill(str(value))
            dialog.get_by_role("button", name="放置并进入地图", exact=True).click()
            ready(page, "map")
            expect(page.get_by_role("button", name=re.compile("^(同步路径|重新同步)$"))).to_have_count(0)
            route = {"schema_version": 1, "id": "sync-test", "name": "同步测试路径", "scene_name": "absolute-map",
                     "nodes": [{"id": 1, "label": "同步路径 A", "x_m": -15, "y_m": 7, "yaw_rad": 0},
                               {"id": 2, "label": "同步路径 B", "x_m": -15, "y_m": 8, "yaw_rad": None}],
                     "edges": [{"id": 257, "start": 1, "end": 2}]}
            page.get_by_role("tab", name="路径与导航", exact=True).click()
            with page.expect_file_chooser() as chooser:
                page.get_by_role("button", name="导入路径", exact=True).click()
            chooser.value.set_files({"name": "sync.route.json", "mimeType": "application/json",
                                     "buffer": json.dumps(route).encode()})
            page.get_by_text(re.compile("机器人路径已导入")).wait_for()
            topbar_action(page, name="切换到独立示教", exact=True).click()
            ready(page, "independent")
            absolute_before = snapshot(page, "map")
            local_before = snapshot(page, "independent")
            actions = navigation(page)
            expect(actions.get_by_role("button", name="同步路径", exact=True)).to_be_enabled()
            expect(page.locator('.map-origin-label')).to_have_count(0)
            actions.get_by_role("button", name="同步路径", exact=True).click()
            count = len(absolute_before["project"]["waypoints"])
            expect(temporary_options(page)).to_have_count(count)
            expect(actions.get_by_role("button", name="重新同步", exact=True)).to_be_enabled()
            expect(actions.get_by_role("button", name="重新同步", exact=True)).to_have_css("color", "rgb(94, 229, 154)")
            check_map_origin(page)
            viewer_tool(page, '地图原点').click()
            page.keyboard.press('Escape')
            expect(page.locator('.map-origin-label')).to_be_visible()
            expect(page.locator('.three-canvas')).to_have_attribute('data-map-origin-screen-visible', 'true')
            page.screenshot(path='/tmp/atlas-synced-map-origin.png', full_page=True)
            path_test = actions.get_by_role("button", name="路径测试", exact=True)
            expect(path_test).to_be_enabled()
            path_test.click()
            expect(page.get_by_text(re.compile("^检测完成："))).to_be_visible()
            expect(path_test).to_have_class(re.compile("is-partial"))
            synced_id = next(option.get_attribute("value") for option in temporary_options(page).all()
                             if "N1 · 同步路径 A" in option.inner_text())
            expect(page.locator(f'.waypoint-name-label[data-waypoint-id="{synced_id}"]')).to_have_text("N1 · 同步路径 A")
            page.get_by_label("搜索导航点", exact=True).select_option(synced_id)
            editor = page.locator(".property-editor")
            inputs = editor.locator('input[type="number"]')
            values = [float(field.input_value()) for field in inputs.all()]
            assert values == [10, 20, -1, 0, 0, -90], values
            canvas = page.locator(".three-canvas")
            joints_before = json.loads(canvas.get_attribute("data-robot-joint-values"))
            height_before = float(canvas.get_attribute("data-robot-z"))
            move_button = editor.get_by_role("button", name="运动到该点", exact=True)
            expect(move_button).to_be_enabled()
            move_button.click()
            expected_pose = dict(zip(("x", "y", "z", "roll", "pitch", "yaw"), values))
            expected_pose["z"] = height_before
            wait_for_pose(page, expected_pose)
            assert json.loads(canvas.get_attribute("data-robot-joint-values")) == joints_before
            assert snapshot(page, "map") == absolute_before
            page.get_by_role("button", name="返回路径与导航", exact=True).click()
            arrived = page.locator('.waypoint-chips button[aria-current="location"]')
            expect(arrived).to_have_count(1)
            expect(arrived).to_have_attribute("data-waypoint-id", synced_id)
            page.get_by_label("搜索导航点", exact=True).select_option(synced_id)
            title_box = editor.locator("h3").bounding_box()
            move_box = move_button.bounding_box()
            assert move_box["x"] >= title_box["x"] + title_box["width"]
            assert abs((move_box["y"] + move_box["height"] / 2)
                       - (title_box["y"] + title_box["height"] / 2)) < 2
            page.screenshot(path="/tmp/atlas-map-route-sync.png", full_page=True)

            # Editing the local copy must not change absolute coordinates,
            # including autosave and later cache/transfer reads.
            inputs.nth(0).fill("42")
            inputs.nth(0).press("Tab")
            expect(inputs.nth(0)).to_have_value("42.00")
            assert page.evaluate("""async () => {
              const store = await import('/src/lib/sessionStore.js');
              const config = await store.loadWorkspaceConfig((await store.fetchServiceSession()).sessionId, 'independent');
              return config.config.ui.mapRouteSyncEnabled === true
                && !config.config.project.waypoints.some(point => point.source === 'temporary-map-route');
            }""")
            assert snapshot(page, "map") == absolute_before
            local_after = snapshot(page, "independent")["project"]
            assert local_after["waypoints"] == local_before["project"]["waypoints"]
            assert local_after["paths"] == local_before["project"]["paths"]
            assert local_after.get("abxRoutes") == local_before["project"].get("abxRoutes")

            # Repeated sync replaces copies and recomputes from the map.
            actions.get_by_role("button", name="重新同步", exact=True).click()
            expect(temporary_options(page)).to_have_count(count)
            check_map_origin(page)
            synced_id = next(option.get_attribute("value") for option in temporary_options(page).all()
                             if "N1 · 同步路径 A" in option.inner_text())
            page.get_by_label("搜索导航点", exact=True).select_option(synced_id)
            expect(editor.locator('input[type="number"]').nth(0)).to_have_value("10.00")
            page.set_viewport_size({"width": 1024, "height": 768})
            page.screenshot(path="/tmp/atlas-map-route-sync-compact.png", full_page=True)
            button = actions.get_by_role("button", name="重新同步", exact=True)
            expect(button).to_be_in_viewport()
            panel_box = page.locator(".inspector-panel").bounding_box()
            button_box = button.bounding_box()
            test_box = path_test.bounding_box()
            assert abs(button_box["y"] - test_box["y"]) < 1
            assert button_box["height"] == test_box["height"] == 32
            assert abs(button_box["width"] - test_box["width"]) < 1
            assert button_box["x"] + button_box["width"] < test_box["x"]
            assert test_box["x"] + test_box["width"] <= panel_box["x"] + panel_box["width"]
            assert button_box["x"] >= panel_box["x"]
            assert button_box["x"] + button_box["width"] <= panel_box["x"] + panel_box["width"]
            move_box = move_button.bounding_box()
            assert move_box["x"] + move_box["width"] <= panel_box["x"] + panel_box["width"]

            move_button.click()
            page.get_by_role("button", name="返回路径与导航", exact=True).click()
            expect(arrived).to_have_attribute("data-waypoint-id", synced_id)
            for _ in range(100):
                if page.evaluate("""async waypointId => {
                  const store = await import('/src/lib/sessionStore.js');
                  const { sessionId } = await store.fetchServiceSession();
                  const saved = await store.loadWorkspaceConfig(sessionId, 'independent');
                  return saved.config.ui.robotWaypointLocation?.waypointId === waypointId;
                }""", synced_id):
                    break
                page.wait_for_timeout(100)
            else:
                raise AssertionError("Arrival marker was not saved before reload")

            # Reload remembers the opt-in and reconstructs the transient graph
            # without requiring another click or persisting local coordinates.
            page.reload(wait_until="networkidle")
            ready(page, "independent")
            actions = navigation(page)
            expect(temporary_options(page)).to_have_count(count)
            check_map_origin(page)
            expect(actions.get_by_role("button", name="重新同步", exact=True)).to_be_enabled()
            if page.get_by_role("button", name="返回路径与导航", exact=True).count():
                page.get_by_role("button", name="返回路径与导航", exact=True).click()
            page.locator('.inspector-panel').screenshot(path='/tmp/atlas-synced-route-arrival.png', animations='disabled')
            expect(arrived).to_have_count(1)
            expect(arrived).to_contain_text("N1 · 同步路径 A")
            assert arrived.get_attribute("data-waypoint-id") != synced_id
            topbar_action(page, name="切换到地图示教", exact=True).click()
            ready(page, "map")
            expect(page.locator('.map-origin-label')).to_have_count(0)
            assert canvas.get_attribute('data-map-origin-position') is None
            current_map = snapshot(page, "map")["project"]
            assert current_map["waypoints"] == absolute_before["project"]["waypoints"]
            assert current_map["paths"] == absolute_before["project"]["paths"]
            assert current_map["abxRoutes"] == absolute_before["project"]["abxRoutes"]

            # Returning from the map automatically restores the route each time.
            for _ in range(2):
                topbar_action(page, name="切换到独立示教", exact=True).click()
                ready(page, "independent")
                navigation(page)
                expect(temporary_options(page)).to_have_count(count)
                check_map_origin(page)
                if page.get_by_role("button", name="返回路径与导航", exact=True).count():
                    page.get_by_role("button", name="返回路径与导航", exact=True).click()
                expect(arrived).to_have_count(1)
                expect(arrived).to_contain_text("N1 · 同步路径 A")
                topbar_action(page, name="切换到地图示教", exact=True).click()
                ready(page, "map")
                expect(page.locator('.map-origin-label')).to_have_count(0)

            # An explicit map edit must be reflected on return. Reusing stale
            # local coordinates would leave this point at X=10 instead of 12.
            page.get_by_role("tab", name="路径与导航", exact=True).click()
            page.get_by_label("搜索导航点", exact=True).select_option("abx-route:sync-test:N1")
            height_before = float(canvas.get_attribute("data-robot-z"))
            page.get_by_role("button", name="运动到该点", exact=True).click()
            wait_for_pose(page, {"x": -15, "y": 7, "z": height_before, "roll": 0, "pitch": 0, "yaw": 0})
            map_inputs = page.locator('.property-editor input[type="number"]')
            map_inputs.nth(1).fill("9")
            map_inputs.nth(1).press("Tab")
            expect(map_inputs.nth(1)).to_have_value("9.00")
            topbar_action(page, name="切换到独立示教", exact=True).click()
            ready(page, "independent")
            navigation(page)
            expect(temporary_options(page)).to_have_count(count)
            synced_id = next(option.get_attribute("value") for option in temporary_options(page).all()
                             if "N1 · 同步路径 A" in option.inner_text())
            expect(arrived).to_have_count(0)
            page.get_by_label("搜索导航点", exact=True).select_option(synced_id)
            expect(page.locator('.property-editor input[type="number"]').nth(0)).to_have_value("12.00")
            local_after = snapshot(page, "independent")["project"]
            assert local_after["waypoints"] == local_before["project"]["waypoints"]
            assert local_after["paths"] == local_before["project"]["paths"]
            updated_map = snapshot(page, "map")
            updated_point = next(point for point in updated_map["project"]["waypoints"]
                                 if point["id"] == "abx-route:sync-test:N1")
            assert updated_point["pose"]["y"] == 9
            page.reload(wait_until="networkidle")
            ready(page, "independent")
            navigation(page)
            expect(temporary_options(page)).to_have_count(count)
            assert snapshot(page, "map") == updated_map

            # Replacing the relation and syncing again replaces the reference
            # frame too. A distant origin must remain drawable and easy to frame.
            page.evaluate("""async () => {
              const store = await import('/src/lib/sessionStore.js');
              const { sessionId } = await store.fetchServiceSession();
              const config = await store.loadWorkspaceConfig(sessionId, 'map');
              config.config.project.workspace.transfer.localToMap = {
                position: { x: 10000, y: -20000, z: 50 }, rpy: { roll: 0, pitch: 0, yaw: 0 }
              };
              await store.saveWorkspaceConfig(sessionId, config.mapId, config.config, 'map');
            }""")
            navigation(page).get_by_role('button', name='重新同步', exact=True).click()
            expect(canvas).to_have_attribute('data-map-origin-position', '[-10000,20000,-50]')
            viewer_tool(page, '地图原点').click()
            page.keyboard.press('Escape')
            expect(canvas).to_have_attribute('data-map-origin-screen-visible', 'true')
            expect(page.locator('.map-origin-label')).to_be_visible()
            camera_position = [float(canvas.get_attribute(f'data-camera-{axis}')) for axis in 'xyz']
            origin_distance = math.dist(camera_position, [-10000, 20000, -50])
            assert float(canvas.get_attribute('data-camera-far')) > origin_distance
            page.screenshot(path='/tmp/atlas-synced-map-origin-distant.png', full_page=True)
            distant_map = snapshot(page, 'map')
            for key in ('waypoints', 'paths', 'abxRoutes'):
                assert distant_map['project'][key] == updated_map['project'][key]
            assert distant_map['positions'] == updated_map['positions']
            expect(page.locator('.map-origin-label')).to_have_count(1)
            assert not errors, errors
            print("map_route_sync_button_prerequisites_and_loaded_placement=ok")
            print("map_route_sync_inverse_pose_edit_isolation_resync_and_automatic_restore=ok")
            print("map_route_sync_repeated_switches_and_latest_absolute_route=ok")
            print("map_route_sync_compact_layout_and_no_page_errors=ok")
            print("move_to_selected_waypoint_map_and_local_pose_heading_joint_preservation=ok")
            print("synced_route_arrival_highlight_reload_switch_and_changed_point=ok")
            print("synced_map_origin_frame_focus_resync_reload_switch_and_isolation=ok")
            print("synced_map_origin_replaced_relation_distant_clipping_and_framing=ok")
        finally:
            browser.close()


if __name__ == "__main__":
    run()
