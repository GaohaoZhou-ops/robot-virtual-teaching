import math
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from archive_helpers import start_project_download, read_exported_project
from chassis_drag_smoke import chassis_screen_point
from end_effector_control_smoke import double_click_tool, load_robot, number_attr
from robot_drag_undo_smoke import assert_restored, state, undo_depth
from viewer_tools_helpers import viewer_tool


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990").rstrip("/")
ROOT = Path(__file__).resolve().parents[1]
BODY = {"ankle_pitch_J", "knee_pitch_J", "waist_pitch_J", "waist_yaw_J"}


def enter_torso(page, canvas):
    page.wait_for_function("document.querySelector('.three-canvas').dataset.robotTorsoScreenVisible === 'true'")
    box = canvas.bounding_box()
    x = box["x"] + number_attr(canvas, "robot-torso-screen-x")
    y = box["y"] + number_attr(canvas, "robot-torso-screen-y")
    for dx, dy in ((0, 0), (0, -8), (5, -4), (-5, -4), (0, 8)):
        page.mouse.move(x + dx, y + dy)
        if canvas.get_attribute("data-hover-end-effector") == "torso":
            page.mouse.dblclick(x + dx, y + dy, delay=70)
            expect(canvas).to_have_attribute("data-end-effector-side", "torso")
            expect(page.get_by_label("躯干联动控制", exact=True)).to_be_visible()
            for button in ("完成调整", "取消"):
                assert page.get_by_label("躯干联动控制", exact=True).get_by_role("button", name=button, exact=True).evaluate(
                    """node => {
                      const rect = node.getBoundingClientRect();
                      return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
                    }"""
                ), f"Torso action obscured: {button}"
            return
    page.screenshot(path="/tmp/atlas-torso-hit-failure.png", full_page=True)
    raise AssertionError("Chest mesh did not respond at its visible surface")


def set_value(page, name, value):
    field = page.get_by_role("spinbutton", name=name, exact=True)
    field.fill(str(value))
    field.press("Enter")
    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    return field


