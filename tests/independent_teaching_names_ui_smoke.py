import json
import tempfile
import zipfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from archive_helpers import start_project_download
from export_separation_ui_smoke import load_project
from independent_teaching_history_ui_smoke import PLY, choose_new_model, open_new_group
from new_independent_teaching_ui_smoke import choose_new_matrix, create
from teaching_transfer_matrix_ui_smoke import pose_values
from teaching_transfer_ui_smoke import CHROME, open_transfer, ready, seed, snapshot
from topbar_tools_helpers import topbar_action


def open_cache(page, count):
    topbar_action(page, "独立示教缓存", exact=True).click()
    dialog = page.get_by_role("dialog", name="加载工程", exact=True)
    expect(dialog.locator(".project-load-history li")).to_have_count(count)
    return dialog


def close_cache(dialog):
    dialog.get_by_role("button", name="关闭加载工程窗口", exact=True).click()


def rename_dialog(page, cache, label):
    cache.get_by_role("button", name=f"重命名独立示教 {label}", exact=True).click()
    dialog = page.get_by_role("dialog", name="重命名独立示教", exact=True)
    expect(dialog).to_be_visible()
    return dialog


def save_name(dialog, name):
    dialog.get_by_label("独立示教名称", exact=True).fill(name)
    dialog.get_by_role("button", name="保存名称", exact=True).click()
    expect(dialog).to_have_count(0)


def cache_state(page):
    return page.evaluate("""async () => {
      const store = await import('/src/lib/sessionStore.js');
      const { sessionId } = await store.fetchServiceSession();
      const { companionWorkspace, independentHistory } = await store.loadProjectCompanions(sessionId, 'map');
      return [companionWorkspace, ...independentHistory].map(item => ({
        id: item.map.mapId, name: item.config.config.project.workspace.independentTeachingName || '',
        sourceName: item.map.name, sourceHash: item.map.sourceHash,
        positions: [...new Float32Array(item.map.positionBuffer)], project: item.config.config.project,
      }));
    }""")


def invariant(value):
    project = value["project"]
    return {key: project.get(key) for key in ["map", "robot", "waypoints", "paths", "virtualTeaching", "jointPoses"]}


def inject_failure(page, key):
    page.evaluate("""key => {
      const put = IDBObjectStore.prototype.put;
      window.restoreNamePut = () => { IDBObjectStore.prototype.put = put; };
      IDBObjectStore.prototype.put = function(record, ...args) {
        if (this.name === 'workspace-session' && record.key === key
          && (key !== 'workspace-slots' || record.modes?.independent?.teachingName === '不应保存的名称')) {
          throw new DOMException('测试名称缓存写入失败', 'QuotaExceededError');
        }
        return put.call(this, record, ...args);
      };
    }""", key)


