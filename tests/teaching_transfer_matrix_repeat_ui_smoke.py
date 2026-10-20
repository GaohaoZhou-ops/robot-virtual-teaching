"""Exercise repeated matrix imports in disposable browser workspaces."""
from playwright.sync_api import expect, sync_playwright

from teaching_transfer_ui_smoke import CHROME, open_transfer, ready, seed, snapshot
from teaching_transfer_matrix_ui_smoke import load_matrix, pose_values
from topbar_tools_helpers import topbar_action


A = "0 -1 0 4\n1 0 0 -2\n0 0 1 0.5\n0 0 0 1"
B = "1 0 0 3\n0 1 0 5\n0 0 1 1\n0 0 0 1"


def matrix_file(text=A, name="alignment.txt"):
    return dict(name=name, mimeType="text/plain", buffer=text.encode())


def close_pose(dialog, expected):
    actual = pose_values(dialog)
    assert all(abs(left - right) < 1e-6 for left, right in zip(actual, expected)), (actual, expected)


def confirmation(page):
    modal = page.get_by_role("alertdialog", name="转换矩阵已加载过", exact=True)
    expect(modal).to_be_visible()
    expect(modal).to_contain_text("可重载转换关系，或在当前关系上叠加转换")
    expect(modal.get_by_role("button", name="取消", exact=True)).to_be_focused()
    expect(page.locator(".teaching-transfer-modal")).to_have_attribute("inert", "")
    return modal


