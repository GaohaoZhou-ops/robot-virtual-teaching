import json
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from archive_helpers import read_exported_project
from chassis_drag_smoke import read_camera
from parking_ghost_smoke import read_robot_pose, wait_for_pose
from teaching_capture_pose_ghost_smoke import capture, set_joints
from viewer_tools_helpers import viewer_tool


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
ROOT = Path(__file__).resolve().parents[1]


def ghost_pose(canvas):
    return dict(zip(
        ("x", "y", "z", "roll", "pitch", "yaw"),
        map(float, canvas.get_attribute("data-parking-ghost-target-pose").split(",")),
    ))


def assert_map_pose(actual, expected):
    for name in ("x", "y", "z"):
        assert abs(actual["position"][name] - expected[name]) < 1e-5
    for name in ("roll", "pitch", "yaw"):
        assert abs(actual["rpy"][name] - expected[name]) < 1e-5


def begin_edit(page, canvas, card):
    card.get_by_role("button", name="修改停车点", exact=True).click()
    expect(card).to_have_attribute("data-parking-edit-state", "editing")
    expect(card.get_by_role("button", name="录入新位置", exact=True)).to_have_attribute("aria-pressed", "true")
    expect(canvas).to_have_attribute("data-robot-control-enabled", "true")
    expect(canvas).to_have_attribute("data-keyboard-control-owner", "robot")
    expect(canvas).to_have_attribute("data-chassis-drag-mode", "idle")
    expect(canvas).to_be_focused()
    page.wait_for_function("document.querySelector('.three-canvas').dataset.synchronizedFocusState === 'settled'")
    assert canvas.get_attribute("data-parking-ghost-state") == "visible"
    expect(viewer_tool(page, name="定位机器人模型")).to_have_attribute("aria-pressed", "true")
    page.get_by_role("button", name="视图工具", exact=True).click()


def move_with_frozen_ghost(page, canvas, keys=("w", "a", "s", "d", "w", "w", "ArrowLeft")):
    original_ghost = canvas.get_attribute("data-parking-ghost-target-pose")
    original_joints = canvas.get_attribute("data-parking-ghost-joint-values")
    before = read_robot_pose(canvas)
    camera_before = read_camera(canvas)
    for key in keys:
        previous = read_robot_pose(canvas)
        page.keyboard.press(key)
        page.wait_for_function(
            "pose => ['x', 'y', 'yaw'].some(axis => Math.abs(Number(document.querySelector('.three-canvas').getAttribute(`data-robot-${axis}`)) - pose[axis]) > 1e-5)",
            arg=previous,
        )
        assert canvas.get_attribute("data-parking-ghost-state") == "visible"
        assert canvas.get_attribute("data-parking-ghost-target-pose") == original_ghost
        assert canvas.get_attribute("data-parking-ghost-joint-values") == original_joints
    after = read_robot_pose(canvas)
    assert abs(after["x"] - before["x"]) + abs(after["y"] - before["y"]) > 0.02
    for name in ("z", "roll", "pitch"):
        assert abs(after[name] - before[name]) < 1e-6
    assert read_camera(canvas) == camera_before
    return after


