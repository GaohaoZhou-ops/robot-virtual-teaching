from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from linked_project_ui_smoke import seed_linked, state
from teaching_transfer_ui_smoke import CHROME, open_transfer, ready, snapshot
from teaching_transfer_matrix_ui_smoke import load_matrix, pose_values
from topbar_tools_helpers import topbar_action

PLY = Path(__file__).resolve().parent / "fixtures" / "rotation-map.ply"
MATRIX = {"name": "group-b.txt", "mimeType": "text/plain",
          "buffer": b"1 0 0 14\n0 1 0 -8\n0 0 1 2\n0 0 0 1\n"}


def history(page):
    return page.evaluate("""async () => (await import('/src/lib/sessionStore.js')).listIndependentHistory()""")


def new_group(page, file=PLY):
    with page.expect_file_chooser() as chooser:
        topbar_action(page, "新增独立示教", exact=True).click()
    with page.expect_navigation(wait_until="networkidle"):
        chooser.value.set_files(str(file))
    ready(page, "independent")


def restore_group(page, map_name):
    topbar_action(page, "独立示教历史", exact=True).click()
    dialog = page.get_by_role("dialog", name="加载工程", exact=True)
    with page.expect_navigation(wait_until="networkidle"):
        dialog.get_by_role("button", name=f"恢复独立示教 {map_name}", exact=True).click()
    ready(page, "independent")


