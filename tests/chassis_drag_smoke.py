import json
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from end_effector_control_smoke import double_click_tool
from viewer_tools_helpers import viewer_tool


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:22052")
ROOT = Path(__file__).resolve().parents[1]


def read_pose(canvas):
    return {
        name: float(canvas.get_attribute(f"data-robot-{name}"))
        for name in ("x", "y", "z", "roll", "pitch", "yaw")
    }


def read_camera(canvas):
    return tuple(
        float(canvas.get_attribute(f"data-{name}"))
        for name in (
            "camera-x",
            "camera-y",
            "camera-z",
            "target-x",
            "target-y",
            "target-z",
            "camera-up-x",
            "camera-up-y",
            "camera-up-z",
        )
    )


def chassis_screen_point(canvas):
    box = canvas.bounding_box()
    assert box
    return (
        box["x"] + float(canvas.get_attribute("data-robot-chassis-screen-x")),
        box["y"] + float(canvas.get_attribute("data-robot-chassis-screen-y")),
    )


def assert_fixed_pose(before, after):
    for name in ("z", "roll", "pitch", "yaw"):
        assert abs(after[name] - before[name]) < 1e-7, (name, before[name], after[name])


def double_click_chassis(page, canvas):
    expect(canvas).to_have_attribute("data-robot-chassis-screen-visible", "true")
    page.mouse.dblclick(*chassis_screen_point(canvas), delay=70)
    expect(canvas).to_have_attribute("data-robot-control-enabled", "true")
    expect(canvas).to_have_attribute("data-keyboard-control-owner", "robot")
    expect(canvas).to_have_attribute("data-chassis-drag-mode", "idle")
    expect(canvas).to_be_focused()
    expect(canvas).to_have_attribute("data-chassis-control-guide-visible", "true")
    expect(page.get_by_label("底盘控制提示", exact=True)).to_be_visible()