def run():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            page = browser.new_page(viewport=dict(width=1440, height=1000))
            page.on("pageerror", lambda error: errors.append(str(error)))
            seed(page, ["map", "independent"], "independent")
            source, target = snapshot(page, "independent"), snapshot(page, "map")
            dialog = open_transfer(page)
            load_matrix(page, dialog, matrix_file())
            close_pose(dialog, [4, -2, 0.5, 0, 0, 90])
            expect(page.get_by_role("alertdialog")).to_have_count(0)
            assert snapshot(page, "map") == target

            # A renamed file with different whitespace and numeric spelling is still the same matrix.
            equivalent = "\ufeff\r\n " + A.replace(" ", "\t").replace("\n", "\r\n").replace("0.5", "5e-1") + "\r\n"
            load_matrix(page, dialog, matrix_file(equivalent, "renamed.txt"))
            modal = confirmation(page)
            close_pose(page.locator(".teaching-transfer-modal"), [4, -2, 0.5, 0, 0, 90])
            page.keyboard.press("Tab")
            expect(modal.get_by_role("button", name="重载转换关系", exact=True)).to_be_focused()
            page.keyboard.press("Tab")
            expect(modal.get_by_role("button", name="叠加转换", exact=True)).to_be_focused()
            page.keyboard.press("Tab")
            expect(modal.get_by_role("button", name="取消", exact=True)).to_be_focused()
            page.keyboard.press("Shift+Tab")
            expect(modal.get_by_role("button", name="叠加转换", exact=True)).to_be_focused()
            page.screenshot(path="/tmp/atlas-transfer-duplicate-matrix.png", full_page=True)
            page.keyboard.press("Escape")
            expect(modal).to_have_count(0)
            expect(dialog).to_be_visible()
            expect(dialog.get_by_role("button", name="加载转换矩阵", exact=True)).to_be_focused()
            close_pose(dialog, [4, -2, 0.5, 0, 0, 90])
            expect(dialog.locator(".transfer-matrix-file")).to_contain_text("alignment.txt")
            assert snapshot(page, "map") == target

            # Cancel also preserves a manually edited value and the original file label.
            dialog.get_by_label("放置 X", exact=True).fill("12")
            load_matrix(page, dialog, matrix_file())
            confirmation(page).get_by_role("button", name="取消", exact=True).click()
            close_pose(dialog, [12, -2, 0.5, 0, 0, 90])
            dialog.get_by_label("放置 X", exact=True).fill("4")
            load_matrix(page, dialog, matrix_file())
            confirmation(page).get_by_role("button", name="叠加转换", exact=True).click()
            close_pose(dialog, [6, 2, 1, 0, 0, 180])

            # Reload can repair incomplete inputs; stacking cannot use an invalid base.
            dialog.get_by_label("放置 Yaw", exact=True).fill("")
            load_matrix(page, dialog, matrix_file())
            modal = confirmation(page)
            expect(modal.get_by_role("button", name="叠加转换", exact=True)).to_be_disabled()
            page.keyboard.press("Tab")
            expect(modal.get_by_role("button", name="重载转换关系", exact=True)).to_be_focused()
            page.keyboard.press("Tab")
            expect(modal.get_by_role("button", name="取消", exact=True)).to_be_focused()
            modal.get_by_role("button", name="重载转换关系", exact=True).click()
            close_pose(dialog, [4, -2, 0.5, 0, 0, 90])
            assert snapshot(page, "map") == target

            # Different data under the same name loads normally. Earlier imports stay remembered.
            load_matrix(page, dialog, matrix_file(B))
            expect(page.get_by_role("alertdialog")).to_have_count(0)
            close_pose(dialog, [3, 5, 1, 0, 0, 0])
            # Correct a wrong file using a previously loaded one, including a non-origin anchor.
            dialog.get_by_label("放置定位基准").select_option("robot")
            load_matrix(page, dialog, matrix_file(A, "correct-alignment.txt"))
            confirmation(page).get_by_role("button", name="重载转换关系", exact=True).click()
            close_pose(dialog, [4, -2, 0.5, 0, 0, 90])
            expect(dialog.get_by_label("放置定位基准")).to_have_value("origin")
            expect(dialog.locator(".transfer-matrix-file")).to_contain_text("correct-alignment.txt")
            load_matrix(page, dialog, matrix_file(B))
            confirmation(page).get_by_role("button", name="重载转换关系", exact=True).click()
            close_pose(dialog, [3, 5, 1, 0, 0, 0])
            dialog.get_by_label("放置定位基准").select_option("robot")
            load_matrix(page, dialog, matrix_file())
            confirmation(page).get_by_role("button", name="叠加转换", exact=True).click()
            # A * B rotates B's translation; B * A would produce (7, 3, 1.5).
            close_pose(dialog, [-1, 1, 1.5, 0, 0, 90])
            expect(dialog.get_by_label("放置定位基准")).to_have_value("origin")
            dialog.get_by_role("button", name="放置并进入地图", exact=True).click()
            ready(page, "map")
            placed = snapshot(page, "map")
            assert placed["positions"][:len(target["positions"])] == target["positions"]
            assert placed["positions"][len(target["positions"]):len(target["positions"]) + 3] == [-21, 11, 2.5]
            history = placed["project"]["workspace"]["transfer"]["matrixImports"]
            assert len(history) == 2
            assert history[0]["values"] == list(map(float, A.split()))
            assert history[1]["values"] == list(map(float, B.split()))
            assert snapshot(page, "independent")["positions"] == source["positions"]

            page.reload(wait_until="networkidle")
            ready(page, "map")
            topbar_action(page, name="切换到独立示教", exact=True).click()
            ready(page, "independent")
            dialog = open_transfer(page)
            close_pose(dialog, [-1, 1, 1.5, 0, 0, 90])
            load_matrix(page, dialog, matrix_file())
            modal = confirmation(page)
            page.set_viewport_size(dict(width=1000, height=720))
            expect(modal.get_by_role("button", name="叠加转换", exact=True)).to_be_in_viewport()
            expect(modal.get_by_role("button", name="重载转换关系", exact=True)).to_be_in_viewport()
            modal.screenshot(path="/tmp/atlas-transfer-duplicate-matrix-compact.png")
            modal.get_by_role("button", name="叠加转换", exact=True).click()
            close_pose(dialog, [3, -3, 2, 0, 0, 180])
            dialog.get_by_role("button", name="放置并进入地图", exact=True).click()
            ready(page, "map")
            stacked = snapshot(page, "map")
            assert stacked["positions"][:len(placed["positions"])] == placed["positions"]
            assert stacked["positions"][len(placed["positions"]):len(placed["positions"]) + 3] == [-7, -23, 3]
            assert snapshot(page, "independent")["positions"] == source["positions"]

            # Replace the saved accumulated relation; the next placement must apply A just once.
            topbar_action(page, name="切换到独立示教", exact=True).click()
            ready(page, "independent")
            dialog = open_transfer(page)
            load_matrix(page, dialog, matrix_file())
            confirmation(page).get_by_role("button", name="重载转换关系", exact=True).click()
            close_pose(dialog, [4, -2, 0.5, 0, 0, 90])
            assert snapshot(page, "map")["positions"] == stacked["positions"]
            dialog.get_by_role("button", name="放置并进入地图", exact=True).click()
            ready(page, "map")
            replaced = snapshot(page, "map")
            assert replaced["positions"][:len(stacked["positions"])] == stacked["positions"]
            assert replaced["positions"][len(stacked["positions"]):len(stacked["positions"]) + 3] == [-16, 8, 1.5]
            assert len(replaced["project"]["workspace"]["transfer"]["matrixImports"]) == 2
            page.reload(wait_until="networkidle")
            ready(page, "map")
            topbar_action(page, name="切换到独立示教", exact=True).click()
            ready(page, "independent")
            dialog = open_transfer(page)
            close_pose(dialog, [4, -2, 0.5, 0, 0, 90])
            assert snapshot(page, "independent")["positions"] == source["positions"]
            page.close()

            # Older saved bindings lack matrixImports. They still get a confirmation.
            page = browser.new_page(viewport=dict(width=1180, height=850))
            page.on("pageerror", lambda error: errors.append(str(error)))
            seed(page, ["map", "independent"], "independent")
            page.evaluate("""async text => {
              const store = await import('/src/lib/sessionStore.js');
              const transfer = await import('/src/lib/teachingTransfer.js');
              const { sessionId } = await store.fetchServiceSession();
              const source = await store.loadWorkspaceSnapshot(sessionId, 'independent');
              const target = await store.loadWorkspaceSnapshot(sessionId, 'map');
              const localToMap = transfer.transformTeachingPose(transfer.identityTransferPose(), transfer.parseTransferMatrix(text));
              const placed = await transfer.placeTeachingWorkspace(source, target, { localToMap });
              delete placed.config.project.workspace.transfer.matrixImports;
              await store.saveWorkspaceMap(sessionId, placed.map.mapId, placed.map.name, placed.map, 'map');
              await store.saveWorkspaceConfig(sessionId, placed.map.mapId, placed.config, 'map');
            }""", A)
            legacy = snapshot(page, "map")
            dialog = open_transfer(page)
            close_pose(dialog, [4, -2, 0.5, 0, 0, 90])
            load_matrix(page, dialog, matrix_file())
            confirmation(page).get_by_role("button", name="取消", exact=True).click()
            close_pose(dialog, [4, -2, 0.5, 0, 0, 90])
            load_matrix(page, dialog, matrix_file())
            confirmation(page).get_by_role("button", name="叠加转换", exact=True).click()
            close_pose(dialog, [6, 2, 1, 0, 0, 180])
            load_matrix(page, dialog, matrix_file())
            confirmation(page).get_by_role("button", name="重载转换关系", exact=True).click()
            close_pose(dialog, [4, -2, 0.5, 0, 0, 90])
            dialog.get_by_role("button", name="取消", exact=True).click()
            assert snapshot(page, "map") == legacy, "canceling the outer conversion must not save a preview"
            assert not errors, errors
        finally:
            browser.close()
    print("Duplicate matrix UI: cancel/Escape, focus, replacement, invalid-input recovery, composition, saved relation replacement, legacy bindings and source isolation passed")


if __name__ == "__main__":
    run()
