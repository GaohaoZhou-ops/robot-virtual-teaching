from topbar_tools_helpers import topbar_action

import base64
import json
import tempfile
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright

from export_separation_ui_smoke import CHROME, load_project, make_fixtures


SAVE_PICKER = """() => {
window.__saveCalls = [];
window.__saveChoice = { error: 'AbortError' };
window.__writtenHandles = [];
window.showSaveFilePicker = async options => {
  window.__saveCalls.push({ options, activated: navigator.userActivation.isActive });
  const choice = window.__saveChoice;
  if (choice.error) throw new DOMException('test picker', choice.error);
  if (choice.defer) await new Promise(resolve => { window.__resolvePicker = resolve; });
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle('chosen-export-folder', { create: true });
  const handle = await directory.getFileHandle(choice.name, { create: true });
  window.__writtenHandles.push(handle);
  if (!choice.writeError) return handle;
  return {
    name: handle.name,
    createWritable: async () => {
      if (choice.writeError) throw new DOMException('destination is read-only', 'NotAllowedError');
      return handle.createWritable();
    },
  };
};
}
"""


def assert_archive(path, mode):
    with zipfile.ZipFile(path) as archive:
        project = json.loads(archive.read('config/project.json'))
        assert project['workspace']['teachingSpaceMode'] == mode
        assert project['virtualTeaching']['tasks'][0]['id'] == f'{mode}-task'
        assert 'environment/positions.f32le' in archive.namelist()
        assert 'robot/files/transfer/robot.urdf' in archive.namelist()