def current_group_id(page):
    return page.evaluate("""async () => {
      const store = await import('/src/lib/sessionStore.js');
      const data = await store.loadWorkspaceSnapshot((await store.fetchServiceSession()).sessionId, 'independent');
      return data.map.teachingGroupId;
    }""")


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            page.set_default_timeout(30_000)
            page.on("pageerror", lambda error: errors.append(str(error)))
            seed_linked(page, "independent")
            original = state(page)
            source = snapshot(page, "independent")
            source_name = source["project"]["map"]["fileName"]

            # Cancelling the native chooser leaves both workspaces untouched.
            with page.expect_file_chooser() as chooser:
                topbar_action(page, "新增独立示教", exact=True).click()
            chooser.value.set_files([])
            assert state(page) == original
            assert history(page) == []

            # An invalid PLY never replaces the active slot or creates history.
            page.get_by_label("新增独立示教模型", exact=True).set_input_files({
                "name": "broken.ply", "mimeType": "application/octet-stream",
                "buffer": b"ply\nformat ascii 1.0\nelement vertex 0\nproperty float x\nproperty float y\nproperty float z\nend_header\n",
            })
            expect(page.get_by_text("PLY 文件中没有有效的顶点坐标，当前工程已保留", exact=True)).to_be_visible()
            assert state(page) == original
            assert history(page) == []

            # Simulate quota failure after some writes have been enqueued:
            # the same IndexedDB transaction must roll them all back.
            page.evaluate("""() => {
              const put = IDBObjectStore.prototype.put;
              window.restoreHistoryPut = () => { IDBObjectStore.prototype.put = put; };
              IDBObjectStore.prototype.put = function(record, ...args) {
                if (this.name === 'workspace-session' && record.key === 'independent-history') {
                  throw new DOMException('测试缓存空间不足', 'QuotaExceededError');
                }
                return put.call(this, record, ...args);
              };
            }""")
            page.get_by_label("新增独立示教模型", exact=True).set_input_files(str(PLY))
            expect(page.get_by_text("测试缓存空间不足", exact=True)).to_be_visible()
            page.evaluate("() => window.restoreHistoryPut()")
            assert state(page) == original
            assert history(page) == []

            new_group(page)
            group_b_id = current_group_id(page)
            fresh = state(page)
            assert fresh["states"]["map"] == original["states"]["map"]
            assert fresh["states"]["independent"]["tasks"] == []
            assert fresh["states"]["independent"]["waypoints"] == []
            assert fresh["states"]["independent"]["jointPoses"] == []
            assert fresh.get("transform") is None
            assert not fresh["synced"]
            assert fresh["states"]["independent"]["robotFiles"] == original["states"]["independent"]["robotFiles"]
            assert len(history(page)) == 1
            assert history(page)[0]["teachingPoseCount"] == 2

            # Create an actual new task in the UI and transfer it with a new matrix.
            page.get_by_role("button", name="新建示教任务", exact=True).click()
            task_dialog = page.get_by_role("dialog", name="新建示教任务", exact=True)
            task_dialog.get_by_label("新示教任务名称").fill("第二组对象")
            task_dialog.get_by_role("button", name="添加当前位置为停车点", exact=True).click()
            task_dialog.get_by_role("button", name="创建任务", exact=True).click()
            dialog = open_transfer(page)
            load_matrix(page, dialog, MATRIX)
            with page.expect_navigation(wait_until="networkidle"):
                dialog.get_by_role("button", name="放置并进入地图", exact=True).click()
            ready(page, "map")
            expect(page.get_by_role("button", name="新增独立示教", exact=True, include_hidden=True)).to_have_count(0)
            placed = state(page)
            previous = original["states"]["map"]
            assert len(placed["states"]["map"]["tasks"]) == len(previous["tasks"]) + 1
            assert placed["states"]["map"]["positions"][:len(previous["positions"])] == previous["positions"]
            actual_points = {point["id"]: point for point in placed["states"]["map"]["waypoints"]}
            for point in previous["waypoints"]:
                actual = actual_points[point["id"]]
                assert {key: value for key, value in actual.items() if key != "pose"} == {
                    key: value for key, value in point.items() if key != "pose"}
                # Existing placement re-expresses task-derived Euler angles.
                assert all(abs(actual["pose"][axis] - value) < 1e-10 for axis, value in point["pose"].items())

            topbar_action(page, "切换到独立示教", exact=True).click()
            picker = page.get_by_role("dialog", name="选择独立示教", exact=True)
            with page.expect_navigation(wait_until="networkidle"):
                picker.locator('[data-workspace-kind="current"]').get_by_role("button").click()
            ready(page, "independent")
            second = state(page)["states"]["independent"]
            assert second["tasks"][0]["name"] == "第二组对象"
            new_group(page)  # Same file as B must produce a distinct unbound group.
            assert current_group_id(page) != group_b_id
            assert state(page).get("transform") is None
            dialog = open_transfer(page)
            expect(dialog.get_by_label("放置定位基准")).to_have_value("center")
            load_matrix(page, dialog, MATRIX)
            expect(page.get_by_role("alertdialog", name="转换矩阵已加载过", exact=True)).to_have_count(0)
            dialog.get_by_role("button", name="关闭示教转换", exact=True).click()
            assert len(history(page)) == 2
            assert state(page)["states"]["map"] == placed["states"]["map"]
            page.reload(wait_until="networkidle")
            ready(page, "independent")
            assert len(history(page)) == 2
            topbar_action(page, "独立示教历史", exact=True).click()
            loader = page.get_by_role("dialog", name="加载工程", exact=True)
            expect(loader.get_by_text("独立示教历史", exact=True)).to_be_visible()
            page.screenshot(path="/tmp/atlas-independent-history.png", full_page=True, animations="disabled")
            loader.get_by_role("button", name="关闭加载工程窗口", exact=True).click()

            # History restores A with full poses/media/resources and its matrix,
            # without rolling the map back from A+B to A.
            restore_group(page, source_name)
            restored = state(page)
            assert restored["states"]["independent"] == original["states"]["independent"]
            assert restored["states"]["map"] == placed["states"]["map"]
            assert restored["transform"] == original["transform"]
            assert restored["matrixImports"] == original["matrixImports"]
            assert restored["synced"] == original["synced"]
            assert len(history(page)) == 2  # C archived; A removed from history.
            dialog = open_transfer(page)
            assert pose_values(dialog) == [5, -3, 1, 0, 0, 90]
            dialog.get_by_role("button", name="关闭示教转换", exact=True).click()

            # B and C share a filename. Select B by its task label.
            topbar_action(page, "独立示教历史", exact=True).click()
            row = page.locator(".project-load-history li").filter(has_text="第二组对象")
            with page.expect_navigation(wait_until="networkidle"):
                row.get_by_role("button", name=f"恢复独立示教 {PLY.name}", exact=True).click()
            ready(page, "independent")
            assert current_group_id(page) == group_b_id
            assert state(page)["states"]["independent"] == second
            assert state(page)["states"]["map"] == placed["states"]["map"]
            dialog = open_transfer(page)
            assert pose_values(dialog) == [14, -8, 2, 0, 0, 0]
            dialog.get_by_role("button", name="关闭示教转换", exact=True).click()
            assert not errors, errors
            print("independent_history_cancel_invalid_quota_atomicity=ok")
            print("independent_history_fresh_groups_cumulative_map_and_matrix_isolation=ok")
            print("independent_history_reload_full_restore_and_prior_group_binding=ok")
        finally:
            browser.close()


if __name__ == "__main__":
    run()
