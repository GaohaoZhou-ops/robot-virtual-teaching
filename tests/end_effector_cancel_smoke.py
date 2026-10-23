from topbar_tools_helpers import topbar_action

import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from archive_helpers import start_project_download, read_exported_project
from end_effector_control_smoke import double_click_tool, load_robot, number_attr
from robot_drag_undo_smoke import assert_restored, drag, state, undo_depth
from viewer_tools_helpers import viewer_tool


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990").rstrip("/")
ROOT = Path(__file__).resolve().parents[1]


def begin(page, canvas, side):
    before = state(canvas)
    double_click_tool(page, canvas, side)
    expect(canvas).to_have_attribute("data-end-effector-control-state", "active")
    expect(canvas).to_have_attribute("data-end-effector-side", side)
    expect(page.get_by_label("机械臂末端空间球", exact=True)).to_be_visible()
    return before


def move_x(page, canvas):
    target = number_attr(canvas, "end-effector-target-x") + 0.018
    field = page.get_by_role("spinbutton", name="末端 X (m)", exact=True)
    field.fill(str(target))
    field.press("Enter")
    page.wait_for_function(
        "x => Math.abs(Number(document.querySelector('.three-canvas').dataset.endEffectorTargetX) - x) < 1e-5",
        arg=target,
    )
    return field


def cancel(page, canvas, expected):
    page.keyboard.press("Escape")
    expect(canvas).to_have_attribute("data-end-effector-control-state", "idle")
    expect(canvas).to_have_attribute("data-end-effector-dragging", "false")
    expect(canvas).to_have_attribute("data-end-effector-space-ball-visible", "false")
    expect(canvas).to_have_attribute("data-end-effector-transform-attached", "false")
    expect(page.get_by_label("机械臂末端空间球", exact=True)).to_have_count(0)
    assert_restored(canvas, expected)


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
        page.goto(f"{BASE_URL}/workbench", wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator('input[type="file"][accept=".ply"]').set_input_files(
            str(ROOT / "tests/fixtures/rotation-map.ply"),
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        load_robot(page)
        canvas = page.locator(".three-canvas")
        viewer_tool(page, name="定位机器人模型").click()
        page.wait_for_timeout(400)

        # Cancel the entire adjustment, including committed values and a dirty draft.
        for side in ("left", "right"):
            original = begin(page, canvas, side)
            move_x(page, canvas)
            assert state(canvas)["joints"] != original["joints"]
            page.get_by_role("button", name="RPY 旋转", exact=True).click()
            yaw = page.get_by_role("spinbutton", name="末端 YAW (°)", exact=True)
            yaw.fill(str(number_attr(canvas, "end-effector-target-yaw") + 2.5))
            yaw.press("Enter")
            yaw.fill("35")
            cancel(page, canvas, original)
            assert undo_depth(canvas) == 0
        print("both arms: XYZ/RPY edits and focused dirty inputs cancel to the entry pose", flush=True)

        # Escape must release an in-progress gesture, including subsequent pointer-up.
        for rotate in (False, True):
            original = begin(page, canvas, "left")
            if rotate:
                page.get_by_role("button", name="RPY 旋转", exact=True).click()
            x, y = drag(page, canvas, dx=8, dy=6, rotate=rotate, release=False)
            assert state(canvas)["joints"] != original["joints"]
            cancel(page, canvas, original)
            page.mouse.move(x + 10, y + 5, steps=3)
            page.mouse.up()
            assert_restored(canvas, original)
            assert undo_depth(canvas) == 0
        print("active translation/rotation drags stop cleanly on Escape", flush=True)

        # A normal close keeps changes; cancelling a later session preserves old undo.
        original = begin(page, canvas, "left")
        drag(page, canvas)
        accepted = state(canvas)
        page.get_by_role("button", name="退出机械臂末端控制", exact=True).click()
        assert_restored(canvas, accepted)
        assert undo_depth(canvas) == 1
        begin(page, canvas, "right")
        drag(page, canvas, dx=7, dy=-4)
        cancel(page, canvas, accepted)
        assert undo_depth(canvas) == 1
        page.keyboard.press("Control+z")
        assert_restored(canvas, original)
        assert undo_depth(canvas) == 0
        print("normal close keeps changes; cancellation preserves earlier undo history", flush=True)

        # Restore locks as well as joints, including a lock that predates the session.
        begin(page, canvas, "left")
        move_x(page, canvas)
        page.get_by_role("button", name="锁定本体姿态左机械臂末端", exact=True).click()
        page.get_by_role("button", name="退出机械臂末端控制", exact=True).click()
        locked = begin(page, canvas, "right")
        move_x(page, canvas)
        page.get_by_role("button", name="锁定全局姿态右机械臂末端", exact=True).click()
        cancel(page, canvas, locked)
        expect(canvas).to_have_attribute("data-end-effector-left-lock-mode", "body")
        expect(canvas).to_have_attribute("data-end-effector-right-lock-mode", "free")

        begin(page, canvas, "left")
        page.get_by_role("button", name="解除本体姿态锁定左机械臂末端", exact=True).click()
        move_x(page, canvas)
        page.get_by_role("button", name="锁定本体姿态左机械臂末端", exact=True).click()
        # Double-clicking the same arm again must not accept the intermediate pose.
        double_click_tool(page, canvas, "left")
        expect(canvas).to_have_attribute("data-end-effector-side", "left")
        cancel(page, canvas, locked)
        expect(canvas).to_have_attribute("data-end-effector-left-lock-mode", "body")
        print("original locks and cancellation point survive lock changes and repeated double-clicks", flush=True)

        # Escape belongs to an open modal or the active page, not a hidden controller.
        original = begin(page, canvas, "right")
        move_x(page, canvas)
        adjusted = state(canvas)
        page.screenshot(path="/tmp/atlas-end-effector-escape-hint.png", full_page=True)
        page.get_by_role("tab", name="示教", exact=True).click()
        page.get_by_role("button", name="新建示教任务", exact=True).click()
        dialog = page.get_by_role("dialog", name="新建示教任务", exact=True)
        dialog.get_by_role("textbox").first.focus()
        page.keyboard.press("Escape")
        expect(dialog).to_have_count(0)
        expect(canvas).to_have_attribute("data-end-effector-control-state", "active")
        assert_restored(canvas, adjusted)
        topbar_action(page, name="打开示教数据管理页").click()
        page.keyboard.press("Escape")
        expect(canvas).to_have_attribute("data-end-effector-control-state", "active")
        assert_restored(canvas, adjusted)
        page.get_by_role("button", name="返回主工作台继续示教").click()
        cancel(page, canvas, original)

        # Export and reload must also see the restored pose, not only the renderer.
        topbar_action(page, name="打开示教数据管理页").click()
        with page.expect_download() as download_info:
            start_project_download(page)
        project = read_exported_project(download_info.value)
        assert all(abs(project["robot"]["joints"][name] - value) < 1e-7
                   for name, value in original["joints"].items())
        page.get_by_role("button", name="返回主工作台继续示教").click()
        page.wait_for_timeout(800)
        page.reload(wait_until="networkidle")
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )
        assert_restored(canvas, original)
        expect(canvas).to_have_attribute("data-end-effector-control-state", "idle")
        assert not errors, errors
        browser.close()
        print("modal/page scope, export and reload passed; no browser errors", flush=True)


if __name__ == "__main__":
    run()
