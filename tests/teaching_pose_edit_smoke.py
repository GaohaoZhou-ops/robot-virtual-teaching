import json
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from archive_helpers import read_exported_project
from end_effector_control_smoke import double_click_tool, number_attr
from parking_ghost_smoke import read_robot_pose, wait_for_pose
from parking_position_edit_smoke import assert_map_pose
from teaching_capture_pose_ghost_smoke import capture, set_joints
from viewer_tools_helpers import viewer_tool


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
ROOT = Path(__file__).resolve().parents[1]


def joints(canvas):
    return json.loads(canvas.get_attribute("data-robot-joint-values"))


def wait_for_joints(page, expected):
    page.wait_for_function(
        """expected => {
          const values = JSON.parse(document.querySelector('.three-canvas').dataset.robotJointValues);
          return Object.keys(values).length === Object.keys(expected).length
            && Object.entries(expected).every(([name, value]) => Math.abs(values[name] - value) < 1e-6);
        }""",
        arg=expected,
    )


def export_task(page, task_id):
    page.get_by_role("button", name="打开示教数据管理页").click()
    with page.expect_download() as download_info:
        page.get_by_role("button", name="导出示教工程 ZIP", exact=True).click()
    project = read_exported_project(download_info.value)
    task = next(task for task in project["virtualTeaching"]["tasks"] if task["id"] == task_id)
    page.get_by_role("button", name="返回主工作台继续示教").click()
    return task


