"""Native picker contract, real file writes, cancellation, failures and fallback."""
import base64
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from model_editor_origin_gizmo_ui_smoke import FIELDS, POINTS, distance, fixture, transformed
from model_editor_ui_smoke import BASE_URL, CHROME, read_export


SAVE_PICKER = """() => {
  window.__saveCalls = [];
  window.__saveChoice = { error: 'AbortError' };
  window.__exportRequests = 0;
  window.__abortedWrites = 0;
  const postMessage = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function(message, ...args) {
    if (message.type === 'export') window.__exportRequests += 1;
    return postMessage.call(this, message, ...args);
  };
  window.showSaveFilePicker = async options => {
    window.__saveCalls.push({ options, activated: navigator.userActivation.isActive });
    const choice = { ...window.__saveChoice };
    if (choice.error) throw new DOMException('无法选择目标文件', choice.error);
    if (choice.defer) await new Promise(resolve => { window.__resolvePicker = resolve; });
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(choice.folder, { create: true });
    const handle = await directory.getFileHandle(choice.name, { create: true });
    window.__chosenHandle = handle;
    return {
      name: handle.name,
      createWritable: async () => {
        if (choice.writeError === 'open') throw new DOMException('目标文件不可写入', 'NotAllowedError');
        const writer = await handle.createWritable();
        return {
          write: async buffer => {
            if (choice.deferWrite) await new Promise(resolve => { window.__resolveWrite = resolve; });
            await writer.write(buffer);
            if (choice.writeError === 'write') throw new DOMException('磁盘空间不足', 'QuotaExceededError');
          },
          close: async () => {
            if (choice.writeError === 'close') throw new DOMException('无法完成文件保存', 'AbortError');
            await writer.close();
          },
          abort: async () => { window.__abortedWrites += 1; await writer.abort(); },
        };
      },
    };
  };
}
"""


