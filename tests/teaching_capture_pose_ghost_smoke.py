from topbar_tools_helpers import topbar_action

import json
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from parking_ghost_smoke import read_robot_pose, wait_for_pose
from viewer_tools_helpers import viewer_tool


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
ROOT = Path(__file__).resolve().parents[1]


def set_joints(page, right, left):
    page.get_by_role("button", name="打开全关节浮动窗口").click()
    for name, value in (("right_J1", right), ("left_J1", left)):
        field = page.get_by_role("spinbutton", name=f"{name} 关节值")
        field.fill(str(value))
        field.press("Enter")
    page.get_by_role("button", name="关闭全关节浮动窗口").click()
    page.wait_for_function(
        """expected => {
          const values = JSON.parse(document.querySelector('.three-canvas').dataset.robotJointValues);
          return Object.entries(expected).every(([name, value]) => Math.abs(values[name] - value) < 1e-6);
        }""",
        arg={"right_J1": right, "left_J1": left},
    )


def capture(page, count, allow_drift=False):
    page.get_by_role("button", name="记录当前姿态", exact=True).click()
    if allow_drift:
        page.get_by_role("dialog", name="底盘已移动").get_by_role(
            "button", name="仍记录到当前停车点", exact=True
        ).click()
    page.wait_for_function(
        "count => Number(document.querySelector('[aria-label=\"虚拟示教\"]').dataset.teachingPointCount) === count",
        arg=count,
    )


def assert_preview(page, canvas, node, pose, joints, live_pose, live_joints):
    node.click()
    pose_id = node.get_attribute("data-pose-id")
    page.wait_for_function(
        """id => {
          const data = document.querySelector('.three-canvas').dataset;
          return data.parkingGhostState === 'visible' && data.parkingGhostPoseId === id;
        }""",
        arg=pose_id,
    )
    assert json.loads(canvas.get_attribute("data-parking-ghost-joint-values")) == joints
    target = [float(value) for value in canvas.get_attribute("data-parking-ghost-target-pose").split(",")]
    assert all(abs(actual - expected) < 1e-6 for actual, expected in zip(target, pose.values()))
    assert read_robot_pose(canvas) == live_pose
    assert json.loads(canvas.get_attribute("data-robot-joint-values")) == live_joints
    expect(node).to_have_attribute("aria-selected", "true")
    assert page.locator('.teaching-capture-tree__pose-item[data-ghost-preview="true"]').count() == 1
    expect(page.get_by_label("停车点机器人虚影", exact=True)).to_have_count(0)
    panel = page.get_by_label("虚拟示教", exact=True)
    expect(panel.get_by_role("button", name="导航并执行", exact=True)).to_be_enabled()
    expect(panel.get_by_role("button", name="仅执行上身", exact=True)).to_be_enabled()
    assert int(canvas.get_attribute("data-parking-ghost-mesh-count")) > 0


