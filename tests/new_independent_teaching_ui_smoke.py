import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from archive_helpers import start_project_download
from export_separation_ui_smoke import load_project, make_fixtures
from independent_teaching_history_ui_smoke import PLY, MATRIX, choose_new_model, history, open_new_group, restore_group
from teaching_transfer_matrix_ui_smoke import load_matrix, pose_values
from teaching_transfer_ui_smoke import CHROME, open_transfer, ready, seed, snapshot
from topbar_tools_helpers import topbar_action


def choose_new_matrix(page, dialog, file=MATRIX):
    with page.expect_file_chooser() as chooser:
        dialog.get_by_role("button", name="加载转换矩阵", exact=True).click()
    chooser.value.set_files(file)


def create(page, dialog):
    # These cases exercise alignment-only creation; explicitly opt out of the
    # default synchronization/placement covered by the options smoke test.
    for name in ('同步路网', '放置进入地图'):
        button = dialog.get_by_role('button', name=name, exact=True)
        if button.count() and button.get_attribute('aria-pressed') == 'true':
            button.click()
    with page.expect_navigation(wait_until="networkidle"):
        dialog.get_by_role("button", name="创建独立示教", exact=True).click()
    ready(page, "independent")


def enter_current_independent(page):
    topbar_action(page, "切换到独立示教", exact=True).click()
    picker = page.get_by_role("dialog", name="选择独立示教", exact=True)
    with page.expect_navigation(wait_until="networkidle"):
        picker.locator('[data-workspace-kind="current"]').get_by_role("button").click()
    ready(page, "independent")


def new_page(browser, errors):
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = context.new_page()
    page.set_default_timeout(30_000)
    page.on("pageerror", lambda error: errors.append(str(error)))
    return context, page


