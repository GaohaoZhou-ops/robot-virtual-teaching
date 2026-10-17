import json
import os
import re
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from archive_helpers import start_project_download, read_exported_project
from parking_ghost_smoke import read_robot_pose
from viewer_tools_helpers import viewer_tool


ROOT = Path(__file__).resolve().parents[1]
BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")


def export_project(page):
    page.get_by_role("button", name="打开示教数据管理页", exact=True).click()
    with page.expect_download() as info:
        start_project_download(page)
    project = read_exported_project(info.value)
    page.get_by_role("button", name="返回主工作台继续示教").click()
    return project


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE") or None,
        )
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(30_000)
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(f"{BASE_URL.rstrip('/')}/workbench", wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator('input[type="file"][accept=".ply"]').set_input_files(str(ROOT / "tests/fixtures/rotation-map.ply"))
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.get_by_role("button", name="加载机器人", exact=True).click()
        page.get_by_role("option", name="加载机器人 botx_abx_zivid_m70").click()
        canvas = page.locator(".three-canvas")
        expect(canvas).to_have_attribute("data-robot-model-state", "loaded", timeout=180_000)
        map_view = page.locator("#panel-body-2d .map2d-view")
        expect(map_view).to_have_attribute("data-waypoint-count", "0")

        page.get_by_role("button", name="新建示教任务", exact=True).click()
        dialog = page.get_by_role("dialog", name="新建示教任务", exact=True)
        dialog.get_by_role("button", name="添加当前位置为停车点", exact=True).click()
        dialog.get_by_role("button", name="创建任务", exact=True).click()
        tree = page.get_by_label("示教任务与停车点树", exact=True)
        first_id = tree.get_attribute("data-active-parking-point")
        first_pose = read_robot_pose(canvas)
        page.get_by_role("button", name="记录当前机械臂姿态", exact=True).click()
        expect(page.get_by_label("虚拟示教", exact=True)).to_have_attribute("data-teaching-point-count", "1")
        original_joints = json.loads(canvas.get_attribute("data-robot-joint-values"))

        viewer_tool(page, name="定位机器人模型").click()
        page.keyboard.press("w")
        page.keyboard.press("w")
        page.wait_for_function(
            "x => Math.abs(Number(document.querySelector('.three-canvas').dataset.robotX) - x) > 0.05",
            arg=first_pose["x"],
        )
        page.get_by_role("button", name="新增停车点", exact=True).click()
        second_id = tree.get_attribute("data-active-parking-point")
        expect(map_view).to_have_attribute("data-waypoint-count", "2")
        expect(map_view).to_have_attribute("data-path-count", "0")
        expect(canvas).to_have_attribute("data-waypoint-count", "2")
        assert map_view.locator(".route-edge").count() == 0

        # The teaching tree, navigation editor and both views use the same ID.
        page.get_by_role("button", name="选择当前停车点 停车点 P01", exact=True).click()
        expect(map_view).to_have_attribute("data-selected-waypoint", first_id)
        expect(map_view).to_have_attribute("data-synchronized-focus-state", "settled")
        marker = map_view.locator(f'[data-waypoint-id="{first_id}"]')
        expect(marker).to_have_attribute("aria-pressed", "true")
        assert abs(float(map_view.get_attribute("data-view-center-x")) - first_pose["x"]) < 1e-5
        page.get_by_role("tab", name="路径与导航", exact=True).click()
        expect(page.get_by_label("导航点名称", exact=True)).to_have_value("停车点 P01")
        page.get_by_role("button", name="返回路径与导航", exact=True).click()
        expect(page.locator(".waypoint-chips button")).to_have_count(2)
        page.locator(f'.waypoint-chips [data-waypoint-id="{first_id}"]').click()
        page.get_by_label("导航点名称", exact=True).fill("联动停车点")
        page.get_by_role("button", name="修改", exact=True).click()
        x_field = page.locator(".property-editor .field-grid.three .numeric-field input").first
        new_x = first_pose["x"] + 0.35
        x_field.fill(str(new_x))
        x_field.press("Enter")
        expect(marker).to_have_attribute("title", re.compile(r"联动停车点 · X 0\.35"))
        page.wait_for_function(
            "x => Math.abs(Number(document.querySelector('.three-canvas').dataset.parkingGhostTargetPose.split(',')[0]) - x) < 1e-5",
            arg=new_x,
        )
        page.get_by_role("tab", name="示教", exact=True).click()
        expect(page.get_by_role("button", name="选择当前停车点 联动停车点", exact=True)).to_have_attribute("aria-current", "true")
        map_view.locator(f'[data-waypoint-id="{second_id}"]').click()
        expect(tree).to_have_attribute("data-active-parking-point", second_id)
        expect(page.get_by_role("button", name="选择当前停车点 停车点 P02", exact=True)).to_have_attribute("data-ghost-preview", "true")
        expect(map_view).to_have_attribute("data-selected-waypoint", second_id)
        print("parking creation, teaching/navigation/2D selection and navigation edits passed", flush=True)

        project = export_project(page)
        assert project["paths"] == []
        points = {point["id"]: point for point in project["waypoints"]}
        parking = project["virtualTeaching"]["tasks"][0]["parkingPoints"][0]
        assert set(points) == {first_id, second_id}
        assert points[first_id]["name"] == parking["name"] == "联动停车点"
        assert points[first_id]["pose"]["x"] == parking["mapPose"]["position"]["x"] == new_x
        assert parking["poses"][0]["mapPose"] == parking["mapPose"]
        assert parking["poses"][0]["fullBodyJoints"]["values"] == original_joints

        # Only an explicit connection creates a path. It survives save/reload.
        page.get_by_role("button", name="连接路径", exact=True).click()
        map_view.locator(f'[data-waypoint-id="{first_id}"]').click()
        expect(map_view).to_have_attribute("data-path-count", "0")
        map_view.locator(f'[data-waypoint-id="{second_id}"]').click()
        expect(map_view).to_have_attribute("data-path-count", "1")
        page.get_by_role("button", name="选择 / 漫游", exact=True).click()
        project = export_project(page)
        assert len(project["paths"]) == 1
        path = project["paths"][0]
        assert (path["from"], path["to"]) == (first_id, second_id)
        page.wait_for_timeout(800)
        page.reload(wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        expect(canvas).to_have_attribute("data-robot-model-state", "loaded", timeout=180_000)
        expect(map_view).to_have_attribute("data-waypoint-count", "2")
        expect(map_view).to_have_attribute("data-path-count", "1")

        # Renaming through the teaching archive updates the navigation copy too.
        page.get_by_role("button", name="打开示教数据管理页", exact=True).click()
        page.get_by_role("button", name="选择停车点 联动停车点", exact=True).click()
        name = page.get_by_role("textbox", name="停车点名称", exact=True)
        name.fill("示教同步名称")
        name.press("Enter")
        page.get_by_role("button", name="返回主工作台继续示教").click()
        page.get_by_role("button", name="选择当前停车点 示教同步名称", exact=True).click()
        page.get_by_role("tab", name="路径与导航", exact=True).click()
        expect(page.get_by_label("导航点名称", exact=True)).to_have_value("示教同步名称")
        expect(map_view).to_have_attribute("data-path-count", "1")

        # Cancelling deletion preserves the task and path; confirming removes
        # the same parking point, its recordings and the incident path together.
        page.once("dialog", lambda dialog: dialog.dismiss())
        page.get_by_role("button", name="删除导航点", exact=True).click()
        expect(map_view).to_have_attribute("data-waypoint-count", "2")
        expect(map_view).to_have_attribute("data-path-count", "1")
        page.once("dialog", lambda dialog: dialog.accept())
        page.get_by_role("button", name="删除导航点", exact=True).click()
        expect(map_view).to_have_attribute("data-waypoint-count", "1")
        expect(map_view).to_have_attribute("data-path-count", "0")
        project = export_project(page)
        assert project["paths"] == []
        assert [point["id"] for point in project["waypoints"]] == [second_id]
        assert [point["id"] for point in project["virtualTeaching"]["tasks"][0]["parkingPoints"]] == [second_id]
        page.wait_for_timeout(800)
        page.reload(wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        expect(map_view).to_have_attribute("data-waypoint-count", "1")
        expect(map_view).to_have_attribute("data-path-count", "0")
        page.screenshot(path="/tmp/atlas-teaching-navigation-linked.png", full_page=True)
        assert not errors, errors
        browser.close()
    print("explicit paths, shared export/reload, teaching rename, linked deletion and empty paths passed")


if __name__ == "__main__":
    run()