def run():
    errors = []
    with tempfile.TemporaryDirectory(prefix="atlas-new-independent-names-") as temporary, sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            page.set_default_timeout(30_000)
            page.on("pageerror", lambda error: errors.append(str(error)))
            seed(page, ["map", "independent"], "independent")
            original = snapshot(page, "independent")
            original_map = snapshot(page, "map")
            source_name = original["project"]["map"]["fileName"]
            expect(page.get_by_role("button", name="独立示教历史", exact=True, include_hidden=True)).to_have_count(0)
            cache = open_cache(page, 1)
            dialog = rename_dialog(page, cache, source_name)
            dialog.get_by_label("独立示教名称", exact=True).fill("   ")
            expect(dialog.get_by_role("button", name="保存名称", exact=True)).to_be_disabled()
            page.keyboard.press("Escape")
            expect(dialog).to_have_count(0)
            expect(cache).to_be_visible()
            assert not snapshot(page, "independent")["project"]["workspace"].get("independentTeachingName")
            dialog = rename_dialog(page, cache, source_name)
            dialog.get_by_label("独立示教名称", exact=True).fill("工位 A · 左侧阀门")
            page.screenshot(path="/tmp/atlas-independent-teaching-rename.png", animations="disabled")
            save_name(dialog, "  工位 A · 左侧阀门  ")
            expect(cache.locator(".project-load-history li strong")).to_have_text("工位 A · 左侧阀门")
            close_cache(cache)
            expect(page.locator(".map-identity strong")).to_have_text("工位 A · 左侧阀门")
            page.reload(wait_until="networkidle")
            ready(page, "independent")
            renamed = snapshot(page, "independent")
            assert renamed["project"]["workspace"]["independentTeachingName"] == "工位 A · 左侧阀门"
            assert renamed["mapId"] == original["mapId"] and renamed["positions"] == original["positions"]
            assert invariant(renamed) == invariant(original)
            assert snapshot(page, "map") == original_map

            # Another group uses the same source filename, but a readable name
            # and its own matrix. Editing the name before model selection sticks.
            dialog = open_new_group(page)
            name_field = dialog.get_by_label("独立示教名称", exact=True)
            name_field.fill("工位 B · 右侧阀门")
            choose_new_model(page, dialog, {"name": source_name, "mimeType": "application/octet-stream", "buffer": PLY.read_bytes()})
            expect(name_field).to_have_value("工位 B · 右侧阀门")
            choose_new_matrix(page, dialog)
            page.screenshot(path="/tmp/atlas-independent-teaching-new-name.png", animations="disabled")
            create(page, dialog)
            group_b = snapshot(page, "independent")
            assert group_b["project"]["workspace"]["independentTeachingName"] == "工位 B · 右侧阀门"
            assert group_b["project"]["map"]["fileName"] == source_name
            relation = group_b["project"]["workspace"]["transfer"]
            cache = open_cache(page, 2)
            save_name(rename_dialog(page, cache, "工位 A · 左侧阀门"), "产线 1 · 左侧阀门")
            states = cache_state(page)
            cached_a = next(item for item in states if item["id"] == original["mapId"])
            assert cached_a["name"] == "产线 1 · 左侧阀门"
            assert invariant(cached_a) == invariant(original)
            assert cached_a["positions"] == original["positions"]
            assert snapshot(page, "independent")["mapId"] == group_b["mapId"]
            page.screenshot(path="/tmp/atlas-independent-teaching-cache-names.png", animations="disabled")

            # Both rename transactions roll back after the configuration write.
            for label, key in [("产线 1 · 左侧阀门", "independent-history"), ("工位 B · 右侧阀门", "workspace-slots")]:
                before = {item["id"]: item["name"] for item in cache_state(page)}
                dialog = rename_dialog(page, cache, label)
                inject_failure(page, key)
                dialog.get_by_label("独立示教名称", exact=True).fill("不应保存的名称")
                dialog.get_by_role("button", name="保存名称", exact=True).click()
                expect(dialog.get_by_role("alert")).to_contain_text("测试名称缓存写入失败")
                page.evaluate("() => window.restoreNamePut()")
                assert {item["id"]: item["name"] for item in cache_state(page)} == before
                dialog.get_by_role("button", name="取消", exact=True).click()

            # An intervening rename cannot silently be overwritten by a stale dialog.
            dialog = rename_dialog(page, cache, "产线 1 · 左侧阀门")
            page.evaluate("""async id => {
              const store = await import('/src/lib/sessionStore.js');
              const { sessionId } = await store.fetchServiceSession();
              const entry = (await store.listIndependentWorkspaces(sessionId)).find(item => item.mapId === id);
              await store.renameIndependentWorkspace(sessionId, { ...entry, expectedName: entry.teachingName, name: '产线 2 · 左侧阀门' });
            }""", original["mapId"])
            dialog.get_by_label("独立示教名称", exact=True).fill("过期名称")
            dialog.get_by_role("button", name="保存名称", exact=True).click()
            expect(dialog.get_by_role("alert")).to_contain_text("名称已被修改")
            dialog.get_by_role("button", name="取消", exact=True).click()
            close_cache(cache)
            cache = open_cache(page, 2)
            expect(cache.locator(".project-load-history li strong")).to_have_text(["工位 B · 右侧阀门", "产线 2 · 左侧阀门"])
            close_cache(cache)
            print("current_and_cached_group_names_preserve_data_cancel_validation_and_atomicity=ok", flush=True)

            with page.expect_download() as download:
                start_project_download(page, "named-independent-project")
            archive = Path(temporary) / "named.zip"
            download.value.save_as(archive)
            with zipfile.ZipFile(archive) as zipped:
                manifest = json.loads(zipped.read("manifest.json"))
                descriptors = [manifest["workspaces"]["independent"], *manifest["independentHistory"]]
                assert {json.loads(zipped.read(item["prefix"] + "config/project.json"))["workspace"]["independentTeachingName"] for item in descriptors} == {"工位 B · 右侧阀门", "产线 2 · 左侧阀门"}
            restored = browser.new_page(viewport={"width": 1440, "height": 1000})
            restored.on("pageerror", lambda error: errors.append(str(error)))
            load_project(restored, "independent", archive)
            ready(restored, "independent")
            expect(restored.locator(".map-identity strong")).to_have_text("工位 B · 右侧阀门")
            restored_b = snapshot(restored, "independent")
            assert restored_b["project"]["workspace"]["transfer"]["localToMap"] == relation["localToMap"]
            cache = open_cache(restored, 2)
            with restored.expect_navigation(wait_until="networkidle"):
                cache.get_by_role("button", name="恢复独立示教 产线 2 · 左侧阀门", exact=True).click()
            ready(restored, "independent")
            expect(restored.locator(".map-identity strong")).to_have_text("产线 2 · 左侧阀门")
            assert snapshot(restored, "independent")["project"]["map"]["fileName"] == source_name
            restored.reload(wait_until="networkidle")
            ready(restored, "independent")
            expect(restored.locator(".map-identity strong")).to_have_text("产线 2 · 左侧阀门")
            with restored.expect_navigation(wait_until="networkidle"):
                topbar_action(restored, "切换到地图示教", exact=True).click()
            ready(restored, "map")
            topbar_action(restored, "切换到独立示教", exact=True).click()
            picker = restored.get_by_role("dialog", name="选择独立示教", exact=True)
            expect(picker.locator("li strong")).to_have_text(["产线 2 · 左侧阀门", "工位 B · 右侧阀门"])
            with restored.expect_navigation(wait_until="networkidle"):
                picker.get_by_role("button", name="进入独立示教 工位 B · 右侧阀门", exact=True).click()
            ready(restored, "independent")
            conversion = open_transfer(restored)
            assert pose_values(conversion) == [14, -8, 2, 0, 0, 0]
            expect(conversion.locator(".transfer-route strong").first).to_have_text("工位 B · 右侧阀门")
            assert not errors, errors
            print("named_groups_same_source_refresh_switch_archive_fresh_device_and_binding=ok", flush=True)
        finally:
            browser.close()


if __name__ == "__main__":
    run()