def apply_preview(page, canvas, parking_pose, joint_values):
    page.get_by_label("虚拟示教", exact=True).get_by_role("button", name="导航并执行", exact=True).click()
    expect(page.get_by_label("停车点机器人虚影", exact=True)).to_have_count(0)
    wait_for_pose(page, parking_pose)
    page.wait_for_function(
        """expected => {
          const values = JSON.parse(document.querySelector('.three-canvas').dataset.robotJointValues);
          return Object.keys(values).length === Object.keys(expected).length
            && Object.entries(expected).every(([name, value]) => Math.abs(values[name] - value) < 1e-6);
        }""",
        arg=joint_values,
    )
    page.wait_for_function("document.querySelector('.three-canvas').dataset.parkingGhostState === 'hidden'")
    assert page.locator('.teaching-capture-tree__pose-item[data-ghost-preview="true"]').count() == 0
    assert page.get_by_role("button", name="记录当前姿态", exact=True).is_enabled()
    assert canvas.get_attribute("data-synchronized-focus-type") == "robot"


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE") or None,
        )
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(180_000)
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(f"{BASE_URL.rstrip('/')}/workbench", wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator('input[type="file"][accept=".ply"]').set_input_files(
            str(ROOT / "tests/fixtures/rotation-map.ply")
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        topbar_action(page, name="加载机器人", exact=True).click()
        page.get_by_role("option", name="加载机器人 botx_abx_zivid_m70").click()
        canvas = page.locator(".three-canvas")
        page.wait_for_function("document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'")

        page.get_by_role("button", name="新建示教任务", exact=True).click()
        dialog = page.get_by_role("dialog", name="新建示教任务")
        dialog.get_by_role("button", name="添加当前位置为停车点").click()
        dialog.get_by_role("button", name="创建任务", exact=True).click()
        tree = page.get_by_label("示教任务与停车点树", exact=True)
        first_stop = tree.get_by_role("button", name="选择当前停车点 停车点 P01", exact=True)
        first_stop.wait_for()
        original_task = tree.get_attribute("data-active-task")
        first_parking_id = tree.get_attribute("data-active-parking-point")

        set_joints(page, 35, -22)
        first_pose = read_robot_pose(canvas)
        first_joints = json.loads(canvas.get_attribute("data-robot-joint-values"))
        capture(page, 1)

        # Save a second pose at a different base position under the same stop.
        set_joints(page, -18, 26)
        viewer_tool(page, name="定位机器人模型").click()
        page.keyboard.press("w")
        page.keyboard.press("w")
        page.keyboard.press("ArrowLeft")
        page.wait_for_function(
            "x => Math.abs(Number(document.querySelector('.three-canvas').dataset.robotX) - x) > 0.05",
            arg=first_pose["x"],
        )
        second_pose = read_robot_pose(canvas)
        second_joints = json.loads(canvas.get_attribute("data-robot-joint-values"))
        capture(page, 2, allow_drift=True)
        assert first_pose != second_pose and first_joints != second_joints
        print("captured two distinct archived poses", flush=True)

        # An empty stop still expands, and selecting another stop opens its poses.
        page.get_by_role("button", name="新增停车点", exact=True).click()
        empty_stop = tree.get_by_role("button", name="选择当前停车点 停车点 P02", exact=True)
        expect(empty_stop).to_have_attribute("aria-expanded", "true")
        assert tree.get_by_text("暂无姿态，可记录当前姿态", exact=True).is_visible()
        set_joints(page, 8, -5)
        live_pose = read_robot_pose(canvas)
        live_joints = json.loads(canvas.get_attribute("data-robot-joint-values"))
        first_stop.click()
        expect(first_stop).to_have_attribute("aria-expanded", "true")
        pose_group = tree.get_by_role("group", name="停车点 P01 的姿态", exact=True)
        assert pose_group.get_by_role("treeitem").count() == 2
        first_stop.click()
        expect(first_stop).to_have_attribute("aria-expanded", "false")
        assert pose_group.count() == 0
        first_stop.click()
        expect(first_stop).to_have_attribute("aria-expanded", "true")

        first_node = pose_group.get_by_role("treeitem", name="预览机械臂姿态 A01", exact=True)
        second_node = pose_group.get_by_role("treeitem", name="预览机械臂姿态 A02", exact=True)
        assert_preview(page, canvas, first_node, first_pose, first_joints, live_pose, live_joints)
        # Both archived poses are bound to P01, including the one captured after drift.
        assert_preview(page, canvas, second_node, first_pose, second_joints, live_pose, live_joints)
        expect(first_node).to_have_attribute("aria-selected", "false")
        card = page.get_by_label("停车点机器人虚影", exact=True)
        expect(card).to_have_count(0)
        page.wait_for_function("document.querySelector('.three-canvas').dataset.synchronizedFocusState === 'settled'")
        page.screenshot(path="/tmp/atlas-teaching-capture-pose-ghost.png", full_page=True)

        # Escape from a pose in the teaching tree clears both the 3D ghost and
        # its tree highlight, without applying the archived pose to the robot.
        second_node.focus()
        page.keyboard.press("Escape")
        card.wait_for(state="detached")
        expect(second_node).to_have_attribute("aria-selected", "false")
        expect(canvas).to_have_attribute("data-parking-ghost-state", "hidden")
        page.wait_for_function("document.querySelector('.three-canvas').dataset.parkingGhostPoseId === ''")
        assert read_robot_pose(canvas) == live_pose
        assert json.loads(canvas.get_attribute("data-robot-joint-values")) == live_joints

        # Selecting the parent keeps its ghost without the action card. Selecting
        # a pose again applies its joints and the owning stop in a single click.
        assert_preview(page, canvas, second_node, first_pose, second_joints, live_pose, live_joints)
        first_stop.click()
        expect(card).to_have_count(0)
        expect(canvas).to_have_attribute("data-parking-ghost-state", "visible")
        expect(canvas).to_have_attribute("data-parking-ghost-pose-id", "")
        assert read_robot_pose(canvas) == live_pose
        assert json.loads(canvas.get_attribute("data-robot-joint-values")) == live_joints
        first_stop.click()
        assert_preview(page, canvas, second_node, first_pose, second_joints, live_pose, live_joints)
        apply_preview(page, canvas, first_pose, second_joints)
        expect(tree).to_have_attribute("data-active-task", original_task)
        expect(tree).to_have_attribute("data-active-parking-point", first_parking_id)
        live_pose = read_robot_pose(canvas)
        live_joints = json.loads(canvas.get_attribute("data-robot-joint-values"))

        # A pose in an inactive task selects its own task and parent stop.
        page.get_by_role("button", name="新建示教任务", exact=True).click()
        page.get_by_role("dialog", name="新建示教任务").get_by_role("button", name="创建任务", exact=True).click()
        assert tree.get_attribute("data-active-task") != original_task
        first_node.focus()
        first_node.press("Enter")
        expect(tree).to_have_attribute("data-active-task", original_task)
        expect(tree).to_have_attribute("data-active-parking-point", first_parking_id)
        expect(first_node).to_have_attribute("aria-selected", "true")
        assert read_robot_pose(canvas) == live_pose
        assert json.loads(canvas.get_attribute("data-robot-joint-values")) == live_joints

        # Using a selected pose also stops playback, so later frames cannot
        # overwrite the requested parking position or joint configuration.
        topbar_action(page, name="打开示教数据管理页").click()
        page.get_by_role("button", name="选择示教任务 示教任务 01", exact=True).click()
        page.get_by_role("button", name="播放示教任务 示教任务 01", exact=True).click()
        dock = page.get_by_label("示教任务轨迹播放控制", exact=True)
        expect(dock).to_have_attribute("data-playback-status", "playing")
        second_node.click()
        apply_preview(page, canvas, first_pose, second_joints)
        dock.wait_for(state="detached")
        page.wait_for_timeout(700)
        assert read_robot_pose(canvas) == first_pose
        assert json.loads(canvas.get_attribute("data-robot-joint-values")) == second_joints
        assert page.locator(".point-cloud-view").get_attribute("data-robot-trajectory-active") == "false"
        first_node.click()

        # Renaming and deleting the archived pose also updates/clears its ghost.
        topbar_action(page, name="打开示教数据管理页").click()
        page.get_by_role("button", name="选择停车点 停车点 P01", exact=True).click()
        page.get_by_role("button", name="查看机械臂姿态 A01", exact=True).click()
        name = page.get_by_role("textbox", name="机械臂姿态名称", exact=True)
        name.fill("残像预览验证姿态")
        name.press("Enter")
        page.once("dialog", lambda dialog: dialog.accept())
        page.get_by_role("button", name="删除当前机械臂姿态", exact=True).click()
        page.get_by_role("button", name="返回主工作台继续示教").click()
        assert page.get_by_label("停车点机器人虚影", exact=True).count() == 0
        assert tree.get_by_role("treeitem", name="预览机械臂姿态 残像预览验证姿态", exact=True).count() == 0
        assert not errors, errors
        browser.close()

    print("pose ghosts: no sidebar-triggered popup, parking-bound preview, sidebar pose application, playback stop, Escape clearing, task selection and deletion passed")


if __name__ == "__main__":
    run()
