"""Return to the model editor welcome page when the worker has no model."""
from playwright.sync_api import expect, sync_playwright

from model_editor_origin_gizmo_ui_smoke import fixture
from model_editor_ui_smoke import BASE_URL, CHROME


WORKER_RESTART = """() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
        constructor(url, options) {
            super(url, options);
            if (String(url).includes('modelEditor.worker')) window.__modelWorker = { worker: this, url, options };
        }
    };
    window.__loseModel = () => {
        const { worker, url, options } = window.__modelWorker;
        // Use the real worker code with empty memory, preserving the page's connection.
        const emptyWorker = new NativeWorker(url, options);
        worker.terminate();
        worker.postMessage = emptyWorker.postMessage.bind(emptyWorker);
        worker.terminate = emptyWorker.terminate.bind(emptyWorker);
        emptyWorker.onmessage = event => worker.onmessage(event);
        emptyWorker.onerror = event => worker.onerror(event);
    };
}
"""


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, **({'executable_path': str(CHROME)} if CHROME.exists() else {}))
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 900})
            page.set_default_timeout(30000)
            page.add_init_script(f'({WORKER_RESTART})()')
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(f'{BASE_URL}/model-editor', wait_until='networkidle')
            editor = page.locator('[data-app-page="model-editor"]')
            picker = page.get_by_label('导入模型文件', exact=True)
            export = page.get_by_role('button', name='导出 PLY', exact=True)

            def welcome():
                expect(page).to_have_url(f'{BASE_URL}/model-editor')
                expect(editor).to_have_attribute('data-editor-state', 'empty')
                expect(page.get_by_role('heading', name='模型编辑空间', exact=True)).to_be_visible()
                expect(page.get_by_role('button', name='选择 PLY 模型', exact=True)).to_be_enabled()
                expect(page.get_by_role('button', name='模型详情', exact=True)).to_be_disabled()
                expect(export).to_be_disabled()
                expect(page.get_by_label('模型编辑三维预览', exact=True)).to_have_count(0)
                expect(page.locator('.model-editor__message')).to_have_count(0)
                expect(page.get_by_role('dialog')).to_have_count(0)

            def load():
                picker.set_input_files({'name': 'recovery-box.ply', 'buffer': fixture(), 'mimeType': 'application/octet-stream'})
                expect(editor).to_have_attribute('data-editor-state', 'ready')
                page.wait_for_timeout(400)
                expect(editor).to_have_attribute('data-editor-state', 'ready')
                expect(export).to_be_enabled()

            welcome()
            for operation in ['edit', 'preview', 'export']:
                load()
                page.get_by_label('原点 X', exact=True).fill('0.25')
                expect(editor).to_have_attribute('data-editor-state', 'ready')
                page.evaluate('window.__loseModel()')
                if operation == 'edit':
                    page.get_by_label('原点 X', exact=True).fill('0.5')
                    # Recovery also closes any model details opened during processing.
                    page.get_by_role('button', name='模型详情', exact=True).click()
                elif operation == 'preview':
                    page.get_by_role('button', name='原始模型', exact=True).click()
                    page.get_by_label('显示质量', exact=True).select_option('performance')
                else:
                    page.evaluate('''() => {
                        window.__writeAttempts = 0;
                        window.showSaveFilePicker = async () => ({
                            name: 'missing-model.ply',
                            createWritable: async () => { window.__writeAttempts++; throw new Error('No model to write'); },
                        });
                    }''')
                    export.click()
                welcome()
                page.wait_for_timeout(400)
                welcome()  # Late responses must not restore the old editor or its toast.
                page.keyboard.press('Control+z')
                welcome()
                if operation == 'export':
                    assert page.evaluate('window.__writeAttempts') == 0

            load()
            expect(page.get_by_label('原点 X', exact=True)).to_have_value('0')
            page.get_by_label('模型编辑三维预览', exact=True).focus()
            page.keyboard.press('Control+z')
            expect(page.get_by_label('原点 X', exact=True)).to_have_value('0')
            page.get_by_label('原点 X', exact=True).fill('0.75')
            expect(editor).to_have_attribute('data-editor-state', 'ready')
            expect(export).to_be_enabled()
            page.reload(wait_until='networkidle'); welcome()
            assert not errors, errors
            print('missing model UI: initial welcome, edit/preview/export recovery, no toast, cleared dialogs/history, reimport and refresh passed')
        finally:
            browser.close()


if __name__ == '__main__':
    run()
