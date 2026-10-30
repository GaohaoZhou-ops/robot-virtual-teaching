"""Exercise persisted recent projects with real browser filesystem handles."""
import base64
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from archive_helpers import start_project_download
from project_load_modes_smoke import BASE_URL, CHROME, assert_mode, home, make_fixtures, open_loader, wait_ready, workspaces
from topbar_tools_helpers import topbar_action


def history(page):
    return page.evaluate("""async () => {
      const { listRecentProjects } = await import('/src/features/workspace/model/recentProjects.js');
      return (await listRecentProjects()).map(({handle, ...record}) => ({...record, hasHandle: Boolean(handle)}));
    }""")


def recent_list(page, mode='map'):
    home(page, mode)
    toggle = page.locator('.recent-projects__toggle')
    if toggle.get_attribute('aria-expanded') == 'false':
        toggle.click()
    return page.locator('.recent-projects__list')


def set_file_picker(page, path):
    page.evaluate("""async ({name, bytes}) => {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('inputs', {create: true});
      const handle = await folder.getFileHandle(name, {create: true});
      const writer = await handle.createWritable();
      await writer.write(Uint8Array.from(atob(bytes), c => c.charCodeAt(0)));
      await writer.close();
      window.showOpenFilePicker = async () => [handle];
    }""", {'name': path.name, 'bytes': base64.b64encode(path.read_bytes()).decode()})


def set_save_picker(page, name, folder='saved', error=None):
    page.evaluate("""({name, folder, error}) => {
      window.showSaveFilePicker = async () => {
        if (error === 'AbortError') throw new DOMException('cancelled', error);
        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle(folder, {create: true});
        const handle = await directory.getFileHandle(name, {create: true});
        if (error) return {name, createWritable: async () => {throw new Error('test write failed');}};
        return handle;
      };
    }""", {'name': name, 'folder': folder, 'error': error})


def save_as(page, name, folder='saved'):
    set_save_picker(page, name, folder)
    topbar_action(page, '另存为工程', exact=True).click()
    page.get_by_text(f'工程已保存 · {name}', exact=False).wait_for()


def open_recent(page, name, mode, reload=False):
    before = next(record['updatedAt'] for record in history(page) if record['name'] == name)
    if reload:
        page.evaluate('window.__recentDocument = true')
    page.get_by_role('button', name=f'打开最近工程 {name}', exact=True).click()
    if reload:
        page.wait_for_function('!window.__recentDocument')
    page.wait_for_function("""async ({name, before}) => {
      const { listRecentProjects } = await import('/src/features/workspace/model/recentProjects.js');
      const record = (await listRecentProjects())[0];
      return record?.name === name && record.updatedAt !== before;
    }""", arg={'name': name, 'before': before})
    assert_mode(page, mode)


