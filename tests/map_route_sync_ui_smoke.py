import json
import re

from playwright.sync_api import expect, sync_playwright

from teaching_transfer_ui_smoke import CHROME, open_transfer, ready, seed, snapshot
from topbar_tools_helpers import topbar_action
from parking_ghost_smoke import wait_for_pose


def navigation(page):
    page.get_by_role("tab", name="路径与导航", exact=True).click()
    return page.get_by_role("region", name="地图路径同步", exact=True)


def temporary_options(page):
    return page.get_by_label("搜索导航点", exact=True).locator('option[value^="map-route-"]')


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
            card = navigation(page)
            expect(card.get_by_role("button", name="同步地图路径", exact=True)).to_be_disabled()
            expect(card).to_contain_text("建立转换关系")

            # Establish the relation through the existing placement UI, then
            # load an absolute ABX route after placement, as in the user flow.
            dialog = open_transfer(page)
            dialog.get_by_label("放置定位基准").select_option("origin")
            for axis, value in {"X": 5, "Y": -3, "Z": 1, "Roll": 0, "Pitch": 0, "Yaw": 90}.items():
                dialog.get_by_label(f"放置 {axis}", exact=True).fill(str(value))
            dialog.get_by_role("button", name="放置并进入地图", exact=True).click()
            ready(page, "map")
            expect(page.get_by_role("region", name="地图路径同步", exact=True)).to_have_count(0)
            route = {"schema_version": 1, "id": "sync-test", "name": "同步测试路径", "scene_name": "absolute-map",
                     "nodes": [{"id": 1, "label": "同步路径 A", "x_m": -15, "y_m": 7, "yaw_rad": 0},
                               {"id": 2, "label": "同步路径 B", "x_m": -15, "y_m": 8, "yaw_rad": None}],
                     "edges": [{"id": 257, "start": 1, "end": 2}]}
            with page.expect_file_chooser() as chooser:
                page.get_by_role("button", name="导入路径", exact=True).click()
            chooser.value.set_files({"name": "sync.route.json", "mimeType": "application/json",
                                     "buffer": json.dumps(route).encode()})
            page.get_by_text(re.compile("机器人路径已导入")).wait_for()
            topbar_action(page, name="切换到独立示教", exact=True).click()
            ready(page, "independent")
            absolute_before = snapshot(page, "map")
            local_before = snapshot(page, "independent")
            card = navigation(page)
            expect(card.get_by_role("button", name="同步地图路径", exact=True)).to_be_enabled()
            card.get_by_role("button", name="同步地图路径", exact=True).click()
            count = len(absolute_before["project"]["waypoints"])
            expect(temporary_options(page)).to_have_count(count)
            expect(card.get_by_role("button", name="重新同步地图路径", exact=True)).to_be_enabled()
            expect(card).to_contain_text("已转换到 VIRTUAL_ORIGIN")
            synced_id = next(option.get_attribute("value") for option in temporary_options(page).all()
                             if "N1 · 同步路径 A" in option.inner_text())
            page.get_by_label("搜索导航点", exact=True).select_option(synced_id)
            editor = page.locator(".property-editor")
            expect(editor).to_contain_text("独立模型坐标 · 临时")
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
            card.get_by_role("button", name="重新同步地图路径", exact=True).click()
            expect(temporary_options(page)).to_have_count(count)
            synced_id = next(option.get_attribute("value") for option in temporary_options(page).all()
                             if "N1 · 同步路径 A" in option.inner_text())
            page.get_by_label("搜索导航点", exact=True).select_option(synced_id)
            expect(editor.locator('input[type="number"]').nth(0)).to_have_value("10.00")
            page.set_viewport_size({"width": 1024, "height": 768})
            page.screenshot(path="/tmp/atlas-map-route-sync-compact.png", full_page=True)
            button = card.get_by_role("button", name="重新同步地图路径", exact=True)
            expect(button).to_be_in_viewport()
            panel_box = page.locator(".inspector-panel").bounding_box()
            button_box = button.bounding_box()
            assert button_box["x"] >= panel_box["x"]
            assert button_box["x"] + button_box["width"] <= panel_box["x"] + panel_box["width"]
            move_box = move_button.bounding_box()
            assert move_box["x"] + move_box["width"] <= panel_box["x"] + panel_box["width"]

            # Reload remembers the opt-in and reconstructs the transient graph
            # without requiring another click or persisting local coordinates.
            page.reload(wait_until="networkidle")
            ready(page, "independent")
            card = navigation(page)
            expect(temporary_options(page)).to_have_count(count)
            expect(card.get_by_role("button", name="重新同步地图路径", exact=True)).to_be_enabled()
            topbar_action(page, name="切换到地图示教", exact=True).click()
            ready(page, "map")
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
                topbar_action(page, name="切换到地图示教", exact=True).click()
                ready(page, "map")

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
            assert not errors, errors
            print("map_route_sync_button_prerequisites_and_loaded_placement=ok")
            print("map_route_sync_inverse_pose_edit_isolation_resync_and_automatic_restore=ok")
            print("map_route_sync_repeated_switches_and_latest_absolute_route=ok")
            print("map_route_sync_compact_layout_and_no_page_errors=ok")
            print("move_to_selected_waypoint_map_and_local_pose_heading_joint_preservation=ok")
        finally:
            browser.close()


if __name__ == "__main__":
    run()