def start_torso_drag(page, canvas):
    box = canvas.bounding_box()
    x = box["x"] + number_attr(canvas, "end-effector-target-screen-x")
    y = box["y"] + number_attr(canvas, "end-effector-target-screen-y")
    for radius in (12, 22, 32, 45, 60, 80):
        for angle in range(0, 360, 30):
            px = x + radius * math.cos(math.radians(angle))
            py = y + radius * math.sin(math.radians(angle))
            page.mouse.move(px, py)
            page.mouse.down()
            if canvas.get_attribute("data-end-effector-dragging") == "true":
                return px, py
            page.mouse.up()
    raise AssertionError("No active torso axis could be picked")


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True,
            executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE") or None)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(30_000)
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(f"{BASE_URL}/workbench", wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator('input[type="file"][accept=".ply"]').set_input_files(str(ROOT / "tests/fixtures/rotation-map.ply"))
        page.locator(".loading-curtain").wait_for(state="hidden")
        load_robot(page)
        canvas = page.locator(".three-canvas")
        viewer_tool(page, name="定位机器人模型").click()
        page.wait_for_timeout(400)
        original = state(canvas)
        expect(canvas).to_have_attribute("data-robot-torso-control-available", "true")
        enter_torso(page, canvas)
        expect(canvas).to_have_attribute("data-robot-control-enabled", "false")
        expect(canvas).to_have_attribute("data-end-effector-mode", "height")
        assert_restored(canvas, original)
        height = number_attr(canvas, "torso-height") - 0.12
        set_value(page, "躯干高度 (m)", height)
        page.wait_for_function("h => Math.abs(Number(document.querySelector('.three-canvas').dataset.torsoHeight) - h) < 0.003", arg=height)
        bent = state(canvas)
        assert bent["pose"] == original["pose"]
        assert bent["joints"]["ankle_pitch_J"] > 5
        assert bent["joints"]["knee_pitch_J"] < -10
        assert bent["joints"]["waist_pitch_J"] > 5
        assert all(bent["joints"][name] == value for name, value in original["joints"].items() if name not in BODY)
        set_value(page, "躯干YAW (°)", 30)
        set_value(page, "躯干PITCH (°)", 12)
        assert abs(number_attr(canvas, "torso-yaw") - 30) < 0.1
        assert abs(number_attr(canvas, "torso-pitch") - 12) < 0.5, state(canvas)
        assert abs(number_attr(canvas, "torso-height") - height) < 0.005
        page.get_by_role("slider", name="躯干YAW滑杆", exact=True).press("ArrowRight")
        page.wait_for_function("Math.abs(Number(document.querySelector('.three-canvas').dataset.torsoYaw) - 31) < 0.1")
        assert abs(number_attr(canvas, "torso-yaw") - 31) < 0.1
        page.screenshot(path="/tmp/atlas-torso-control.png", full_page=True)
        print("chest double-click, linked height, yaw/pitch, sliders and fixed chassis passed", flush=True)

        # Drag each supported axis and undo exactly, preserving the controller.
        for label, mode in (("高度", "height"), ("YAW", "yaw"), ("PITCH", "pitch")):
            page.get_by_role("button", name=f"调整躯干{label}", exact=True).click()
            expect(canvas).to_have_attribute("data-end-effector-mode", mode)
            before = state(canvas)
            x, y = start_torso_drag(page, canvas)
            page.mouse.move(x + 9, y + 9, steps=6)
            page.mouse.up()
            assert state(canvas)["joints"] != before["joints"], mode
            assert undo_depth(canvas) == 1
            canvas.focus()
            page.keyboard.press("Control+z")
            assert_restored(canvas, before)
            expect(canvas).to_have_attribute("data-end-effector-side", "torso")
        print("height/yaw/pitch axis dragging and undo passed", flush=True)

        # Cancelling a dirty input restores the entry snapshot and hides all handles.
        field = page.get_by_role("spinbutton", name="躯干PITCH (°)", exact=True)
        field.fill("80")
        field.press("Escape")
        expect(page.get_by_label("躯干联动控制", exact=True)).to_have_count(0)
        assert_restored(canvas, original)
        expect(canvas).to_have_attribute("data-end-effector-space-ball-visible", "false")

        # Switching between chest, arm and chassis restores the proper gizmo modes.
        enter_torso(page, canvas)
        set_value(page, "躯干高度 (m)", height)
        accepted = state(canvas)
        page.get_by_role("button", name="完成调整", exact=True).click()
        assert_restored(canvas, accepted)
        double_click_tool(page, canvas, "left")
        expect(page.get_by_label("机械臂末端空间球", exact=True)).to_be_visible()
        expect(canvas).to_have_attribute("data-end-effector-mode", "translate")
        page.get_by_role("button", name="锁定本体姿态左机械臂末端", exact=True).click()
        page.get_by_role("button", name="退出机械臂末端控制", exact=True).click()
        enter_torso(page, canvas)
        set_value(page, "躯干PITCH (°)", 8)
        assert abs(number_attr(canvas, "torso-pitch") - 8) < 0.5
        assert all(state(canvas)["joints"][name] == value for name, value in accepted["joints"].items() if name not in BODY)
        expect(canvas).to_have_attribute("data-end-effector-left-lock-mode", "body")
        page.get_by_role("button", name="取消", exact=True).click()
        assert_restored(canvas, accepted)
        double_click_tool(page, canvas, "left")
        page.get_by_role("button", name="锁定全局姿态左机械臂末端", exact=True).click()
        page.get_by_role("button", name="退出机械臂末端控制", exact=True).click()
        locked = state(canvas)
        count = number_attr(canvas, "end-effector-global-solve-count")
        enter_torso(page, canvas)
        set_value(page, "躯干高度 (m)", height - 0.008)
        assert number_attr(canvas, "end-effector-global-solve-count") > count
        assert abs(number_attr(canvas, "torso-height") - (height - 0.008)) < 0.005
        expect(canvas).to_have_attribute("data-end-effector-left-lock-mode", "map")
        page.keyboard.press("Escape")
        assert_restored(canvas, locked)
        # Release the map lock before unrelated mode and persistence checks.
        double_click_tool(page, canvas, "left")
        page.get_by_role("button", name="解除全局姿态锁定左机械臂末端", exact=True).click()
        page.get_by_role("button", name="退出机械臂末端控制", exact=True).click()
        accepted = state(canvas)
        enter_torso(page, canvas)
        x, y = chassis_screen_point(canvas)
        page.mouse.dblclick(x, y, delay=70)
        expect(canvas).to_have_attribute("data-robot-control-enabled", "true")
        expect(page.get_by_label("躯干联动控制", exact=True)).to_have_count(0)

        # Joint limits and a compact viewport keep the controls usable.
        enter_torso(page, canvas)
        set_value(page, "躯干YAW (°)", 900)
        expect(page.get_by_label("躯干联动控制", exact=True)).to_have_attribute("data-ik-status", "limited")
        assert abs(number_attr(canvas, "torso-yaw")) <= 175.01
        # Undo must restore the limit feedback as well as the exact joint pose.
        set_value(page, "躯干YAW (°)", 0)
        set_value(page, "躯干高度 (m)", number_attr(canvas, "torso-height") + 1)
        panel = page.get_by_label("躯干联动控制", exact=True)
        limited = state(canvas)
        limit_feedback = panel.get_by_role("status").inner_text()
        assert "已到行程边界" in limit_feedback
        page.get_by_role("button", name="调整躯干YAW", exact=True).click()
        x, y = start_torso_drag(page, canvas)
        page.mouse.move(x + 9, y + 9, steps=6)
        page.mouse.up()
        assert state(canvas)["joints"] != limited["joints"]
        canvas.focus()
        page.keyboard.press("Control+z")
        assert_restored(canvas, limited)
        expect(panel.get_by_role("status")).to_have_text(limit_feedback)
        page.keyboard.press("Escape")
        assert_restored(canvas, accepted)
        page.set_viewport_size({"width": 980, "height": 640})
        page.wait_for_timeout(300)
        enter_torso(page, canvas)
        expect(page.get_by_role("button", name="完成调整", exact=True)).to_be_in_viewport()
        set_value(page, "躯干YAW (°)", 15)
        page.screenshot(path="/tmp/atlas-torso-control-compact.png", full_page=True)
        saved = state(canvas)
        page.get_by_role("button", name="完成调整", exact=True).click()
        page.get_by_role("button", name="打开示教数据管理页").click()
        with page.expect_download() as download_info:
            start_project_download(page)
        project = read_exported_project(download_info.value)
        assert all(abs(project["robot"]["joints"][name] - value) < 1e-7 for name, value in saved["joints"].items())
        page.get_by_role("button", name="返回主工作台继续示教").click()
        page.wait_for_timeout(800)
        page.reload(wait_until="networkidle")
        page.wait_for_function("document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'", timeout=180_000)
        assert_restored(canvas, saved)
        assert not errors, errors
        browser.close()
        print("cancel, body locks, mode handoff, limits, compact layout, export and reload passed", flush=True)


if __name__ == "__main__":
    run()
