from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from independent_teaching_history_ui_smoke import PLY, history, new_group
from linked_project_ui_smoke import seed_linked, state
from project_save_target_ui_smoke import switch_mode
from teaching_transfer_ui_smoke import BASE_URL, CHROME, ready, snapshot
from topbar_tools_helpers import topbar_action


def open_picker(page):
    topbar_action(page, "切换到独立示教", exact=True).click()
    dialog = page.get_by_role("dialog", name="选择独立示教", exact=True)
    expect(dialog).to_be_visible()
    expect(page.locator(".app-shell")).to_have_attribute("data-teaching-space-mode", "map")
    return dialog


def choose(page, dialog, map_id):
    with page.expect_navigation(wait_until="networkidle"):
        dialog.locator(f'li[data-map-id="{map_id}"]').get_by_role("button").click()
    ready(page, "independent")
    expect(page.get_by_role("dialog", name="选择独立示教", exact=True)).to_have_count(0)
    assert snapshot(page, "independent")["mapId"] == map_id


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            page.set_default_timeout(30_000)
            page.on("pageerror", lambda error: errors.append(str(error)))
            seed_linked(page, "map")
            original = state(page)
            source = snapshot(page, "independent")
            source_id = source["mapId"]
            source_name = source["project"]["map"]["fileName"]

            # A single current group keeps the original direct-switch behavior.
            switch_mode(page, "independent")
            expect(page.get_by_role("dialog", name="选择独立示教", exact=True)).to_have_count(0)
            assert state(page) == original

            # Same filename, different group: both must remain selectable.
            new_group(page, {"name": source_name, "mimeType": "application/octet-stream", "buffer": PLY.read_bytes()})
            second_id = snapshot(page, "independent")["mapId"]
            page.get_by_role("button", name="新建示教任务", exact=True).click()
            task_dialog = page.get_by_role("dialog", name="新建示教任务", exact=True)
            task_dialog.get_by_label("新示教任务名称").fill("第二组对象")
            task_dialog.get_by_role("button", name="添加当前位置为停车点", exact=True).click()
            task_dialog.get_by_role("button", name="创建任务", exact=True).click()
            switch_mode(page, "map")
            saved = state(page)
            archived = history(page)
            assert saved["states"]["map"] == original["states"]["map"]
            assert saved["states"]["independent"]["tasks"][0]["name"] == "第二组对象"

            dialog = open_picker(page)
            expect(dialog.locator("li")).to_have_count(2)
            expect(dialog.locator("li strong")).to_have_text([Path(source_name).stem, source_name])
            expect(dialog.locator('[data-workspace-kind="current"]')).to_contain_text("上次使用")
            expect(dialog.locator('[data-workspace-kind="current"]')).to_contain_text("第二组对象")
            expect(dialog.locator('[data-workspace-kind="history"]')).to_contain_text("2 组姿态")
            page.screenshot(path="/tmp/atlas-independent-picker.png", full_page=True, animations="disabled")
            # Cancel and Escape must not swap/archive any group.
            dialog.get_by_role("button", name="取消", exact=True).click()
            expect(dialog).to_have_count(0)
            assert state(page) == saved
            assert history(page) == archived
            dialog = open_picker(page)
            dialog.get_by_role("button", name="取消", exact=True).focus()
            page.keyboard.press("Tab")
            expect(dialog.get_by_role("button", name="关闭独立示教选择", exact=True)).to_be_focused()
            page.keyboard.press("Escape")
            expect(dialog).to_have_count(0)
            assert state(page) == saved
            assert history(page) == archived

            # Last-used selection stays in the current slot without extra history.
            choose(page, open_picker(page), second_id)
            assert state(page) == saved
            assert history(page) == archived
            switch_mode(page, "map")

            # Failed restoration rolls back after writes, keeps the picker usable.
            dialog = open_picker(page)
            page.evaluate("""() => {
              const put = IDBObjectStore.prototype.put;
              window.restorePickerPut = () => { IDBObjectStore.prototype.put = put; };
              IDBObjectStore.prototype.put = function(record, ...args) {
                if (this.name === 'workspace-session' && record.key === 'independent-history') {
                  throw new DOMException('测试选择工程缓存空间不足', 'QuotaExceededError');
                }
                return put.call(this, record, ...args);
              };
            }""")
            dialog.locator(f'li[data-map-id="{source_id}"]').get_by_role("button").click()
            expect(dialog.get_by_role("alert")).to_have_text("测试选择工程缓存空间不足")
            expect(dialog.get_by_role("button", name="取消", exact=True)).to_be_enabled()
            page.evaluate("() => window.restorePickerPut()")
            assert state(page) == saved
            assert history(page) == archived

            # Restore the older group with its poses, media, robot and binding.
            choose(page, dialog, source_id)
            assert state(page) == original
            assert [entry["mapId"] for entry in history(page)] == [second_id]
            switch_mode(page, "map")
            dialog = open_picker(page)
            expect(dialog.locator('[data-workspace-kind="current"]')).to_have_attribute("data-map-id", source_id)
            expect(dialog.locator('[data-workspace-kind="history"]')).to_have_attribute("data-map-id", second_id)
            choose(page, dialog, second_id)
            assert state(page) == saved
            assert [entry["mapId"] for entry in history(page)] == [source_id]
            print("independent_picker_single_multiple_cancel_and_full_restore=ok", flush=True)
            switch_mode(page, "map")

            # A change in another tab cannot silently activate a different group.
            dialog = open_picker(page)
            replacement_id = second_id + "-replacement"
            page.evaluate("""async mapId => {
              const store = await import('/src/lib/sessionStore.js');
              const { sessionId } = await store.fetchServiceSession();
              const current = await store.loadWorkspaceSnapshot(sessionId, 'independent');
              await store.saveWorkspaceMap(sessionId, mapId, current.map.name, { ...current.map, mapId }, 'independent');
              await store.saveWorkspaceConfig(sessionId, mapId, current.config.config, 'independent');
            }""", replacement_id)
            dialog.locator(f'li[data-map-id="{second_id}"]').get_by_role("button").click()
            expect(dialog.get_by_role("alert")).to_have_text("所选工程已发生变化，请重新选择要进入的工程")
            expect(page.locator(".app-shell")).to_have_attribute("data-teaching-space-mode", "map")
            assert snapshot(page, "independent")["mapId"] == replacement_id
            dialog.get_by_role("button", name="取消", exact=True).click()
            dialog = open_picker(page)
            expect(dialog.locator('[data-workspace-kind="current"]')).to_have_attribute("data-map-id", replacement_id)
            dialog.get_by_role("button", name="取消", exact=True).click()

            # Home-page entry retains the requested teaching-data destination.
            topbar_action(page, "返回主页面", exact=True).click()
            page.get_by_role("radio", name="独立示教").click()
            page.get_by_role("button", name="示教数据", exact=True).click()
            dialog = page.get_by_role("dialog", name="选择独立示教", exact=True)
            with page.expect_navigation(wait_until="networkidle"):
                dialog.locator(f'li[data-map-id="{source_id}"]').get_by_role("button").click()
            page.wait_for_url(f"{BASE_URL}/teaching-data")
            expect(page.locator('.app-shell[data-app-page="workbench"]')).to_have_attribute(
                "data-teaching-space-mode", "independent")
            expect(page.locator('.app-shell[data-app-page="teaching-data"]')).to_be_visible()
            page.goto(f"{BASE_URL}/workbench", wait_until="networkidle")
            ready(page, "independent")
            assert state(page) == original
            switch_mode(page, "map")

            # Only one archived group and no active slot still switches directly.
            page.evaluate("""async () => {
              const request = indexedDB.open('atlas-route-studio', 1);
              const database = await new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              });
              const tx = database.transaction('workspace-session', 'readwrite');
              const store = tx.objectStore('workspace-session');
              store.delete('workspace-map:independent');
              store.delete('workspace-config:independent');
              const indexRequest = store.get('workspace-slots');
              indexRequest.onsuccess = () => {
                const index = indexRequest.result;
                delete index.modes.independent;
                store.put(index);
              };
              await new Promise((resolve, reject) => {
                tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
              });
              database.close();
            }""")
            page.reload(wait_until="networkidle")
            ready(page, "map")
            switch_mode(page, "independent")
            ready(page, "independent")
            expect(page.get_by_role("dialog", name="选择独立示教", exact=True)).to_have_count(0)
            assert snapshot(page, "independent")["mapId"] == replacement_id
            assert state(page)["states"] == saved["states"]
            assert history(page) == []

            assert not errors, errors
            print("independent_picker_quota_rollback_and_concurrent_replacement=ok")
            print("independent_picker_teaching_data_destination_and_single_history=ok")
        finally:
            browser.close()


if __name__ == "__main__":
    run()