def run():
    with tempfile.TemporaryDirectory(prefix='model-editor-save-') as directory, sync_playwright() as p:
        browser = p.chromium.launch(headless=True, **({'executable_path': str(CHROME)} if CHROME.exists() else {}))
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 900}, accept_downloads=True)
            page.set_default_timeout(30_000)
            errors, downloads = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('download', lambda download: downloads.append(download))
            page.goto(f'{BASE_URL}/model-editor', wait_until='networkidle')
            page.get_by_label('导入模型文件', exact=True).set_input_files({'name': 'save-box.ply', 'mimeType': 'application/octet-stream', 'buffer': fixture()})
            editor = page.locator('[data-app-page="model-editor"]')
            canvas = page.get_by_label('模型编辑三维预览', exact=True)
            export = page.get_by_role('button', name='导出 PLY', exact=True)
            notice = page.locator('.model-editor__message[role="status"]')

            def ready():
                expect(editor).to_have_attribute('data-editor-state', 'ready')
                expect(export).to_be_enabled()

            def origin():
                return [float(page.get_by_label(f'原点 {field}', exact=True).input_value()) for field in FIELDS]

            def chosen_bytes():
                encoded = page.evaluate('''async () => {
                    const file = await window.__chosenHandle.getFile();
                    return btoa(Array.from(new Uint8Array(await file.arrayBuffer()), byte => String.fromCharCode(byte)).join(''));
                }''')
                return base64.b64decode(encoded)

            def assert_ply(data):
                path = Path(directory) / 'verified.ply'
                path.write_bytes(data)
                points, faces = read_export(path)
                assert len(points) == 8 and faces == 12
                for actual, source in zip(points, POINTS):
                    assert distance(actual, transformed(source, origin())) < 1e-5

            ready()
            page.get_by_label('原点 X', exact=True).fill('0.25')
            page.get_by_label('原点 yaw', exact=True).fill('30')
            ready()
            page.get_by_role('button', name='原始模型', exact=True).click()
            page.get_by_role('button', name='旋转模型', exact=True).click()
            before = origin()
            page.evaluate(SAVE_PICKER)

            # Cancel before encoding. Picker invocation retains the click's activation.
            export.click(); ready()
            call = page.evaluate('window.__saveCalls[0]')
            assert call['activated']
            assert call['options']['id'] == 'model-editor-ply-export'
            assert call['options']['suggestedName'] == 'save-box-edited.ply'
            assert call['options']['types'][0]['accept'] == {'application/octet-stream': ['.ply']}
            assert call['options']['excludeAcceptAllOption'] is True
            assert page.evaluate('window.__exportRequests') == 0
            assert not downloads and origin() == before
            expect(page.get_by_role('alert')).to_have_count(0)
            expect(canvas).to_have_attribute('data-origin-edit-mode', 'rotate')

            # The chooser returns a real file in a chosen directory; write only on confirmation.
            choice = {'folder': 'chosen-model-folder', 'name': '模型校准 新版本.ply', 'defer': True, 'deferWrite': True}
            page.evaluate('choice => window.__saveChoice = choice', choice)
            export.click()
            page.wait_for_function('typeof window.__resolvePicker === "function"')
            expect(editor).to_have_attribute('data-editor-state', 'selecting')
            expect(export).to_be_disabled()
            expect(page.get_by_role('button', name='更换模型', exact=True)).to_be_disabled()
            expect(page.get_by_label('原点 X', exact=True)).to_be_disabled()
            export.evaluate('(button) => button.click()')
            assert page.evaluate('window.__saveCalls.length') == 2
            assert page.evaluate('window.__exportRequests') == 0
            page.evaluate('window.__resolvePicker()')
            page.wait_for_function('typeof window.__resolveWrite === "function"')
            expect(editor).to_have_attribute('data-editor-state', 'exporting')
            expect(page.get_by_text(f'已保存 {choice["name"]}', exact=False)).to_have_count(0)
            page.evaluate('window.__resolveWrite()')
            expect(notice).to_contain_text(f'已保存 {choice["name"]}')
            ready()
            saved = chosen_bytes()
            assert_ply(saved)
            assert not downloads and origin() == before
            expect(canvas).to_have_attribute('data-original-visible', 'true')

            # Open/write/close failures preserve the existing destination and allow retry.
            choice = {key: value for key, value in choice.items() if key not in ['defer', 'deferWrite']}
            page.get_by_label('原点 X', exact=True).fill('0.5'); ready()
            for failure, message in [('open', '目标文件不可写入'), ('write', '磁盘空间不足'), ('close', '无法完成文件保存')]:
                page.evaluate('choice => window.__saveChoice = choice', {**choice, 'writeError': failure})
                export.click()
                expect(page.get_by_role('alert')).to_contain_text(f'模型导出失败：{message}')
                ready()
                assert chosen_bytes() == saved
                assert not downloads
            assert page.evaluate('window.__abortedWrites') == 2
            page.evaluate('choice => window.__saveChoice = choice', choice)
            export.click()
            expect(notice).to_contain_text(f'已保存 {choice["name"]}')
            ready(); assert_ply(chosen_bytes())
            assert chosen_bytes() != saved

            # Every export asks again, including selecting a different directory and filename.
            page.evaluate('choice => window.__saveChoice = choice', {'folder': 'another-model-folder', 'name': '另一目录.ply'})
            export.click()
            expect(notice).to_contain_text('已保存 另一目录.ply')
            ready(); assert_ply(chosen_bytes())
            assert not downloads

            requests_before = page.evaluate('window.__exportRequests')
            dialog = page.get_by_role('dialog', name='保存模型副本', exact=True)
            for error in ['SecurityError', 'NotSupportedError']:
                page.evaluate('error => window.__saveChoice = { error }', error)
                export.click()
                expect(dialog).to_be_visible()
                page.keyboard.press('Escape')
                expect(dialog).to_have_count(0)
                expect(export).to_be_focused()
                expect(canvas).to_have_attribute('data-origin-edit-mode', 'rotate')
            assert page.evaluate('window.__exportRequests') == requests_before

            # Compatibility path supports a custom name and explains the browser's save location.
            page.evaluate('window.showSaveFilePicker = undefined')
            export.click()
            name = dialog.get_by_label('文件名', exact=True)
            expect(name).to_be_focused()
            expect(dialog).to_contain_text('下载前询问保存位置')
            name.fill(' ')
            expect(dialog.get_by_role('button', name='下载 PLY', exact=True)).to_be_disabled()
            name.fill('../wrong.ply')
            dialog.get_by_role('button', name='下载 PLY', exact=True).click()
            expect(dialog.get_by_role('alert')).to_be_visible()
            assert page.evaluate('window.__exportRequests') == requests_before
            name.fill('自定义模型.PLY')
            page.set_viewport_size({'width': 390, 'height': 844})
            expect(dialog).to_be_in_viewport()
            assert dialog.evaluate('(element) => element.scrollWidth <= element.clientWidth')
            page.screenshot(path='/tmp/model-editor-export-fallback.png')
            with page.expect_download() as event:
                dialog.get_by_role('button', name='下载 PLY', exact=True).click()
            assert event.value.suggested_filename == '自定义模型.ply'
            download_path = Path(directory) / 'fallback.ply'
            event.value.save_as(download_path)
            ready(); assert_ply(download_path.read_bytes())
            assert len(downloads) == 1
            expect(dialog).to_have_count(0)
            assert not errors, errors
            print('model export: native picker activation, chosen filename/directory, cancel, full PLY writes, write failure rollback/retry, and named-download fallback passed')
        finally:
            browser.close()


if __name__ == '__main__':
    run()