def enter_chassis_drag(page, canvas):
    viewer_tool(page, name="拖动底盘").click()
    expect(canvas).to_have_attribute("data-chassis-drag-mode", "armed")
    expect(canvas).to_have_attribute("data-robot-control-enabled", "false")
    expect(canvas).to_have_attribute("data-chassis-control-guide-visible", "false")
    expect(page.get_by_label("底盘控制提示", exact=True)).to_have_count(0)


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
        page.locator('input[type="file"][accept=".ply"]').set_input_files(
            str(ROOT / "tests/fixtures/rotation-map.ply")
        )
        page.locator(".loading-curtain").wait_for(state="hidden")

        page.get_by_role("button", name="加载机器人", exact=True).click()
        page.get_by_role("option", name="加载机器人 botx_abx_zivid_m70").click()
        canvas = page.locator(".three-canvas")
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )
        assert canvas.get_attribute("data-chassis-drag-handle-ready") == "true"
        assert canvas.get_attribute("data-chassis-drag-target-frame") == "base_link"

        robot_button = viewer_tool(page, name="定位机器人模型")
        robot_button.click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotControlEnabled === 'true'"
        )
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotChassisScreenVisible === 'true'"
        )
        page.wait_for_timeout(250)
        hud = page.get_by_label("底盘控制提示", exact=True)
        expect(hud.get_by_text("底盘控制已启用", exact=True)).to_be_visible()
        expect(canvas).to_have_attribute("data-chassis-control-guide-visible", "true")

        # Turn off keyboard control to test the canvas shortcut independently.
        viewer_tool(page, name="定位机器人模型").click()
        expect(canvas).to_have_attribute("data-robot-control-enabled", "false")
        expect(canvas).to_have_attribute("data-chassis-control-guide-visible", "false")
        expect(hud).to_have_count(0)
        page.mouse.click(*chassis_screen_point(canvas))
        expect(canvas).to_have_attribute("data-robot-control-enabled", "false")
        initial_pose = read_pose(canvas)
        initial_joints = json.loads(canvas.get_attribute("data-robot-joint-values"))
        double_click_chassis(page, canvas)
        assert read_pose(canvas) == initial_pose
        assert json.loads(canvas.get_attribute("data-robot-joint-values")) == initial_joints
        expect(viewer_tool(page, name="定位机器人模型")).to_have_attribute("aria-pressed", "true")
        page.get_by_role("button", name="视图工具", exact=True).click()
        # The direction guide stays readable when the camera zoom changes.
        guide_scale = canvas.get_attribute("data-chassis-control-guide-scale")
        page.mouse.move(*chassis_screen_point(canvas))
        page.mouse.wheel(0, 180)
        page.wait_for_function(
            "scale => document.querySelector('.three-canvas').dataset.chassisControlGuideScale !== scale",
            arg=guide_scale,
        )
        assert float(canvas.get_attribute("data-chassis-control-guide-screen-length")) == 72
        double_click_chassis(page, canvas)

        # Height locking is reflected in both the guide and its key legend.
        was_locked = canvas.get_attribute("data-robot-height-locked") == "true"
        if not was_locked:
            viewer_tool(page, name="锁定机器人高度").click()
            page.get_by_role("button", name="视图工具", exact=True).click()
        expect(canvas).to_have_attribute("data-chassis-control-guide-height-locked", "true")
        expect(hud.locator('[data-axis="z"]')).to_contain_text("高度已锁定")
        z_before = read_pose(canvas)["z"]
        page.keyboard.press("ArrowUp")
        assert read_pose(canvas)["z"] == z_before
        if not was_locked:
            viewer_tool(page, name="解锁机器人高度").click()
            page.get_by_role("button", name="视图工具", exact=True).click()
        expect(canvas).to_have_attribute("data-chassis-control-guide-height-locked", str(was_locked).lower())
        camera_before_keys = read_camera(canvas)
        for key in ("w", "a", "s", "d", "w", "ArrowLeft"):
            previous = read_pose(canvas)
            page.keyboard.press(key)
            page.wait_for_function(
                "pose => ['x', 'y', 'yaw'].some(axis => Math.abs(Number(document.querySelector('.three-canvas').getAttribute(`data-robot-${axis}`)) - pose[axis]) > 1e-5)",
                arg=previous,
            )
        assert read_camera(canvas) == camera_before_keys
        assert json.loads(canvas.get_attribute("data-robot-joint-values")) == initial_joints
        page.wait_for_function(
            """() => {
              const data = document.querySelector('.three-canvas').dataset;
              return Math.abs(Number(data.chassisControlGuideYaw) - Number(data.robotYaw)) < 1e-6
                && data.chassisControlGuidePosition === [data.robotChassisWorldX, data.robotChassisWorldY, data.robotChassisWorldZ].join(',');
            }"""
        )

        # Repeated double-clicks keep control enabled; the toolbar can disable it.
        moved_with_keys = read_pose(canvas)
        double_click_chassis(page, canvas)
        assert read_pose(canvas) == moved_with_keys
        viewer_tool(page, name="定位机器人模型").click()
        expect(canvas).to_have_attribute("data-robot-control-enabled", "false")
        expect(canvas).to_have_attribute("data-keyboard-control-owner", "camera")
        expect(canvas).to_have_attribute("data-chassis-control-guide-visible", "false")
        expect(hud).to_have_count(0)

        # The visible close button and Escape both release keyboard control.
        double_click_chassis(page, canvas)
        before_close = read_pose(canvas)
        camera_before_close = read_camera(canvas)
        hud.get_by_role("button", name="退出底盘控制", exact=True).click()
        expect(hud).to_have_count(0)
        expect(canvas).to_have_attribute("data-chassis-control-guide-visible", "false")
        assert read_pose(canvas) == before_close
        assert read_camera(canvas) == camera_before_close
        double_click_chassis(page, canvas)
        page.keyboard.down("w")
        page.wait_for_function(
            "x => Math.abs(Number(document.querySelector('.three-canvas').dataset.robotX) - x) > 0.01",
            arg=before_close["x"],
        )
        page.keyboard.press("Escape")
        expect(hud).to_have_count(0)
        expect(canvas).to_have_attribute("data-chassis-control-guide-visible", "false")
        expect(canvas).to_have_attribute("data-robot-control-enabled", "false")
        stopped_pose = read_pose(canvas)
        stopped_camera = read_camera(canvas)
        page.wait_for_timeout(150)
        assert read_pose(canvas) == stopped_pose
        assert read_camera(canvas) == stopped_camera
        page.keyboard.up("w")

        # The same shortcut releases the end-effector controller before driving.
        double_click_chassis(page, canvas)
        double_click_tool(page, canvas, "left")
        expect(canvas).to_have_attribute("data-end-effector-control-state", "active")
        expect(canvas).to_have_attribute("data-chassis-control-guide-visible", "false")
        expect(hud).to_have_count(0)
        double_click_chassis(page, canvas)
        expect(canvas).to_have_attribute("data-end-effector-control-state", "idle")
        page.screenshot(path="/tmp/atlas-chassis-double-click-control.png", full_page=True)
        page.set_viewport_size({"width": 980, "height": 640})
        expect(hud).to_be_visible()
        page.wait_for_function(
            """() => {
              const canvas = document.querySelector('.three-canvas');
              return canvas.clientWidth < 800 && canvas.dataset.robotChassisScreenVisible === 'true'
                && Number(canvas.dataset.robotChassisScreenY) < canvas.clientHeight;
            }"""
        )
        page.evaluate(
            """async () => {
              const canvas = document.querySelector('.three-canvas');
              const layoutAnimations = document.getAnimations().filter(animation => animation.effect?.target?.contains(canvas));
              await Promise.all(layoutAnimations.map(animation => animation.finished.catch(() => {})));
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            }"""
        )
        assert hud.get_by_role("button", name="退出底盘控制", exact=True).evaluate(
            """button => {
              const box = button.getBoundingClientRect();
              return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
            }"""
        )
        page.screenshot(path="/tmp/atlas-chassis-double-click-control-compact.png", full_page=True)
        page.set_viewport_size({"width": 1440, "height": 900})
        print("double-click showed moving direction axes, yaw ring and keyboard UI; zoom, height lock, close and Escape passed", flush=True)

        # Plane dragging remains available from the explicit toolbar control.
        enter_chassis_drag(page, canvas)
        double_click_chassis(page, canvas)
        enter_chassis_drag(page, canvas)
        before = read_pose(canvas)
        camera_before = read_camera(canvas)
        assert canvas.get_attribute("data-robot-control-enabled") == "false"
        assert "按住底盘拖拽" in page.locator(".viewer-help").inner_text()
        page.screenshot(path="/tmp/atlas-chassis-plane-drag-armed.png", full_page=True)

        chassis_x, chassis_y = chassis_screen_point(canvas)
        page.mouse.move(chassis_x, chassis_y)
        page.mouse.down()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.chassisDragging === 'true'"
        )
        page.mouse.move(chassis_x + 84, chassis_y + 38, steps=10)
        page.mouse.up()
        page.wait_for_function(
            "Number(document.querySelector('.three-canvas')?.dataset.chassisDragCount) > 0"
        )
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.chassisDragging === 'false'"
        )
        moved = read_pose(canvas)
        assert abs(moved["x"] - before["x"]) + abs(moved["y"] - before["y"]) > 0.04
        assert_fixed_pose(before, moved)
        assert read_camera(canvas) == camera_before

        # A captured pointer that leaves the WebGL canvas must immediately end
        # the gesture. Returning with the mouse still held must not move again.
        chassis_x, chassis_y = chassis_screen_point(canvas)
        canvas_box = canvas.bounding_box()
        assert canvas_box
        page.mouse.move(chassis_x, chassis_y)
        page.mouse.down()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.chassisDragging === 'true'"
        )
        outside_x = min(canvas_box["x"] + canvas_box["width"] + 18, 1432)
        outside_y = min(max(chassis_y, 8), 892)
        page.mouse.move(outside_x, outside_y, steps=8)
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.chassisDragging === 'false'"
        )
        assert canvas.get_attribute("data-chassis-drag-gesture-state") == "cancelled-on-leave"
        pose_at_leave = read_pose(canvas)
        page.mouse.move(chassis_x + 25, chassis_y + 10, steps=5)
        page.wait_for_timeout(120)
        assert read_pose(canvas) == pose_at_leave
        page.mouse.up()

        page.keyboard.press("Escape")
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.chassisDragMode === 'idle'"
        )
        assert canvas.get_attribute("data-chassis-drag-exit-reason") == "escape"
        assert not page.locator(".point-cloud-view").evaluate(
            "node => node.classList.contains('is-chassis-drag-mode')"
        )

        page.screenshot(path="/tmp/atlas-chassis-plane-drag.png", full_page=True)
        print("chassis_drag_delta=", moved["x"] - before["x"], moved["y"] - before["y"])
        print("chassis_drag_count=", canvas.get_attribute("data-chassis-drag-count"))
        print("page_errors=", errors)
        assert not errors
        browser.close()


if __name__ == "__main__":
    run()
