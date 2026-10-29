import json
import math

from playwright.sync_api import expect, sync_playwright

from parking_ghost_smoke import read_robot_pose, wait_for_pose
from teaching_transfer_ui_smoke import BASE_URL, CHROME, ready, snapshot
from topbar_tools_helpers import topbar_action
from viewer_tools_helpers import viewer_tool


def seed_height_workspaces(page):
    page.goto(BASE_URL, wait_until="networkidle")
    page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
    page.evaluate("""async () => {
      const { teachingTransferFixture } = await import('/tests/teaching_transfer_helpers.mjs');
      const { buildExport } = await import('/src/features/workspace/model/io.js');
      const store = await import('/src/features/workspace/model/sessionStore.js');
      const { sessionId } = await store.fetchServiceSession();
      for (const mode of ['map', 'independent']) {
        const fixture = teachingTransferFixture(mode), project = fixture.config.config.project;
        fixture.map.portableRobotPackage.files[0].bytes = new TextEncoder().encode(`
          <robot name="height_fixture">
            <link name="base_link">
              <visual><geometry><box size="0.5 0.3 0.3"/></geometry></visual>
              <collision><geometry><box size="8 8 8"/></geometry></collision>
            </link>
            <link name="foot"><visual><geometry><box size="0.1 0.1 0.1"/></geometry></visual></link>
            <joint name="slide" type="prismatic">
              <parent link="base_link"/><child link="foot"/><origin xyz="0 0 -0.15"/>
              <axis xyz="0 0 -1"/><limit lower="0" upper="0.5" effort="1" velocity="1"/>
            </joint>
          </robot>`);
        project.robot.origin = { position: {x: 10, y: 20, z: 0}, rpy: {roll: 0, pitch: 0, yaw: 15} };
        project.robot.joints = {slide: 0.3};
        project.virtualTeaching.tasks = [];
        project.virtualTeaching.jointPoses = [];
        project.waypoints = project.waypoints.filter(point => point.source !== 'teaching-parking-point');
        project.waypoints.forEach((point, index) => {
          point.pose.z = [-4, 0, 3][index];
          point.pose.yaw = [90, -35, 150][index];
        });
        // Regenerate derived coordinate arrays and path distances after editing
        // fixture poses, so later equality checks compare consistent projects.
        fixture.config.config.project = buildExport({
          mapData: fixture.map, teachingSpaceMode: mode,
          heightRange: [project.projection.minHeight, project.projection.maxHeight],
          waypoints: project.waypoints,
          edges: project.paths.map(edge => ({...edge, status: 'unchecked'})),
          robot: project.robot, robotPose: project.robot.origin, robotJointValues: project.robot.joints,
        });
        await store.saveWorkspaceMap(sessionId, fixture.map.mapId, fixture.map.name, fixture.map, mode);
        await store.saveWorkspaceConfig(sessionId, fixture.map.mapId, fixture.config.config, mode);
      }
      await store.activateWorkspaceMode(sessionId, 'map');
    }""")
    page.goto(f"{BASE_URL}/workbench", wait_until="networkidle")
    ready(page, "map")


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True, **({"executable_path": str(CHROME)} if CHROME.exists() else {}))
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            page.set_default_timeout(30_000)
            page.on("pageerror", lambda error: errors.append(str(error)))
            seed_height_workspaces(page)
            originals = {mode: snapshot(page, mode) for mode in ["map", "independent"]}
            heights = {}
            canvas = page.locator(".three-canvas")

            for mode in ["map", "independent"]:
                if mode == "independent":
                    topbar_action(page, name="切换到独立示教", exact=True).click()
                    ready(page, mode)
                initial = read_robot_pose(canvas)
                assert math.isclose(initial["z"], 0.501, abs_tol=1e-6), initial
                assert math.isclose(float(canvas.get_attribute("data-robot-loaded-bottom-z")),
                                    0.001, abs_tol=1e-8)
                assert json.loads(canvas.get_attribute("data-robot-joint-values"))["slide"] == 0.3
                viewer_tool(page, name="定位机器人模型").click()
                expect(canvas).to_have_attribute("data-robot-control-enabled", "true")
                canvas.focus()
                page.keyboard.press("ArrowUp")
                page.wait_for_function("""initial =>
                  Number(document.querySelector('.three-canvas').dataset.robotZ) > initial + 0.001
                """, arg=initial["z"])
                # Stop keyboard control so its final pose report is flushed.
                viewer_tool(page, name="定位机器人模型").click()
                expect(canvas).to_have_attribute("data-robot-control-enabled", "false")
                raised = read_robot_pose(canvas)
                heights[mode] = raised["z"]
                page.get_by_role("tab", name="路径与导航", exact=True).click()
                arrived = page.locator('.waypoint-chips button[aria-current="location"]')
                expect(arrived).to_have_count(0)

                for index in range(3):
                    if index == 2:
                        viewer_tool(page, name="锁定机器人高度").click()
                        expect(canvas).to_have_attribute("data-robot-height-locked", "true")
                    page.get_by_label("搜索导航点", exact=True).select_option(f"wp-{index}")
                    # Browsing another point does not claim the robot arrived there.
                    page.get_by_role("button", name="返回路径与导航", exact=True).click()
                    if index:
                        expect(arrived).to_have_count(1)
                        expect(arrived).to_have_attribute("data-waypoint-id", f"wp-{index - 1}")
                    else:
                        expect(arrived).to_have_count(0)
                    page.get_by_label("搜索导航点", exact=True).select_option(f"wp-{index}")
                    page.get_by_role("button", name="运动到该点", exact=True).click()
                    wait_for_pose(page, {
                        "x": [10, 11, 30][index], "y": 20, "z": raised["z"],
                        "roll": 0, "pitch": 0, "yaw": [90, -35, 150][index],
                    })
                    assert json.loads(canvas.get_attribute("data-robot-joint-values"))["slide"] == 0.3
                    # Route Z is intentionally different from the retained base Z.
                    fields = page.locator('.property-editor input[type="number"]')
                    assert float(fields.nth(2).input_value()) == [-4, 0, 3][index]
                    page.get_by_role("button", name="返回路径与导航", exact=True).click()
                    expect(arrived).to_have_count(1)
                    expect(arrived).to_have_attribute("data-waypoint-id", f"wp-{index}")
                    expect(arrived).to_have_css("color", "rgb(244, 201, 93)")
                page.get_by_role("button", name="折叠导航点", exact=True).click()
                page.get_by_role("button", name="展开导航点", exact=True).click()
                expect(arrived).to_be_visible()
                page.screenshot(path=f"/tmp/atlas-robot-height-{mode}.png", full_page=True)
                # Camera focus animation also queues saves. Wait for the
                # debounced workspace write before exercising a hard reload.
                for _ in range(100):
                    saved = snapshot(page, mode)["project"]["robot"]["origin"]
                    if (math.isclose(saved["position"]["z"], heights[mode], abs_tol=1e-6)
                            and saved["position"]["x"] == 30 and saved["rpy"]["yaw"] == 150):
                        break
                    page.wait_for_timeout(100)
                else:
                    raise AssertionError(("Robot pose did not persist", mode, saved, heights[mode]))
                page.reload(wait_until="networkidle")
                ready(page, mode)
                wait_for_pose(page, {"z": heights[mode]})
                page.get_by_role("tab", name="路径与导航", exact=True).click()
                expect(arrived).to_have_count(1)
                expect(arrived).to_have_attribute("data-waypoint-id", "wp-2")
                assert float(canvas.get_attribute("data-robot-ground-lift")) == 0
                assert float(canvas.get_attribute("data-robot-loaded-bottom-z")) > 0

            topbar_action(page, name="切换到地图示教", exact=True).click()
            ready(page, "map")
            wait_for_pose(page, {"z": heights["map"]})
            page.get_by_role("tab", name="路径与导航", exact=True).click()
            expect(arrived).to_have_attribute("data-waypoint-id", "wp-2")
            # Actual base movement invalidates the marker without editing the route.
            viewer_tool(page, name="定位机器人模型").click()
            canvas.focus()
            page.keyboard.press("w")
            page.wait_for_function("""() => {
              const canvas = document.querySelector('.three-canvas');
              return Math.hypot(Number(canvas.dataset.robotX) - 30, Number(canvas.dataset.robotY) - 20) > 0.01;
            }""")
            viewer_tool(page, name="定位机器人模型").click()
            expect(arrived).to_have_count(0)
            assert float(canvas.get_attribute("data-robot-ground-lift")) == 0
            for mode, original in originals.items():
                final = snapshot(page, mode)
                assert final["positions"] == original["positions"]
                assert final["project"]["waypoints"] == original["project"]["waypoints"], (
                    mode, original["project"]["waypoints"], final["project"]["waypoints"])
                assert final["project"]["paths"] == original["project"]["paths"]
            assert not errors, errors
        finally:
            browser.close()
    print("PASS: both workspaces ground loaded robots and retain adjusted Z through navigation/reload/switch")
    print("PASS: arrival highlighting tracks movement, survives reload/switch, and clears on base movement")


if __name__ == "__main__":
    run()
