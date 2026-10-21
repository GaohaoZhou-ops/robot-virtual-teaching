"""Destructive cache actions run only in a disposable browser profile."""
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from teaching_transfer_ui_smoke import BASE_URL, CHROME, seed, ready, snapshot
from topbar_tools_helpers import topbar_action


def cache(page, count):
    topbar_action(page, '独立示教缓存', exact=True).click()
    dialog = page.get_by_role('dialog', name='加载工程', exact=True)
    expect(dialog.locator('.project-load-history li')).to_have_count(count)
    return dialog


def stored(page):
    return page.evaluate("""async () => {
      const store = await import('/src/lib/sessionStore.js');
      return await store.listIndependentWorkspaces((await store.fetchServiceSession()).sessionId);
    }""")


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        page.set_default_timeout(30000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            seed(page, ['map', 'independent'], 'independent')
            map_before = snapshot(page, 'map')
            page.evaluate("""async () => {
              const store = await import('/src/lib/sessionStore.js');
              const { teachingTransferFixture } = await import('/tests/teaching_transfer_helpers.mjs');
              const { sessionId } = await store.fetchServiceSession();
              for (const id of ['cache-b', 'cache-c']) {
                const fixture = teachingTransferFixture('independent');
                fixture.map.mapId = id; fixture.map.teachingGroupId = id; fixture.map.name = id + '.ply';
                fixture.config.config.project.workspace.independentTeachingName = id;
                const previous = await store.loadWorkspaceSnapshot(sessionId, 'independent');
                await store.switchIndependentWorkspace(sessionId, {activeMode: 'independent',
                  expectedConfig: previous.config, replacement: {map: fixture.map, config: fixture.config.config}});
              }
            }""")
            page.reload(wait_until='networkidle'); ready(page, 'independent')
            entries = stored(page)
            history = next(item for item in entries if item['historyId'] == 'cache-b')
            dialog = cache(page, 3)
            current_row = dialog.locator('li[data-workspace-kind="current"]')
            assert current_row.evaluate('(el) => getComputedStyle(el).backgroundColor') == 'rgba(244, 201, 93, 0.18)'
            target = dialog.get_by_role('button', name='删除独立示教缓存 cache-b', exact=True)
            target.click()
            confirm = page.get_by_role('alertdialog', name='删除独立示教缓存？', exact=True)
            expect(confirm.get_by_role('button', name='取消', exact=True)).to_be_focused()
            page.keyboard.press('Escape')
            expect(confirm).not_to_be_visible()
            expect(dialog).to_be_visible()
            assert len(stored(page)) == 3

            # A failed delete after the geometry delete was enqueued must roll
            # back both data and the history index, retaining the live workspace.
            page.evaluate("""() => {
              const original = IDBObjectStore.prototype.delete;
              window.restoreCacheDelete = () => { IDBObjectStore.prototype.delete = original; };
              IDBObjectStore.prototype.delete = function(key) {
                if (key === 'independent-history-config:cache-b') throw new Error('测试删除事务失败');
                return original.call(this, key);
              };
            }""")
            target.click(); confirm.get_by_role('button', name='确认删除', exact=True).click()
            expect(confirm.get_by_role('alert')).to_contain_text('测试删除事务失败')
            assert len(stored(page)) == 3
            page.evaluate('window.restoreCacheDelete()')
            confirm.get_by_role('button', name='确认删除', exact=True).click()
            expect(confirm).not_to_be_visible()
            expect(dialog.locator('.project-load-history li')).to_have_count(2)
            assert all(item.get('historyId') != history['historyId'] for item in stored(page))
            assert snapshot(page, 'map') == map_before
            page.screenshot(path='/tmp/atlas-cache-delete.png', full_page=True)
            page.reload(wait_until='networkidle'); ready(page, 'independent')
            assert len(stored(page)) == 2
            dialog = cache(page, 2)
            dialog.locator('li[data-workspace-kind="current"]').get_by_role('button', name='删除独立示教缓存 cache-c', exact=True).click()
            confirm = page.get_by_role('alertdialog', name='删除独立示教缓存？', exact=True)
            with page.expect_navigation(wait_until='networkidle'):
                confirm.get_by_role('button', name='确认删除', exact=True).click()
            home = page.locator('[data-app-page="home"][data-session-state="ready"]')
            expect(home).to_have_attribute('data-independent-workspace', 'empty')
            expect(home).to_have_attribute('data-map-workspace', 'cached')
            assert len(stored(page)) == 1
            assert snapshot(page, 'map') == map_before

            # Keep an open model editor in memory and a saved file on disk.
            page.get_by_role('button', name='模型编辑', exact=True).click()
            page.get_by_label('导入模型文件', exact=True).set_input_files(str(Path(__file__).parent / 'fixtures/rotation-map.ply'))
            expect(page.locator('[data-app-page="model-editor"]')).to_have_attribute('data-editor-state', 'ready')
            page.get_by_role('button', name='主页面', exact=True).click()
            page.evaluate("""async () => {
              const root = await navigator.storage.getDirectory();
              const handle = await root.getFileHandle('retained-export.zip', {create: true});
              const writer = await handle.createWritable(); await writer.write('export must survive'); await writer.close();
              const { rememberProjectSaveTarget } = await import('/src/lib/projectSaveTarget.js');
              await rememberProjectSaveTarget({teachingSpaceMode: 'map', mapId: 'saved', handle});
              const { saveProjectDirectoryBinding } = await import('/src/lib/projectDirectoryStore.js');
              await saveProjectDirectoryBinding({handle: root, teachingSpaceMode: 'map'});
              const db = await new Promise((resolve) => { const r=indexedDB.open('atlas-route-studio'); r.onsuccess=()=>resolve(r.result); });
              await new Promise((resolve, reject) => {
                const tx=db.transaction('workspace-session','readwrite'); tx.oncomplete=resolve; tx.onabort=()=>reject(tx.error);
                const s=tx.objectStore('workspace-session');
                s.put({key:'recovery-meta', recoveryId:'test-reset'});
                s.put({key:'recovery-map', mapId:'test-reset'});
                s.put({key:'recovery-config', mapId:'test-reset'});
                s.put({key:'work-sync:test-reset', checkpoint:{document:{teachingTasks:[{id:'old'}]}}});
              }); db.close();
              sessionStorage.setItem('atlas-project-import-progress','{}');
              localStorage.setItem('atlas-ipad-handoffs-v1','[{"id":"old"}]');
            }""")
            reset = page.get_by_role('button', name='全局重置', exact=True)
            expect(reset).to_be_visible()
            sync_box = page.locator('.start-page .work-sync').bounding_box()
            assert reset.bounding_box()['x'] > sync_box['x']
            reset.click()
            warning = page.get_by_role('alertdialog', name='确认全局重置？', exact=True)
            expect(warning).to_contain_text('全部地图示教、独立示教')
            expect(warning).to_contain_text('模型编辑缓存')
            warning.get_by_role('button', name='取消', exact=True).click()
            assert len(stored(page)) == 1
            page.get_by_role('button', name='模型编辑', exact=True).click()
            expect(page.locator('[data-app-page="model-editor"]')).to_have_attribute('data-editor-state', 'ready')
            page.get_by_role('button', name='主页面', exact=True).click()
            page.set_viewport_size({'width': 600, 'height': 900})
            expect(reset).to_be_in_viewport()
            reset.click()
            page.screenshot(path='/tmp/atlas-global-reset-warning.png', full_page=True)
            page.evaluate("""() => {
              const original = IDBObjectStore.prototype.clear;
              window.restoreCacheClear = () => { IDBObjectStore.prototype.clear = original; };
              IDBObjectStore.prototype.clear = function() {
                const request = original.call(this);
                if (this.name === 'workspace-session') throw new Error('测试全局重置事务失败');
                return request;
              };
            }""")
            warning.get_by_role('button', name='确认全局重置', exact=True).click()
            expect(warning.get_by_role('alert')).to_contain_text('测试全局重置事务失败')
            assert len(stored(page)) == 1
            assert snapshot(page, 'map') == map_before
            page.evaluate('window.restoreCacheClear()')
            with page.expect_navigation(wait_until='networkidle'):
                warning.get_by_role('button', name='确认全局重置', exact=True).click()
            expect(home).to_have_attribute('data-map-workspace', 'empty')
            expect(home).to_have_attribute('data-independent-workspace', 'empty')
            assert stored(page) == []
            remaining = page.evaluate("""async () => {
              const read = async (name, store) => {
                const db = await new Promise((resolve) => { const r=indexedDB.open(name); r.onsuccess=()=>resolve(r.result); });
                try { return await new Promise((resolve) => {const r=db.transaction(store).objectStore(store).getAll(); r.onsuccess=()=>resolve(r.result);}); }
                finally {db.close();}
              };
              const workspace=await read('atlas-route-studio','workspace-session');
              const bindings=await read('atlas-project-directory-bindings','bindings');
              const targets=await read('atlas-project-save-targets','targets');
              const root=await navigator.storage.getDirectory();
              return {workspace,bindings,targets, file: await (await (await root.getFileHandle('retained-export.zip')).getFile()).text(),
                progress:sessionStorage.getItem('atlas-project-import-progress'), tickets:localStorage.getItem('atlas-ipad-handoffs-v1')};
            }""")
            assert not remaining['bindings'] and not remaining['targets']
            assert not remaining['progress'] and not remaining['tickets']
            assert remaining['file'] == 'export must survive'
            assert all(item['key'] in ['meta', 'workspace-slots', 'workspace-config:map'] for item in remaining['workspace'])
            page.get_by_role('button', name='模型编辑', exact=True).click()
            expect(page.locator('[data-app-page="model-editor"]')).to_have_attribute('data-editor-state', 'empty')
            page.reload(wait_until='networkidle')
            expect(page.locator('[data-app-page="model-editor"]')).to_have_attribute('data-editor-state', 'empty')
            assert stored(page) == []
            assert not errors, errors
            print('Cache deletion cancel/rollback/current/history, map preservation, global reset, model memory, saved-file preservation and reload checks passed')
        finally:
            browser.close()


if __name__ == '__main__':
    run()