def run():
    with tempfile.TemporaryDirectory(prefix='atlas-save-picker-') as temporary, sync_playwright() as p:
        directory = Path(temporary)
        make_fixtures(directory)
        options = {'headless': True}
        if CHROME.exists():
            options['executable_path'] = str(CHROME)
        browser = p.chromium.launch(**options)
        errors = []
        try:
            for mode in ('map', 'independent'):
                context = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
                page = context.new_page()
                page.set_default_timeout(60_000)
                page.on('pageerror', lambda error: errors.append(str(error)))
                downloads = []
                page.on('download', lambda download: downloads.append(download))
                load_project(page, mode, directory / f'{mode}.zip')
                # Inspect the actual export control before testing its save flow.
                export = topbar_action(page, name='另存为工程', exact=True)
                assert export.is_visible() and export.is_enabled()
                page.evaluate(SAVE_PICKER)
                page.evaluate("""() => {
                  window.__exportStates = [];
                  const button = document.querySelector('button[aria-label="另存为工程"]');
                  new MutationObserver(() => window.__exportStates.push(button.dataset.projectExportState))
                    .observe(button, { attributes: true, attributeFilter: ['data-project-export-state'] });
                }""")

                export.click()
                page.wait_for_function("document.querySelector('button[aria-label=\"另存为工程\"]').dataset.projectExportState === 'idle'")
                assert 'packing' not in page.evaluate('window.__exportStates')
                assert not downloads
                call = page.evaluate('window.__saveCalls.at(-1)')
                assert call['activated'], 'native picker must run directly within user activation'
                assert call['options']['id'] == f'atlas-project-export-{mode}'
                assert call['options']['suggestedName'].startswith(f'atlas-project-{mode}-')
                assert call['options']['types'][0]['accept'] == {'application/zip': ['.zip']}
                assert call['options']['excludeAcceptAllOption'] is True

                # The picker supplies a real FileSystemFileHandle in the chosen test folder.
                name = f'{mode}-装配工位 新名称.zip'
                page.evaluate('choice => window.__saveChoice = choice', {'name': name, 'defer': True})
                topbar_action(page, name='另存为工程', exact=True).click()
                page.wait_for_function('typeof window.__resolvePicker === "function"')
                assert export.is_disabled()
                assert export.get_attribute('data-project-export-state') == 'selecting'
                assert 'packing' not in page.evaluate('window.__exportStates')
                export.evaluate('(button) => button.click()')
                assert page.evaluate('window.__saveCalls.length') == 2
                page.evaluate('window.__resolvePicker()')
                page.get_by_text(f'工程已保存 · {name}', exact=False).wait_for()
                assert export.get_attribute('data-project-export-state') == 'ready'
                assert not downloads, 'native save must write the chosen handle, not create a download'
                encoded = page.evaluate("""async () => {
                  const file = await window.__writtenHandles.at(-1).getFile();
                  const bytes = new Uint8Array(await file.arrayBuffer());
                  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
                }""")
                saved_path = directory / name
                saved_path.write_bytes(base64.b64decode(encoded))
                assert_archive(saved_path, mode)

                # The teaching-data page shares the same native save path and reports write failures.
                topbar_action(page, name='打开示教数据管理页').click()
                export = topbar_action(page, name='导出工程', exact=True)
                page.evaluate('choice => window.__saveChoice = choice', {'name': name, 'writeError': True})
                export.click()
                page.get_by_text('工程保存失败：destination is read-only', exact=True).wait_for()
                assert export.get_attribute('data-project-export-state') == 'error'
                assert export.is_enabled() and not downloads
                page.evaluate('choice => window.__saveChoice = choice', {'name': name})
                export.click()
                page.get_by_text(f'工程已保存 · {name}', exact=False).wait_for()
                assert export.get_attribute('data-project-export-state') == 'ready'

                # Restricted APIs use the named-download dialog; Escape cancels without packing.
                for error in ('SecurityError', 'NotSupportedError'):
                    page.evaluate('error => window.__saveChoice = { error }', error)
                    export.click()
                    modal = page.get_by_role('dialog', name='保存工程副本')
                    modal.wait_for()
                    page.keyboard.press('Escape')
                    modal.wait_for(state='detached')
                    assert export.evaluate('(element) => element === document.activeElement')
                    assert not downloads

                page.evaluate('window.showSaveFilePicker = undefined')
                export.click()
                modal = page.get_by_role('dialog', name='保存工程副本')
                name_input = modal.get_by_label('工程名称', exact=True)
                assert name_input.evaluate('(element) => element === document.activeElement')
                name_input.fill(' ')
                assert modal.get_by_role('button', name='保存工程 ZIP').is_disabled()
                name_input.fill('../invalid')
                modal.get_by_role('button', name='保存工程 ZIP').click()
                modal.get_by_role('alert').wait_for()
                assert not downloads
                name_input.fill(f'{mode}-重命名副本.ZIP')
                page.screenshot(path=f'/tmp/atlas-save-dialog-{mode}.png', full_page=True)
                if mode == 'independent':
                    page.set_viewport_size({'width': 390, 'height': 844})
                    bounds = modal.bounding_box()
                    assert bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= 390
                    page.screenshot(path='/tmp/atlas-save-dialog-mobile.png')
                with page.expect_download() as download:
                    modal.get_by_role('button', name='保存工程 ZIP').click()
                assert download.value.suggested_filename == f'{mode}-重命名副本.zip'
                fallback_path = directory / f'{mode}-fallback.zip'
                download.value.save_as(fallback_path)
                assert_archive(fallback_path, mode)
                modal.wait_for(state='detached')
                assert page.locator('button[aria-label="保存工程"]').is_disabled()

                fresh = browser.new_context()
                restored = fresh.new_page()
                restored.set_default_timeout(60_000)
                restored.on('pageerror', lambda error: errors.append(str(error)))
                load_project(restored, mode, saved_path)
                assert topbar_action(restored, name='保存工程', exact=True).is_disabled()
                assert restored.locator('.map-identity strong').inner_text() == f'{mode}-transfer.ply'
                fresh.close()
                context.close()
                print(f'{mode}_native_save_rename_cancel_failure_fallback_and_restore=ok')
            assert not errors, errors
        finally:
            browser.close()


if __name__ == '__main__':
    run()
