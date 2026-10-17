import base64
import io
import json
import tempfile
import zipfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from dual_teaching_workspace_smoke import create_project, set_color_mode, wait_for_home
from export_separation_ui_smoke import CHROME, load_project, make_fixtures, wait_ready
from project_export_save_ui_smoke import SAVE_PICKER
from topbar_tools_helpers import topbar_action


def read_saved(page, name):
    encoded = page.evaluate('''async name => {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('chosen-export-folder');
      const file = await (await folder.getFileHandle(name)).getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
    }''', name)
    data = base64.b64decode(encoded)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return data, json.loads(archive.read('config/project.json'))


def save_as(page, name):
    page.evaluate('name => window.__saveChoice = { name }', name)
    topbar_action(page, '另存为工程', exact=True).click()
    page.get_by_text(f'工程已保存 · {name}', exact=False).wait_for()
    save = topbar_action(page, '保存工程', exact=True)
    expect(save).to_be_enabled()
    expect(save).to_have_attribute('title', f'覆盖保存到 {name}')


def save(page, name):
    calls = page.evaluate('window.__saveCalls.length')
    topbar_action(page, '保存工程', exact=True).click()
    expect(page.locator('button[aria-label="保存工程"]')).to_have_attribute('data-project-export-state', 'ready')
    page.get_by_text(f'工程已保存 · {name}', exact=False).wait_for()
    assert page.evaluate('window.__saveCalls.length') == calls, 'Save must reuse the existing handle'


def switch_mode(page, mode):
    label = '地图示教' if mode == 'map' else '独立示教'
    topbar_action(page, f'切换到{label}', exact=True).click()
    expect(page.locator('.app-shell[data-app-page="workbench"]')).to_have_attribute('data-teaching-space-mode', mode)
    wait_ready(page)