def run():
    errors = []
    with tempfile.TemporaryDirectory(prefix="atlas-new-independent-") as temporary, sync_playwright() as p:
        directory = Path(temporary)
        make_fixtures(directory)
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            context, page = new_page(browser, errors)
            seed(page, ["independent"], "independent")
            original = snapshot(page, "independent")
            dialog = open_new_group(page)
            expect(dialog.get_by_role("button", name="加载转换矩阵", exact=True)).to_be_disabled()
            expect(dialog.get_by_text("未加载地图示教，暂不可选择转换矩阵", exact=True)).to_be_visible()
            expect(dialog.get_by_label("新增独立示教转换矩阵")).to_be_disabled()
            expect(dialog.get_by_role("button", name="创建独立示教", exact=True)).to_be_disabled()
            choose_new_model(page, dialog, [])
            expect(dialog.get_by_role("button", name="创建独立示教", exact=True)).to_be_disabled()
            choose_new_model(page, dialog)
            expect(dialog.get_by_role("button", name="创建独立示教", exact=True)).to_be_enabled()
            page.screenshot(path="/tmp/atlas-new-independent-no-map.png", full_page=True, animations="disabled")
            page.keyboard.press("Escape")
            expect(dialog).to_have_count(0)
            assert snapshot(page, "independent") == original
            assert history(page) == []

            # Merely having a map config, without its geometry, cannot enable a matrix.
            page.evaluate("""async () => {
              const store = await import('/src/lib/sessionStore.js');
              const { teachingTransferFixture } = await import('/tests/teaching_transfer_helpers.mjs');
              const { sessionId } = await store.fetchServiceSession();
              const map = teachingTransferFixture('map');
              await store.saveWorkspaceConfig(sessionId, map.map.mapId, map.config.config, 'map');
              await store.activateWorkspaceMode(sessionId, 'independent');
            }""")
            dialog = open_new_group(page)
            expect(dialog.get_by_text("未加载地图示教，暂不可选择转换矩阵", exact=True)).to_be_visible()
            expect(dialog.get_by_role("button", name="加载转换矩阵", exact=True)).to_be_disabled()
            choose_new_model(page, dialog)
            create(page, dialog)
            assert snapshot(page, "independent")["project"]["workspace"].get("transfer") is None
            assert len(history(page)) == 1

            # Start with just the model, then load the map and use the existing conversion flow.
            load_project(page, "map", directory / "map.zip")
            enter_current_independent(page)
            dialog = open_new_group(page)
            expect(dialog.get_by_role("button", name="加载转换矩阵", exact=True)).to_be_enabled()
            choose_new_model(page, dialog)
            expect(dialog.get_by_role("button", name="创建独立示教", exact=True)).to_be_enabled()
            dialog.get_by_role("button", name="取消", exact=True).click()
            conversion = open_transfer(page)
            load_matrix(page, conversion, MATRIX)
            assert pose_values(conversion) == [14, -8, 2, 0, 0, 0]
            with page.expect_navigation(wait_until="networkidle"):
                conversion.get_by_role("button", name="放置并进入地图", exact=True).click()
            ready(page, "map")
            assert snapshot(page, "map")["project"]["workspace"]["transfer"]["localToMap"]["position"] == {"x": 14, "y": -8, "z": 2}
            context.close()
            print("no_map_and_metadata_only_disable_matrix_model_only_creation_and_later_conversion=ok", flush=True)

            context, page = new_page(browser, errors)
            seed(page, ["map", "independent"], "independent")
            original_map = snapshot(page, "map")
            original_local = snapshot(page, "independent")
            dialog = open_new_group(page)
            expect(dialog.get_by_role("button", name="加载转换矩阵", exact=True)).to_be_enabled()
            choose_new_model(page, dialog)
            choose_new_matrix(page, dialog, {"name": "broken.txt", "mimeType": "text/plain", "buffer": b"1 0 0 0"})
            expect(dialog.get_by_role("alert")).to_contain_text("4 行")
            expect(dialog.get_by_role("button", name="创建独立示教", exact=True)).to_be_disabled()
            assert snapshot(page, "independent") == original_local
            assert snapshot(page, "map") == original_map
            assert not history(page)
            dialog.get_by_role("button", name="移除矩阵", exact=True).click()
            expect(dialog.get_by_role("button", name="创建独立示教", exact=True)).to_be_enabled()
            dialog.get_by_role("button", name="取消", exact=True).click()

            dialog = open_new_group(page)
            choose_new_matrix(page, dialog)
            expect(dialog.get_by_text("矩阵已校验", exact=True)).to_be_visible()
            expect(dialog.get_by_role("button", name="创建独立示教", exact=True)).to_be_disabled()
            choose_new_model(page, dialog)
            page.screenshot(path="/tmp/atlas-new-independent-with-matrix.png", full_page=True, animations="disabled")
            page.set_viewport_size({"width": 430, "height": 900})
            box = dialog.bounding_box()
            assert box["x"] >= 0 and box["x"] + box["width"] <= 430
            assert dialog.evaluate("element => element.scrollWidth <= element.clientWidth")
            page.screenshot(path="/tmp/atlas-new-independent-mobile.png", animations="disabled")
            page.set_viewport_size({"width": 1440, "height": 1000})
            create(page, dialog)
            local = snapshot(page, "independent")
            relation = local["project"]["workspace"]["transfer"]
            assert relation["kind"] == "alignment"
            assert relation["sourceMap"]["mapId"] == original_map["mapId"]
            assert relation["localToMap"]["position"] == {"x": 14, "y": -8, "z": 2}
            assert relation["matrixImports"][0]["name"] == MATRIX["name"]
            assert snapshot(page, "map") == original_map, "Creating an alignment must not place geometry on the map"
            assert len(history(page)) == 1
            expected_positions = page.evaluate("""async () => {
              const { PLYLoader } = await import('/node_modules/three/examples/jsm/loaders/PLYLoader.js');
              const geometry = new PLYLoader().parse(await (await fetch('/tests/fixtures/rotation-map.ply')).arrayBuffer());
              return [...geometry.attributes.position.array];
            }""")
            assert local["positions"] == expected_positions
            page.reload(wait_until="networkidle")
            ready(page, "independent")
            assert snapshot(page, "independent")["project"]["workspace"]["transfer"] == relation

            # Keep A's pending alignment while another group B is placed on
            # the same map, then restore A from history before exporting.
            dialog = open_new_group(page)
            choose_new_model(page, dialog, {"name": "other-local.ply", "mimeType": "application/octet-stream", "buffer": PLY.read_bytes()})
            create(page, dialog)
            conversion = open_transfer(page)
            load_matrix(page, conversion, {"name": "other-matrix.txt", "mimeType": "text/plain",
                                          "buffer": b"1 0 0 40\n0 1 0 0\n0 0 1 0\n0 0 0 1\n"})
            with page.expect_navigation(wait_until="networkidle"):
                conversion.get_by_role("button", name="放置并进入地图", exact=True).click()
            ready(page, "map")
            enter_current_independent(page)
            restore_group(page, PLY.name)
            assert snapshot(page, "independent")["project"]["workspace"]["transfer"] == relation
            assert snapshot(page, "map")["mapId"] != original_map["mapId"]
            conversion = open_transfer(page)
            assert pose_values(conversion) == [14, -8, 2, 0, 0, 0]
            expect(conversion.get_by_label("放置定位基准")).to_have_value("origin")
            conversion.get_by_role("button", name="关闭示教转换", exact=True).click()

            # The new relationship is included in the complete project backup.
            with page.expect_download() as download:
                start_project_download(page, "new-model-alignment")
            archive = directory / "alignment.zip"
            download.value.save_as(archive)
            restored_context, restored = new_page(browser, errors)
            load_project(restored, "independent", archive)
            ready(restored, "independent")
            restored_relation = snapshot(restored, "independent")["project"]["workspace"]["transfer"]
            assert restored_relation["sourceMap"]["mapId"] == snapshot(restored, "map")["mapId"]
            assert restored_relation["localToMap"] == relation["localToMap"]
            conversion = open_transfer(restored)
            assert pose_values(conversion) == [14, -8, 2, 0, 0, 0]
            expect(conversion.get_by_label("放置定位基准")).to_have_value("origin")
            conversion.get_by_label("放置 X", exact=True).fill("21")
            with restored.expect_navigation(wait_until="networkidle"):
                conversion.get_by_role("button", name="放置并进入地图", exact=True).click()
            ready(restored, "map")
            enter_current_independent(restored)
            conversion = open_transfer(restored)
            assert pose_values(conversion) == [21, -8, 2, 0, 0, 0]
            conversion.get_by_role("button", name="关闭示教转换", exact=True).click()
            restored_context.close()
            print("new_alignment_preserves_model_refresh_history_other_placements_archive_and_later_modification=ok", flush=True)

            # If the map disappears after file selection, creation must not bind
            # the new model to stale metadata or archive the current group.
            before = snapshot(page, "independent")
            before_history = history(page)
            dialog = open_new_group(page)
            choose_new_model(page, dialog)
            choose_new_matrix(page, dialog)
            expect(dialog.get_by_text("矩阵已校验", exact=True)).to_be_visible()
            page.evaluate("""async () => {
              const database = await new Promise((resolve, reject) => {
                const request = indexedDB.open('atlas-route-studio', 1);
                request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
              });
              await new Promise((resolve, reject) => {
                const transaction = database.transaction('workspace-session', 'readwrite');
                transaction.objectStore('workspace-session').delete('workspace-map:map');
                transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
              });
              database.close();
            }""")
            dialog.get_by_role("button", name="创建独立示教", exact=True).click()
            expect(dialog.get_by_role("alert")).to_contain_text("地图示教已变化")
            assert snapshot(page, "independent")["mapId"] == before["mapId"]
            assert snapshot(page, "independent")["project"]["workspace"]["transfer"] == before["project"]["workspace"]["transfer"]
            assert history(page) == before_history
            dialog.get_by_role("button", name="取消", exact=True).click()
            dialog = open_new_group(page)
            expect(dialog.get_by_text("未加载地图示教，暂不可选择转换矩阵", exact=True)).to_be_visible()
            expect(dialog.get_by_role("button", name="加载转换矩阵", exact=True)).to_be_disabled()
            context.close()
            assert not errors, errors
            print("invalid_matrix_cancel_responsive_dialog_and_map_change_atomic_guard=ok", flush=True)
        finally:
            browser.close()


if __name__ == "__main__":
    run()
