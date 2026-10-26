"""Save a backup from reset confirmation, only in disposable browser contexts."""
import base64
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from export_separation_ui_smoke import BASE_URL, CHROME, load_project, make_fixtures, wait_ready
from project_export_save_ui_smoke import SAVE_PICKER, assert_archive

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test-artifacts/global-reset-export'


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='atlas-reset-export-') as temporary, sync_playwright() as p:
        directory = Path(temporary)
        make_fixtures(directory)
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            empty = browser.new_page()
            empty.goto(BASE_URL, wait_until='networkidle'); wait_ready(empty)
            empty.get_by_role('button', name='全局重置', exact=True).click()
            warning = empty.get_by_role('alertdialog', name='确认全局重置？', exact=True)
            expect(warning.get_by_role('button', name='另存为工程', exact=True)).to_be_disabled()
            expect(warning.get_by_role('button', name='取消', exact=True)).to_be_focused()
            empty.close()

            for mode in ['map', 'independent']:
                context = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
                page = context.new_page()
                page.set_default_timeout(30000)
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                try:
                    load_project(page, mode, directory / f'{mode}.zip')
                    page.get_by_role('button', name='返回主页面', exact=True).click()
                    # Welcome-page restoration must also supply the complete export source.
                    page.reload(wait_until='networkidle'); wait_ready(page)
                    page.get_by_role('button', name='全局重置', exact=True).click()
                    warning = page.get_by_role('alertdialog', name='确认全局重置？', exact=True)
                    save = warning.get_by_role('button', name='另存为工程', exact=True)
                    cancel = warning.get_by_role('button', name='取消', exact=True)
                    reset = warning.get_by_role('button', name='确认全局重置', exact=True)
                    expect(cancel).to_be_focused(); expect(save).to_be_enabled()
                    for width in [1440, 390, 320]:
                        page.set_viewport_size({'width': width, 'height': 1000})
                        bounds = [button.bounding_box() for button in [save, cancel, reset]]
                        assert bounds[0]['x'] < bounds[1]['x'] < bounds[2]['x']
                        assert max(box['y'] for box in bounds) - min(box['y'] for box in bounds) < 2
                        assert max(box['height'] for box in bounds) < 45, 'footer labels stay on one line'
                        assert bounds[0]['x'] >= 0 and bounds[-1]['x'] + bounds[-1]['width'] <= width
                        page.screenshot(path=str(ARTIFACTS / f'{mode}-{width}.png'), full_page=True)
                    page.set_viewport_size({'width': 1440, 'height': 1000})

                    if mode == 'map':
                        page.evaluate(SAVE_PICKER)
                        save.click()  # Cancel the native picker without clearing any workspace.
                        expect(save).to_have_attribute('data-project-export-state', 'idle')
                        expect(reset).to_be_enabled(); expect(warning).to_be_visible()
                        call = page.evaluate('window.__saveCalls.at(-1)')
                        assert call['activated'] and call['options']['id'] == 'atlas-project-export-map'
                        name = '重置前备份.zip'
                        page.evaluate('name => window.__saveChoice = {name, defer: true}', name)
                        save.click()
                        page.wait_for_function('typeof window.__resolvePicker === "function"')
                        expect(save).to_be_disabled(); expect(cancel).to_be_disabled(); expect(reset).to_be_disabled()
                        page.keyboard.press('Escape'); expect(warning).to_be_visible()
                        page.evaluate('window.__resolvePicker()')
                        expect(save).to_have_attribute('data-project-export-state', 'ready')
                        expect(warning.get_by_role('status')).to_contain_text('工程已保存')
                        expect(reset).to_be_enabled()
                        encoded = page.evaluate('''async () => {
                            const file = await window.__writtenHandles.at(-1).getFile();
                            return btoa(Array.from(new Uint8Array(await file.arrayBuffer()), byte => String.fromCharCode(byte)).join(''));
                        }''')
                        saved = directory / name; saved.write_bytes(base64.b64decode(encoded))
                        assert_archive(saved, mode)
                        page.evaluate('name => window.__saveChoice = {name, writeError: true}', name)
                        save.click()
                        expect(warning.get_by_role('alert')).to_contain_text('工程保存失败')
                        expect(reset).to_be_enabled(); expect(save).to_be_enabled()

                    page.evaluate('window.showSaveFilePicker = undefined')
                    save.click()
                    export = page.get_by_role('dialog', name='保存工程副本', exact=True)
                    expect(export).to_be_visible()
                    page.keyboard.press('Escape')
                    expect(export).not_to_be_visible(); expect(warning).to_be_visible()
                    expect(save).to_be_focused(); expect(reset).to_be_enabled()
                    save.click()
                    export.get_by_label('工程名称', exact=True).fill(f'{mode}-重置前副本')
                    with page.expect_download() as download:
                        export.get_by_role('button', name='保存工程 ZIP', exact=True).click()
                    saved = directory / f'{mode}-backup.zip'; download.value.save_as(saved)
                    assert_archive(saved, mode)
                    expect(export).not_to_be_visible(); expect(warning).to_be_visible()
                    expect(warning.get_by_role('status')).to_contain_text('工程下载已开始')
                    expect(reset).to_be_enabled()
                    cancel.click()
                    page.get_by_role('region', name='当前工作现场', exact=True).get_by_role('button', name='继续工作', exact=True).click()
                    page.wait_for_url(BASE_URL + '/workbench'); wait_ready(page)
                    expect(page.locator('.three-canvas')).to_have_attribute('data-robot-model-state', 'loaded')
                    assert not errors, errors
                    print(mode, 'reset backup, native/fallback export, cancellation and retained workspace passed', flush=True)
                except Exception as error:
                    page.screenshot(path=str(ARTIFACTS / f'{mode}-failure.png'), full_page=True)
                    print('failure:', repr(error), 'page errors:', errors, flush=True)
                    raise
                finally:
                    context.close()
        finally:
            browser.close()


if __name__ == '__main__':
    run()