def run():
    with tempfile.TemporaryDirectory(prefix='atlas-save-target-') as temporary, sync_playwright() as p:
        directory = Path(temporary)
        make_fixtures(directory)
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME) if CHROME.exists() else None)
        errors = []
        try:
            for mode in ('map', 'independent'):
                context = browser.new_context(viewport={'width': 1440, 'height': 1000})
                context.add_init_script(f'({SAVE_PICKER})()')
                page = context.new_page()
                page.set_default_timeout(30_000)
                page.on('pageerror', lambda error: errors.append(str(error)))
                downloads = []
                page.on('download', lambda download: downloads.append(download))
                load_project(page, mode, directory / f'{mode}.zip')
                save_button = topbar_action(page, '保存工程', exact=True)
                expect(save_button).to_be_disabled()
                save_button.evaluate('(button) => button.click()')
                assert page.evaluate('window.__saveCalls.length') == 0
                page.screenshot(path=f'/tmp/atlas-save-disabled-{mode}.png', full_page=True)

                # Cancelled or failed first Save As must not enable overwriting.
                topbar_action(page, '另存为工程', exact=True).click()
                expect(save_button).to_be_disabled()
                page.evaluate('window.__saveChoice = { name: "failed.zip", writeError: true }')
                topbar_action(page, '另存为工程', exact=True).click()
                page.get_by_text('工程保存失败：destination is read-only', exact=True).wait_for()
                expect(save_button).to_be_disabled()

                first = f'{mode}-first.zip'
                second = f'{mode}-latest.zip'
                save_as(page, first)
                original_bytes, original_project = read_saved(page, first)
                set_color_mode(page, 'white')
                save(page, first)
                updated_bytes, updated = read_saved(page, first)
                assert updated_bytes != original_bytes
                assert updated['workspace']['pointColorMode'] == 'white'
                assert updated['virtualTeaching']['tasks'] == original_project['virtualTeaching']['tasks']
                save(page, first)

                # Neither cancellation nor a failed new destination replaces the target.
                for choice in ({'error': 'AbortError'}, {'name': second, 'writeError': True}):
                    page.evaluate('choice => window.__saveChoice = choice', choice)
                    topbar_action(page, '另存为工程', exact=True).click()
                    if choice.get('writeError'):
                        page.get_by_text('工程保存失败：destination is read-only', exact=True).wait_for()
                    expect(topbar_action(page, '保存工程', exact=True)).to_have_attribute('title', f'覆盖保存到 {first}')
                    save(page, first)

                save_as(page, second)
                old_file, _ = read_saved(page, first)
                set_color_mode(page, 'source')
                save(page, second)
                assert read_saved(page, first)[0] == old_file, 'Save As must stop writes to the old file'
                assert read_saved(page, second)[1]['workspace']['pointColorMode'] == 'source'
                topbar_action(page, '保存工程', exact=True)
                page.screenshot(path=f'/tmp/atlas-save-enabled-{mode}.png', full_page=True)

                # Permission loss and write failure preserve the last committed ZIP.
                committed = read_saved(page, second)[0]
                set_color_mode(page, 'height')
                page.evaluate('''() => {
                  window.__queryPermission = FileSystemHandle.prototype.queryPermission;
                  window.__requestPermission = FileSystemHandle.prototype.requestPermission;
                  FileSystemHandle.prototype.queryPermission = async () => 'prompt';
                  FileSystemHandle.prototype.requestPermission = async () => 'denied';
                }''')
                topbar_action(page, '保存工程', exact=True).click()
                page.get_by_text('工程保存失败：未获得工程文件的写入权限', exact=False).wait_for()
                assert read_saved(page, second)[0] == committed
                page.evaluate('''() => {
                  FileSystemHandle.prototype.queryPermission = window.__queryPermission;
                  FileSystemHandle.prototype.requestPermission = window.__requestPermission;
                  window.__createWritable = FileSystemFileHandle.prototype.createWritable;
                  FileSystemFileHandle.prototype.createWritable = async () => { throw new Error('write denied'); };
                }''')
                topbar_action(page, '保存工程', exact=True).click()
                page.get_by_text('工程保存失败：write denied', exact=True).wait_for()
                assert read_saved(page, second)[0] == committed
                page.evaluate('() => { FileSystemFileHandle.prototype.createWritable = window.__createWritable; }')
                save(page, second)
                assert read_saved(page, second)[1]['workspace']['pointColorMode'] == 'height'

                page.reload(wait_until='networkidle')
                wait_ready(page)
                expect(topbar_action(page, '保存工程', exact=True)).to_be_enabled()
                set_color_mode(page, 'white')
                save(page, second)
                assert page.evaluate('window.__saveCalls.length') == 0
                assert read_saved(page, second)[1]['workspace']['pointColorMode'] == 'white'

                # Both workspaces remember their own destinations across page reloads.
                other = 'independent' if mode == 'map' else 'map'
                other_file = f'{other}-separate.zip'
                load_project(page, other, directory / f'{other}.zip')
                expect(topbar_action(page, '保存工程', exact=True)).to_be_disabled()
                save_as(page, other_file)
                other_bytes = read_saved(page, other_file)[0]
                switch_mode(page, mode)
                save(page, second)
                assert read_saved(page, second)[1]['workspace']['teachingSpaceMode'] == mode
                assert read_saved(page, other_file)[0] == other_bytes
                switch_mode(page, other)
                save(page, other_file)
                assert read_saved(page, other_file)[1]['workspace']['teachingSpaceMode'] == other

                # A new config may reuse geometry, but must detach the old save file.
                config_path = directory / f'{other}-replacement.json'
                config_path.write_text(json.dumps(read_saved(page, other_file)[1]))
                page.locator('input[data-project-guide-input="true"]').set_input_files(str(config_path))
                page.get_by_text('工程配置已加载', exact=False).wait_for()
                expect(topbar_action(page, '保存工程', exact=True)).to_be_disabled()
                page.reload(wait_until='networkidle')
                wait_ready(page)
                expect(topbar_action(page, '保存工程', exact=True)).to_be_disabled()

                # A freshly created project has no target even in a previously saved mode.
                save_as(page, f'{other}-before-new.zip')
                topbar_action(page, '返回主页面', exact=True).click()
                wait_for_home(page)
                page.on('dialog', lambda dialog: dialog.accept())
                create_project(page, other)
                expect(topbar_action(page, '保存工程', exact=True)).to_be_disabled()
                assert not downloads, 'Native saves must never create additional browser downloads'
                context.close()
                print(f'{mode}_overwrite_latest_cancel_failure_permissions_reload_and_isolation=ok', flush=True)
            assert not errors, errors
        finally:
            browser.close()


if __name__ == '__main__':
    run()