def expect_control_released(canvas):
    expect(canvas).to_have_attribute("data-robot-control-enabled", "false")
    expect(canvas).to_have_attribute("data-keyboard-control-owner", "camera")
    expect(canvas).to_have_attribute("data-chassis-drag-mode", "idle")


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
        first_stop = tree.get_by_role("button", name="选择当前停车点 停车点 P01", exact=True)
        first_stop.wait_for()
        task_id = tree.get_attribute("data-active-task")
        parking_id = tree.get_attribute("data-active-parking-point")
        first_pose = read_robot_pose(canvas)
        recorded_joints = []
        for count, right, left in ((1, 35, -22), (2, -18, 26)):
            set_joints(page, right, left)
            recorded_joints.append(json.loads(canvas.get_attribute("data-robot-joint-values")))
            capture(page, count)

        viewer_tool(page, name="定位机器人模型").click()
        page.keyboard.press("w")
        page.keyboard.press("w")
        page.wait_for_function("x => Math.abs(Number(document.querySelector('.three-canvas').dataset.robotX) - x) > 0.05", arg=first_pose["x"])
        second_pose = read_robot_pose(canvas)
        page.get_by_role("button", name="新增停车点", exact=True).click()
        second_stop = tree.get_by_role("button", name="选择当前停车点 停车点 P02", exact=True)
        first_stop.click()
        card = page.get_by_label("停车点机器人虚影", exact=True)
        edit_box = card.get_by_role("button", name="修改停车点", exact=True).bounding_box()
        move_box = card.get_by_role("button", name="移动到当前停车点", exact=True).bounding_box()
        assert edit_box["x"] + edit_box["width"] < move_box["x"]
        height_before = card.bounding_box()["height"]

        begin_edit(page, canvas, card)
        wait_for_pose(page, first_pose)
        assert ghost_pose(canvas) == first_pose
        assert card.bounding_box()["height"] == height_before
        moved = move_with_frozen_ghost(page, canvas)
        assert ghost_pose(canvas) == first_pose
        assert json.loads(canvas.get_attribute("data-robot-joint-values")) == recorded_joints[-1]
        page.screenshot(path="/tmp/atlas-parking-position-edit-keyboard.png", full_page=True)

        # Commit immediately after keyboard movement: use the latest canvas pose.
        card.get_by_role("button", name="录入新位置", exact=True).click()
        expect(card).to_have_attribute("data-parking-edit-state", "idle")
        expect_control_released(canvas)
        page.wait_for_function(
            "target => document.querySelector('.three-canvas').dataset.parkingGhostTargetPose.split(',').every((v, i) => Math.abs(Number(v) - target[i]) < 1e-5)",
            arg=list(moved.values()),
        )
        assert card.is_visible()
        assert canvas.get_attribute("data-parking-ghost-state") == "visible"
        assert card.bounding_box()["height"] == height_before
        assert read_robot_pose(canvas) == moved
        expect(tree).to_have_attribute("data-active-task", task_id)
        expect(tree).to_have_attribute("data-active-parking-point", parking_id)
        page.keyboard.press("Escape")
        expect(card).to_have_count(0)
        expect(canvas).to_have_attribute("data-parking-ghost-state", "hidden")
        wait_for_pose(page, moved)
        first_stop.click()
        expect(card).to_be_visible()
        print("WASD and turn keys moved the robot with a fixed ghost; new position recorded", flush=True)

        # Escape cancels even while a movement key is held, restoring the saved
        # pose and clearing pending input so the robot cannot keep moving.
        begin_edit(page, canvas, card)
        move_with_frozen_ghost(page, canvas, keys=("a", "ArrowRight"))
        before_held_key = read_robot_pose(canvas)
        page.keyboard.down("w")
        page.wait_for_function(
            "pose => Math.abs(Number(document.querySelector('.three-canvas').dataset.robotX) - pose.x) + Math.abs(Number(document.querySelector('.three-canvas').dataset.robotY) - pose.y) > 0.02",
            arg=before_held_key,
        )
        page.keyboard.press("Escape")
        expect(card).to_have_attribute("data-parking-edit-state", "idle")
        expect(card.get_by_role("button", name="修改停车点", exact=True)).to_be_visible()
        expect_control_released(canvas)
        wait_for_pose(page, moved)
        page.wait_for_timeout(150)
        assert all(abs(read_robot_pose(canvas)[axis] - moved[axis]) < 1e-5 for axis in moved)
        page.keyboard.up("w")
        assert canvas.get_attribute("data-parking-ghost-state") == "visible"
        assert all(abs(ghost_pose(canvas)[axis] - moved[axis]) < 1e-5 for axis in moved)
        expect(viewer_tool(page, name="定位机器人模型")).to_have_attribute("aria-pressed", "false")
        page.get_by_role("button", name="视图工具", exact=True).click()
        print("Escape restored the saved position, kept the ghost and released keyboard control", flush=True)

        # Switching nodes cancels an unrecorded edit and releases keyboard control.
        begin_edit(page, canvas, card)
        move_with_frozen_ghost(page, canvas, keys=("w", "d"))
        second_stop.click()
        expect(card).to_have_attribute("data-parking-edit-state", "idle")
        expect_control_released(canvas)
        first_stop.click()
        expect(first_stop).to_have_attribute("aria-expanded", "true")
        assert all(abs(ghost_pose(canvas)[axis] - moved[axis]) < 1e-5 for axis in moved)

        # Pose previews keep their own action, without the parking edit button.
        pose_node = tree.get_by_role("treeitem", name="预览机械臂姿态 A01", exact=True)
        pose_node.click()
        assert card.get_by_role("button", name="修改停车点", exact=True).count() == 0
        assert card.get_by_role("button", name="使用当前姿态", exact=True).is_enabled()
        assert card.bounding_box()["height"] == height_before
        print("unrecorded edit cancelled; pose action and card height preserved", flush=True)

        # Editing during looping playback stops playback before enabling WASD.
        page.get_by_role("button", name="打开示教数据管理页").click()
        page.get_by_role("button", name="选择示教任务 示教任务 01", exact=True).click()
        page.get_by_role("button", name="播放示教任务 示教任务 01", exact=True).click()
        dock = page.get_by_label("示教任务轨迹播放控制", exact=True)
        expect(dock).to_have_attribute("data-playback-status", "playing")
        wait_for_pose(page, moved)
        first_stop.click()
        begin_edit(page, canvas, card)
        dock.wait_for(state="detached")
        assert canvas.get_attribute("data-robot-trajectory-active") == "false"
        card.get_by_role("button", name="清除停车点机器人虚影", exact=True).click()
        card.wait_for(state="detached")
        expect_control_released(canvas)

        # The archive keeps IDs, joints and captured frames while using the new
        # parking pose for every bound pose. Other stops remain unchanged.
        page.get_by_role("button", name="打开示教数据管理页").click()
        with page.expect_download() as download_info:
            page.get_by_role("button", name="导出示教工程 ZIP", exact=True).click()
        exported = read_exported_project(download_info.value)
        task = next(task for task in exported["virtualTeaching"]["tasks"] if task["id"] == task_id)
        parking = next(point for point in task["parkingPoints"] if point["id"] == parking_id)
        assert_map_pose(parking["mapPose"], moved)
        assert len(parking["poses"]) == 2
        for index, pose in enumerate(parking["poses"]):
            assert_map_pose(pose["mapPose"], moved)
            assert pose["fullBodyJoints"]["values"] == recorded_joints[index]
            assert set(pose["cameraCapture"]["frames"]) == {"left", "right"}
        assert_map_pose(task["parkingPoints"][1]["mapPose"], second_pose)
        assert not errors, errors
        browser.close()

    print("parking edit: automatic keyboard control, frozen ghost, commit, Escape, bound poses, playback and export passed")


if __name__ == "__main__":
    run()