def begin_edit(page, canvas, card, pose, saved_joints):
    card.get_by_role("button", name="调整姿态", exact=True).click()
    expect(card).to_have_attribute("data-pose-edit-state", "editing")
    expect(card.get_by_role("button", name="确认修改", exact=True)).to_have_attribute("aria-pressed", "true")
    expect(page.get_by_role("dialog", name="全关节控制浮动窗口")).to_be_visible()
    expect(canvas).to_have_attribute("data-robot-control-enabled", "false")
    expect(canvas).to_have_attribute("data-chassis-drag-mode", "idle")
    wait_for_pose(page, pose)
    wait_for_joints(page, saved_joints)
    assert json.loads(canvas.get_attribute("data-parking-ghost-joint-values")) == saved_joints
    page.wait_for_function("document.querySelector('.three-canvas').dataset.synchronizedFocusState === 'settled'")
    # The automatically opened joint window must leave all preview actions reachable.
    for name in ("确认修改", "使用当前姿态", "清除停车点机器人虚影"):
        access = card.get_by_role("button", name=name, exact=True).evaluate(
            """button => {
              const box = button.getBoundingClientRect();
              const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
              return { reachable: button.contains(target), box: box.toJSON(), target: target?.outerHTML };
            }"""
        )
        if not access["reachable"]:
            page.screenshot(path="/tmp/atlas-teaching-pose-edit-blocked.png", full_page=True)
        assert access["reachable"], access


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
        page.wait_for_function("document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'", timeout=180_000)

        page.get_by_role("button", name="新建示教任务", exact=True).click()
        dialog = page.get_by_role("dialog", name="新建示教任务")
        dialog.get_by_role("button", name="添加当前位置为停车点").click()
        dialog.get_by_role("button", name="创建任务", exact=True).click()
        tree = page.get_by_label("示教任务与停车点树", exact=True)
        stop = tree.get_by_role("button", name="选择当前停车点 停车点 P01", exact=True)
        stop.wait_for()
        task_id = tree.get_attribute("data-active-task")
        parking_pose = read_robot_pose(canvas)
        for count, right, left in ((1, 35, -22), (2, -18, 26)):
            set_joints(page, right, left)
            capture(page, count)
        baseline = export_task(page, task_id)
        original, sibling = baseline["parkingPoints"][0]["poses"]
        original_joints = original["fullBodyJoints"]["values"]

        # Start away from the selected pose; editing restores its parent and joints.
        viewer_tool(page, name="定位机器人模型").click()
        page.keyboard.press("w")
        page.wait_for_function("x => Math.abs(Number(document.querySelector('.three-canvas').dataset.robotX) - x) > 0.01", arg=parking_pose["x"])
        nodes = tree.get_by_role("group", name="停车点 P01 的姿态", exact=True)
        first = nodes.get_by_role("treeitem", name="预览机械臂姿态 A01", exact=True)
        second = nodes.get_by_role("treeitem", name="预览机械臂姿态 A02", exact=True)
        first.click()
        card = page.get_by_label("停车点机器人虚影", exact=True)
        height = card.bounding_box()["height"]
        assert card.get_by_role("button", name="使用当前姿态", exact=True).is_enabled()
        begin_edit(page, canvas, card, parking_pose, original_joints)
        assert card.bounding_box()["height"] == height

        # Confirm directly from a dirty input (blur commit), without another Enter.
        right = page.get_by_role("spinbutton", name="right_J1 关节值", exact=True)
        right.fill("48")
        page.screenshot(path="/tmp/atlas-teaching-pose-edit.png", full_page=True)
        card.get_by_role("button", name="确认修改", exact=True).click()
        expect(card).to_have_attribute("data-pose-edit-state", "idle")
        expect(page.get_by_role("dialog", name="全关节控制浮动窗口")).to_have_count(0)
        expected = {**original_joints, "right_J1": 48}
        wait_for_joints(page, expected)
        expected = joints(canvas)
        page.wait_for_function(
            "Math.abs(JSON.parse(document.querySelector('.three-canvas').dataset.parkingGhostJointValues).right_J1 - 48) < 1e-6",
            timeout=5_000,
        )
        assert json.loads(canvas.get_attribute("data-parking-ghost-joint-values")) == expected
        assert card.bounding_box()["height"] == height
        assert nodes.get_by_role("treeitem").count() == 2
        saved = export_task(page, task_id)
        parking = saved["parkingPoints"][0]
        edited = parking["poses"][0]
        assert parking["mapPose"] == baseline["parkingPoints"][0]["mapPose"]
        assert parking["poses"][1] == sibling
        assert (edited["id"], edited["name"], edited["sequence"]) == (original["id"], original["name"], original["sequence"])
        assert edited["fullBodyJoints"]["values"] == expected
        assert_map_pose(edited["mapPose"], parking_pose)
        assert edited["capturedAt"] != original["capturedAt"]
        assert set(edited["cameraCapture"]["frames"]) == {"left", "right"}
        assert edited["cameraCapture"]["capturedAt"] != original["cameraCapture"]["capturedAt"]
        assert edited["cameraCapture"]["frames"]["right"]["opticalPose"] != original["cameraCapture"]["frames"]["right"]["opticalPose"]
        print("confirmed latest joint values, replaced only the selected pose and refreshed camera snapshots", flush=True)

        # Escape also works while a joint input has focus, restoring saved joints.
        begin_edit(page, canvas, card, parking_pose, expected)
        field = page.get_by_role("spinbutton", name="right_J1 关节值", exact=True)
        field.fill("12")
        field.press("Enter")
        wait_for_joints(page, {**expected, "right_J1": 12})
        field.focus()
        field.press("Escape")
        expect(card).to_have_attribute("data-pose-edit-state", "idle")
        wait_for_joints(page, expected)
        assert export_task(page, task_id) == saved

        # A new selection discards unconfirmed edits and still previews its own pose.
        begin_edit(page, canvas, card, parking_pose, expected)
        field = page.get_by_role("spinbutton", name="left_J1 关节值", exact=True)
        field.fill("5")
        field.press("Enter")
        page.get_by_role("button", name="关闭全关节浮动窗口").click()
        second.click()
        expect(card).to_have_attribute("data-pose-edit-state", "idle")
        assert json.loads(canvas.get_attribute("data-parking-ghost-joint-values")) == sibling["fullBodyJoints"]["values"]
        assert export_task(page, task_id) == saved

        # Edit also stops looping playback and permits the existing IK controls.
        page.get_by_role("button", name="打开示教数据管理页").click()
        page.get_by_role("button", name="选择示教任务 示教任务 01", exact=True).click()
        page.get_by_role("button", name="播放示教任务 示教任务 01", exact=True).click()
        dock = page.get_by_label("示教任务轨迹播放控制", exact=True)
        expect(dock).to_have_attribute("data-playback-status", "playing")
        first.click()
        begin_edit(page, canvas, card, parking_pose, expected)
        dock.wait_for(state="detached")
        page.get_by_role("button", name="关闭全关节浮动窗口").click()
        expect(viewer_tool(page, name="定位机器人模型")).to_be_disabled()
        expect(viewer_tool(page, name="拖动底盘")).to_be_disabled()
        page.get_by_role("button", name="视图工具", exact=True).click()
        double_click_tool(page, canvas, "left")
        expect(canvas).to_have_attribute("data-end-effector-control-state", "active")
        target = number_attr(canvas, "end-effector-target-x") + 0.015
        field = page.get_by_role("spinbutton", name="末端 X (m)")
        field.fill(str(target))
        field.press("Enter")
        page.wait_for_function("Number(document.querySelector('.three-canvas').dataset.endEffectorSolveCount) > 0")
        ik_joints = joints(canvas)
        assert ik_joints != expected
        assert read_robot_pose(canvas) == parking_pose
        # Cancel only the nested IK adjustment; the teaching pose edit stays open.
        field.focus()
        page.keyboard.down("Escape")
        expect(canvas).to_have_attribute("data-end-effector-control-state", "idle")
        expect(card).to_have_attribute("data-pose-edit-state", "editing")
        wait_for_joints(page, expected)
        page.keyboard.down("Escape")  # Holding Escape must not cancel the outer edit.
        page.keyboard.up("Escape")
        expect(card).to_have_attribute("data-pose-edit-state", "editing")
        double_click_tool(page, canvas, "left")
        expect(canvas).to_have_attribute("data-end-effector-control-state", "active")
        field.fill(str(target))
        field.press("Enter")
        ik_joints = joints(canvas)
        assert ik_joints != expected
        card.get_by_role("button", name="确认修改", exact=True).click()
        expect(card).to_have_attribute("data-pose-edit-state", "idle")
        expect(canvas).to_have_attribute("data-end-effector-control-state", "idle")
        wait_for_joints(page, ik_joints)
        final_task = export_task(page, task_id)
        assert final_task["parkingPoints"][0]["poses"][0]["fullBodyJoints"]["values"] == ik_joints
        assert final_task["parkingPoints"][0]["poses"][1] == sibling
        print("Escape, selection changes, playback stop and saving IK adjustments passed", flush=True)

        # Keep the existing parking action and an accessible short card on small screens.
        page.set_viewport_size({"width": 980, "height": 640})
        begin_edit(page, canvas, card, parking_pose, ik_joints)
        page.screenshot(path="/tmp/atlas-teaching-pose-edit-compact.png", full_page=True)
        canvas.focus()
        page.keyboard.press("Escape")
        stop.click()
        assert card.get_by_role("button", name="修改停车点", exact=True).is_enabled()
        assert card.get_by_role("button", name="移动到当前停车点", exact=True).is_enabled()
        assert card.get_by_role("button", name="调整姿态", exact=True).count() == 0
        assert card.bounding_box()["height"] == height
        assert not errors, errors
        browser.close()

    print("teaching pose edit: restore, frozen preview, confirm, snapshots, cancel, IK, persistence and layout passed")


if __name__ == "__main__":
    run()