def run():
    errors = []
    with tempfile.TemporaryDirectory(prefix='atlas-recent-projects-') as temporary, sync_playwright() as playwright:
        fixtures = Path(temporary)
        directory_files = make_fixtures(fixtures)
        browser = playwright.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 900}, accept_downloads=True)
            page.set_default_timeout(30_000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(BASE_URL, wait_until='networkidle')
            wait_ready(page)
            assert not history(page)
            recent_list(page)
            page.get_by_text('暂无历史工程。', exact=False).wait_for()
            page.screenshot(path='/tmp/atlas-recent-empty.png', animations='disabled')

            with page.expect_file_chooser() as chooser:
                page.get_by_role('button', name='新建工程', exact=True).click()
            chooser.value.set_files(str(Path(__file__).parent / 'fixtures' / 'rotation-map.ply'))
            assert_mode(page, 'map')
            assert not history(page), 'An unsaved workspace is not a local project record'

            # Opening a native file remembers a cloneable handle after successful import.
            set_file_picker(page, fixtures / 'map.zip')
            open_loader(page, 'map')
            page.get_by_role('button', name='加载工程引导文件', exact=True).click()
            assert_mode(page, 'map')
            assert history(page)[0]['hasHandle']
            assert history(page)[0]['name'] == 'map.zip'

            # Cancelled and failed saves must not create records.
            for failure in ('AbortError', 'write'):
                before = history(page)
                set_save_picker(page, 'failed.zip', error=failure)
                topbar_action(page, '另存为工程', exact=True).click()
                if failure == 'write':
                    page.get_by_text('工程保存失败：test write failed', exact=True).wait_for()
                else:
                    expect(topbar_action(page, '另存为工程', exact=True)).to_be_enabled()
                assert history(page) == before

            for index in range(11):
                save_as(page, f'工位-{index:02d}.zip')
            records = history(page)
            assert [record['name'] for record in records] == [f'工位-{index:02d}.zip' for index in range(10, 0, -1)]

            # Saving again moves the same actual file to the front; same-name files remain distinct.
            save_as(page, '工位-04.zip')
            assert history(page)[0]['id'] == next(r['id'] for r in records if r['name'] == '工位-04.zip')
            save_as(page, '工位-04.zip', folder='another-location')
            assert len([record for record in history(page) if record['name'] == '工位-04.zip']) == 2
            before = history(page)
            topbar_action(page, '保存工程', exact=True).click()
            page.get_by_text('工程已保存 · 工位-04.zip', exact=False).wait_for()
            assert [record['id'] for record in history(page)] == [record['id'] for record in before]

            recent_list(page)
            expect(page.locator('.recent-projects__list li')).to_have_count(10)
            page.screenshot(path='/tmp/atlas-recent-desktop.png', animations='disabled')
            page.set_viewport_size({'width': 390, 'height': 844})
            page.locator('.recent-projects').scroll_into_view_if_needed()
            page.screenshot(path='/tmp/atlas-recent-mobile.png', animations='disabled')
            page.set_viewport_size({'width': 1440, 'height': 900})
            page.reload(wait_until='networkidle')
            wait_ready(page)
            assert [r['id'] for r in history(page)] == [r['id'] for r in before]
            recent_list(page)
            open_recent(page, '工位-08.zip', 'map')
            assert history(page)[0]['name'] == '工位-08.zip'
            assert any(state['tasks'] == ['map-task'] for state in workspaces(page).values())

            # A different teaching mode is selected from the record, even with Map selected on home.
            set_file_picker(page, fixtures / 'independent.zip')
            open_loader(page, 'independent')
            page.get_by_role('button', name='加载工程引导文件', exact=True).click()
            assert_mode(page, 'independent')
            recent_list(page, 'map')
            open_recent(page, 'independent.zip', 'independent')
            # Saving both workspaces exercises the reload-based collection import branch.
            save_as(page, '双模式工程.zip')
            recent_list(page, 'map')
            open_recent(page, '双模式工程.zip', 'independent', reload=True)
            assert history(page)[0]['name'] == '双模式工程.zip'
            assert {state['mode'] for state in workspaces(page).values()} == {'map', 'independent'}

            # Directory records retain a path and can restore automatic directory saving.
            page.evaluate("""async files => {
              const root = await navigator.storage.getDirectory();
              const directory = await root.getDirectoryHandle('装配工程目录', {create: true});
              for (const [path, bytes] of Object.entries(files)) {
                const segments = path.split('/'); let parent = directory;
                for (const segment of segments.slice(0, -1)) parent = await parent.getDirectoryHandle(segment, {create: true});
                const file = await parent.getFileHandle(segments.at(-1), {create: true});
                const writer = await file.createWritable();
                await writer.write(Uint8Array.from(atob(bytes), c => c.charCodeAt(0))); await writer.close();
              }
              window.showDirectoryPicker = async () => directory;
            }""", directory_files['map'])
            open_loader(page, 'map')
            page.get_by_role('button', name='选择其他工程目录', exact=True).click()
            assert_mode(page, 'map')
            assert history(page)[0]['path'] == '装配工程目录/config/project.json'
            recent_list(page)
            page.reload(wait_until='networkidle')
            wait_ready(page)
            recent_list(page)
            open_recent(page, '装配工程目录', 'map')
            page.locator('.project-directory-guard.is-synced').wait_for()

            # Permissions are requested in the click activation; rejection preserves the workspace and history.
            recent_list(page)
            before = history(page)
            previous_workspace = workspaces(page)
            page.evaluate("""() => {
              window.__originalPermission = FileSystemHandle.prototype.requestPermission;
              FileSystemHandle.prototype.requestPermission = async function(options) {
                window.__permissionCall = {options, activated: navigator.userActivation.isActive};
                return 'denied';
              };
            }""")
            page.get_by_role('button', name='打开最近工程 工位-08.zip', exact=True).click()
            dialog = page.get_by_role('alertdialog', name='工程加载失败')
            expect(dialog).to_contain_text('未获得工程访问权限')
            assert page.evaluate('window.__permissionCall') == {'options': {'mode': 'read'}, 'activated': True}
            dialog.get_by_role('button', name='关闭', exact=True).click()
            assert history(page) == before
            assert workspaces(page) == previous_workspace
            page.evaluate('() => { FileSystemHandle.prototype.requestPermission = window.__originalPermission; }')
            page.evaluate("""async () => {
              const root = await navigator.storage.getDirectory();
              const saved = await root.getDirectoryHandle('saved');
              await saved.removeEntry('工位-08.zip');
            }""")
            page.get_by_role('button', name='打开最近工程 工位-08.zip', exact=True).click()
            expect(dialog).to_contain_text('可能已移动或删除')
            dialog.get_by_role('button', name='关闭', exact=True).click()
            assert history(page) == before
            page.get_by_role('button', name='移除最近工程记录 工位-08.zip', exact=True).click()
            expect(page.get_by_role('button', name='打开最近工程 工位-08.zip', exact=True)).to_have_count(0)

            # Downloads have an honest location hint and recover through the file chooser.
            open_recent(page, '装配工程目录', 'map')
            with page.expect_download() as download:
                start_project_download(page, '下载工程')
            downloaded = fixtures / '下载工程.zip'
            download.value.save_as(downloaded)
            page.get_by_text('工程下载已开始', exact=False).wait_for()
            recent_list(page)
            latest = history(page)[0]
            assert latest['name'] == '下载工程.zip' and not latest['hasHandle']
            row = page.locator('li', has=page.get_by_role('button', name='打开最近工程 下载工程.zip', exact=True))
            expect(row).to_contain_text('需重新选择文件')
            page.evaluate('window.showOpenFilePicker = undefined')
            page.evaluate('window.__recentDocument = true')
            with page.expect_file_chooser() as chooser:
                page.get_by_role('button', name='打开最近工程 下载工程.zip', exact=True).click()
            chooser.value.set_files(str(downloaded))
            page.wait_for_function('!window.__recentDocument')
            assert_mode(page, 'map')
            assert history(page)[0]['id'] == latest['id']

            # Existing installations keep the last file/directory from the previous version.
            legacy = browser.new_page()
            legacy.goto(BASE_URL, wait_until='networkidle')
            wait_ready(legacy)
            legacy.evaluate("""async () => {
              const root = await navigator.storage.getDirectory();
              const handle = await root.getFileHandle('旧版已保存工程.zip', {create: true});
              const { rememberProjectSaveTarget } = await import('/src/features/workspace/model/projectSaveTarget.js');
              const { saveProjectDirectoryBinding } = await import('/src/features/workspace/model/projectDirectoryStore.js');
              await rememberProjectSaveTarget({mapId: 'old', teachingSpaceMode: 'map', handle});
              await rememberProjectSaveTarget({mapId: 'old-independent', teachingSpaceMode: 'independent', handle});
              const directory = await root.getDirectoryHandle('旧版默认目录', {create: true});
              await saveProjectDirectoryBinding({handle: directory, teachingSpaceMode: 'map'});
              await new Promise((resolve, reject) => {
                const request = indexedDB.deleteDatabase('atlas-recent-projects');
                request.onsuccess = resolve; request.onerror = () => reject(request.error);
              });
            }""")
            legacy.reload(wait_until='networkidle')
            wait_ready(legacy)
            assert {record['name'] for record in history(legacy)} == {'旧版已保存工程.zip', '旧版默认目录'}
            assert len(history(legacy)) == 2, 'The same legacy ZIP in both modes is only one record'
            legacy.evaluate("""async () => {
              const { listRecentProjects, removeRecentProject } = await import('/src/features/workspace/model/recentProjects.js');
              await Promise.all((await listRecentProjects()).map(record => removeRecentProject(record.id)));
            }""")
            legacy.reload(wait_until='networkidle')
            wait_ready(legacy)
            assert not history(legacy), 'Removed legacy records must not be seeded again'
            legacy.close()

            assert not errors, errors
            print('recent projects: limit, ordering, handle identity, persistence, modes, collection, directory, permissions, removal, downloads and legacy migration passed')
        finally:
            browser.close()


if __name__ == '__main__':
    run()
