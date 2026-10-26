"""The end-effector panel moves within the viewport without moving the robot."""
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from chassis_drag_smoke import read_camera
from end_effector_control_smoke import double_click_tool, load_robot, number_attr
from robot_drag_undo_smoke import assert_restored, state, undo_depth
from viewer_tools_helpers import viewer_tool


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990").rstrip("/")
CHROME = os.environ.get(
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)
FIXTURE = Path(__file__).parent / "fixtures" / "rotation-map.ply"


def panel_position(panel, viewport):
    box, view = panel.bounding_box(), viewport.bounding_box()
    return box["x"] - view["x"], box["y"] - view["y"]


def assert_position(panel, viewport, expected):
    actual = panel_position(panel, viewport)
    assert all(abs(a - b) < 1 for a, b in zip(actual, expected)), (actual, expected)


def assert_contained(panel, viewport):
    box, view = panel.bounding_box(), viewport.bounding_box()
    x, y = panel_position(panel, viewport)
    assert x >= 9 and y >= 9, (box, view)
    assert x + box["width"] <= view["width"] - 9, (box, view)
    assert y + box["height"] <= view["height"] - 9, (box, view)


def drag_panel(page, header, dx, dy):
    box = header.bounding_box()
    x, y = box["x"] + 125, box["y"] + box["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + dx, y + dy, steps=8)
    page.mouse.up()


def exercise(browser, mode):
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.set_default_timeout(30_000)
    try:
        page.goto(BASE_URL, wait_until="networkidle")
        page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
        page.get_by_role("radio", name="独立示教" if mode == "independent" else "地图示教").click()
        with page.expect_file_chooser() as chooser:
            page.get_by_role("button", name="新建工程", exact=True).click()
        chooser.value.set_files(str(FIXTURE))
        page.wait_for_url(f"{BASE_URL}/workbench")
        page.locator(".loading-curtain").wait_for(state="hidden")
        load_robot(page)
        canvas = page.locator(".three-canvas")
        viewport = page.locator(".point-cloud-view")
        viewer_tool(page, name="定位机器人模型").click()
        page.wait_for_timeout(400)
        double_click_tool(page, canvas, "left")
        panel = page.get_by_label("机械臂末端空间球", exact=True)
        header = panel.get_by_role("group", name="移动机械臂末端面板", exact=True)
        expect(panel).to_be_visible()
        page.wait_for_timeout(220)
        assert_position(panel, viewport, (10, 10))

        robot_before = state(canvas)
        camera_before = read_camera(canvas)
        undo_before = undo_depth(canvas)
        drag_panel(page, header, 120, 45)
        assert_position(panel, viewport, (130, 55))
        assert_restored(canvas, robot_before, target=True)
        assert read_camera(canvas) == camera_before
        assert undo_depth(canvas) == undo_before

        # Keyboard movement stays local to the panel instead of steering the scene.
        header.focus()
        header.press("ArrowRight")
        header.press("ArrowDown")
        assert_position(panel, viewport, (140, 65))
        assert read_camera(canvas) == camera_before
        assert_restored(canvas, robot_before, target=True)
        header.press("Home")
        assert_position(panel, viewport, (10, 10))

        # Pointer cancellation must stop subsequent mouse movement from dragging.
        header.evaluate("""el => el.addEventListener('pointerdown',
          event => { window.__panelPointerId = event.pointerId; }, {once: true})""")
        box = header.bounding_box()
        page.mouse.move(box["x"] + 120, box["y"] + 20)
        page.mouse.down()
        page.mouse.move(box["x"] + 160, box["y"] + 35, steps=3)
        pointer_id = page.evaluate("window.__panelPointerId")
        header.dispatch_event("pointercancel", {"pointerId": pointer_id})
        cancelled_position = panel_position(panel, viewport)
        page.mouse.move(box["x"] + 220, box["y"] + 55, steps=3)
        page.mouse.up()
        assert_position(panel, viewport, cancelled_position)
        assert "is-dragging" not in panel.get_attribute("class").split()

        header.dblclick(position={"x": 120, "y": 20})
        assert_position(panel, viewport, (10, 10))
        drag_panel(page, header, 100, 40)
        moved_position = panel_position(panel, viewport)
        panel.get_by_role("button", name="RPY 旋转", exact=True).click()
        expect(panel).to_have_attribute("data-transform-mode", "rotate")
        assert_position(panel, viewport, moved_position)
        target_x = number_attr(canvas, "end-effector-target-x") + 0.018
        field = panel.get_by_role("spinbutton", name="末端 X (m)", exact=True)
        field.fill(str(target_x))
        field.press("Tab")
        page.wait_for_function(
            "x => Math.abs(Number(document.querySelector('.three-canvas').dataset.endEffectorTargetX) - x) < 1e-5",
            arg=target_x,
        )
        assert_position(panel, viewport, moved_position)
        adjusted = state(canvas)
        panel.get_by_role("button", name="退出机械臂末端控制", exact=True).click()
        expect(panel).to_have_count(0)
        assert_restored(canvas, adjusted)

        double_click_tool(page, canvas, "right")
        expect(panel).to_have_attribute("data-end-effector-side", "right")
        page.wait_for_timeout(220)
        assert_position(panel, viewport, (10, 10))
        drag_panel(page, header, 1200, 650)
        assert_contained(panel, viewport)
        page.set_viewport_size({"width": 1024, "height": 620})
        page.wait_for_timeout(300)
        assert_contained(panel, viewport)
        # Keep the titlebar/close control reachable even when contents must scroll.
        panel.evaluate("el => { el.scrollTop = el.scrollHeight; }")
        close = panel.get_by_role("button", name="退出机械臂末端控制", exact=True)
        assert close.evaluate("""el => {
          const r = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        }""")
        header.dblclick(position={"x": 120, "y": 20})
        assert_position(panel, viewport, (10, 10))
        page.screenshot(path=f"/tmp/atlas-end-effector-panel-{mode}.png", full_page=True)
        close.click()
        expect(panel).to_have_count(0)
        assert not errors, errors
        print(f"{mode}: opening, drag, keyboard, cancellation, pose controls and resize passed", flush=True)
    finally:
        context.close()


def run():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=CHROME)
        try:
            for mode in ("map", "independent"):
                exercise(browser, mode)
        finally:
            browser.close()


if __name__ == "__main__":
    run()
