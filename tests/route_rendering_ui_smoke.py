"""Straight routes, reciprocal arrow directions and independent selection."""
import time

from playwright.sync_api import expect, sync_playwright

from box_selection_smoke import drag_box, path_midpoint
from teaching_transfer_ui_smoke import BASE_URL, CHROME, ready
from three_selection_smoke import project_to_canvas


def seed_routes(page):
    page.goto(BASE_URL, wait_until="networkidle")
    page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
    page.evaluate("""async () => {
      const { teachingTransfer3DFixture } = await import('/tests/teaching_transfer_helpers.mjs');
      const store = await import('/src/features/workspace/model/sessionStore.js');
      const { sessionId } = await store.fetchServiceSession();
      const fixture = teachingTransfer3DFixture('map');
      const project = fixture.config.config.project;
      project.virtualTeaching.tasks = [];
      project.workspace.activeTeachingTaskId = null;
      project.workspace.activeTeachingParkingPointId = null;
      project.waypoints = [['A', 12, 15], ['B', 24, 15], ['C', 24, 26]].map(([id, x, y]) => ({
        id, name: id, pose: { x, y, z: 0.2, roll: 0, pitch: 0, yaw: 0 },
      }));
      project.paths = [['AB', 'A', 'B', 0.8], ['BA', 'B', 'A', 0.5], ['BC', 'B', 'C', 1.2]]
        .map(([id, from, to, maxSpeed]) => ({
          id, from, to, directed: true, connectivity: 'connected',
          limits: { minSpeed: 0.1, maxSpeed, minAcceleration: -0.5, maxAcceleration: 0.5 },
        }));
      await store.saveWorkspaceMap(sessionId, fixture.map.mapId, fixture.map.name, fixture.map, 'map');
      await store.saveWorkspaceConfig(sessionId, fixture.map.mapId, fixture.config.config, 'map');
      await store.activateWorkspaceMode(sessionId, 'map');
    }""")
    page.goto(f"{BASE_URL}/workbench", wait_until="networkidle")
    ready(page, "map")
    expect(page.locator(".route-edge")).to_have_count(3)


def route(page, source, target):
    return page.get_by_role("button", name=f"配置路径 {source} 到 {target}", exact=True)


def geometry(path):
    return path.evaluate("""element => {
      const length = element.getTotalLength();
      const start = element.getPointAtLength(0), end = element.getPointAtLength(length);
      return { start: [start.x, start.y], end: [end.x, end.y], length, d: element.getAttribute('d') };
    }""")


def assert_direction(page, source, target, speed):
    expect(route(page, source, target)).to_have_attribute("aria-pressed", "true")
    assert page.locator(".direction-card strong").all_text_contents() == [source, target]
    expect(page.get_by_label("最大速度")).to_have_value(f"{speed:.2f}")


def run():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME) if CHROME.exists() else None)
        try:
            page = browser.new_page(viewport={"width": 1600, "height": 1000})
            page.set_default_timeout(30_000)
            page.on("pageerror", lambda error: errors.append(str(error)))
            seed_routes(page)
            visible_paths = page.locator(".route-edge__visible")
            forward, reverse, single = [geometry(visible_paths.nth(i)) for i in range(3)]
            for index, path in enumerate([forward, reverse, single]):
                assert " L " in path["d"] and "Q" not in path["d"], path
                assert visible_paths.nth(index).get_attribute("marker-end")
                assert not visible_paths.nth(index).get_attribute("marker-start")
            assert abs(forward["start"][0] - reverse["start"][0]) < 0.001
            assert abs(forward["start"][1] - reverse["start"][1]) < 0.001
            assert forward["end"][0] > forward["start"][0] > reverse["end"][0]
            assert abs(forward["end"][1] - reverse["end"][1]) < 0.001
            assert abs(single["start"][0] - single["end"][0]) < 0.001

            # Both halves select their own directed edge and retain separate limits.
            for source, target, speed in [("A", "B", 0.8), ("B", "A", 0.5), ("B", "C", 1.2)]:
                midpoint = path_midpoint(route(page, source, target))
                page.mouse.click(midpoint["x"], midpoint["y"])
                assert_direction(page, source, target, speed)
            speed_input = page.get_by_label("最大速度")
            route(page, "B", "A").press("Enter")
            speed_input.fill("0.6")
            speed_input.press("Enter")
            route(page, "A", "B").press("Enter")
            assert_direction(page, "A", "B", 0.8)
            route(page, "B", "A").press("Enter")
            assert_direction(page, "B", "A", 0.6)
            page.screenshot(path="/tmp/atlas-straight-routes.png", full_page=True)

            # Picking the shared 3D centerline on each side resolves its direction.
            canvas = page.locator(".three-canvas")
            expect(canvas).to_have_attribute("data-route-edge-count", "3")
            elevation = float(canvas.get_attribute("data-waypoint-radius")) / (0.14 ** (1 / 3)) * 0.25
            for source, target, speed, pose in [
                ("A", "B", 0.8, (21, 15, 0.2 + elevation)),
                ("B", "A", 0.6, (15, 15, 0.2 + elevation)),
                ("B", "C", 1.2, (24, 20.5, 0.2 + elevation)),
            ]:
                page.mouse.click(*project_to_canvas(canvas, pose))
                expect(canvas).to_have_attribute("data-last-pick-type", "edge")
                expect(canvas).to_have_attribute("data-last-pick-id", source + target)
                assert_direction(page, source, target, speed)

            # Deleting one half leaves the opposite direction as a full single arrow.
            page.get_by_role("button", name="框选", exact=True).click()
            midpoint = path_midpoint(route(page, "A", "B"))
            drag_box(page, (midpoint["x"] - 9, midpoint["y"] - 12),
                     (midpoint["x"] + 9, midpoint["y"] + 12))
            expect(page.locator(".map2d-view")).to_have_attribute("data-box-selected-edge-count", "1")
            expect(page.locator(".map2d-view")).to_have_attribute("data-box-selected-waypoint-count", "0")
            expect(route(page, "A", "B")).to_have_attribute("aria-pressed", "true")
            page.keyboard.press("Delete")
            expect(route(page, "A", "B")).to_have_count(0)
            expect(page.locator(".route-edge")).to_have_count(2)
            assert geometry(route(page, "B", "A"))["length"] > reverse["length"] * 1.5
            expect(canvas).to_have_attribute("data-route-edge-count", "2")
            read_saved_paths = """async () => {
              const store = await import('/src/features/workspace/model/sessionStore.js');
              const saved = await store.loadWorkspaceSnapshot((await store.fetchServiceSession()).sessionId, 'map');
              return saved.config.config.project.paths.map(path => path.id);
            }"""
            deadline = time.monotonic() + 10
            while page.evaluate(read_saved_paths) != ["BA", "BC"] and time.monotonic() < deadline:
                page.wait_for_timeout(100)
            assert page.evaluate(read_saved_paths) == ["BA", "BC"]
            page.reload(wait_until="networkidle")
            ready(page, "map")
            expect(page.locator(".route-edge")).to_have_count(2)
            route(page, "B", "A").press("Enter")
            assert_direction(page, "B", "A", 0.6)
            assert not errors, errors
            print("Straight single/bidirectional routes, 2D/3D directional picks, speed edits, box deletion and reload passed")
        finally:
            browser.close()


if __name__ == "__main__":
    run()
