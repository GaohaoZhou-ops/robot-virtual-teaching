"""Check real downloads in an isolated browser profile; do not open user data."""
import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile
import zipfile
from playwright.sync_api import expect, sync_playwright

BASE_URL = os.environ.get('BASE_URL', 'http://127.0.0.1:21990').rstrip('/')
CHROME = Path(os.environ.get('CHROME_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
SHOTS = Path(os.environ.get('OUTPUT_DIR', 'test-artifacts/abx-teaching-standards'))


def seed(page, variant='webp'):
    page.goto(BASE_URL, wait_until='networkidle')
    page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
    page.evaluate('''async variant => {
      const { teachingTransferFixture } = await import('/tests/teaching_transfer_helpers.mjs');
      const { abxTeachingStandardsFixture } = await import('/tests/abx_teaching_standards_helpers.mjs');
      const store = await import('/src/features/workspace/model/sessionStore.js');
      const { sessionId } = await store.fetchServiceSession();
      const fixture = teachingTransferFixture('map');
      const { payload, robotPackage } = abxTeachingStandardsFixture();
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 16;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#1e8cc8'; ctx.fillRect(0, 0, 32, 16);
      const webp = canvas.toDataURL('image/webp', .9);
      if (!webp.startsWith('data:image/webp')) throw new Error('WebP fixture unavailable');
      for (const task of payload.virtualTeaching.tasks) for (const parking of task.parkingPoints) for (const pose of parking.poses) {
        if (variant === 'empty') pose.cameraCapture = null;
        for (const frame of Object.values(pose.cameraCapture?.frames || {})) {
          frame.rgb = { encoding: 'data-url', mimeType: 'image/webp', width: 32, height: 16,
            dataUrl: variant === 'invalid' ? 'data:image/png;base64,YmFk' : webp };
        }
      }
      fixture.map.name = payload.map.fileName; fixture.map.sourceHash = payload.map.sourceHash;
      fixture.map.portableRobotPackage = robotPackage;
      fixture.config.config.project = payload; fixture.config.config.ui.selectedRobot = payload.robot;
      await store.saveWorkspaceMap(sessionId, fixture.map.mapId, fixture.map.name, fixture.map, 'map');
      await store.saveWorkspaceConfig(sessionId, fixture.map.mapId, fixture.config.config, 'map');
      await store.activateWorkspaceMode(sessionId, 'map');
    }''', variant)
    page.goto(BASE_URL + '/teaching-data', wait_until='networkidle')
    page.locator('.loading-curtain').wait_for(state='hidden')
    page.get_by_role('button', name='选择示教任务 装配任务：中文校验', exact=True).click()


def snapshot(page):
    return page.evaluate('''async () => {
      const store = await import('/src/features/workspace/model/sessionStore.js');
      const { sessionId } = await store.fetchServiceSession();
      return (await store.loadWorkspaceConfig(sessionId, 'map')).config.project.virtualTeaching;
    }''')


def download(page, dialog, folder, images, clouds):
    button = dialog.get_by_role('button', name='下载机器人导入包', exact=True)
    expect(button).to_be_enabled()
    with page.expect_download() as pending:
        button.click()
    path = Path(folder) / f'standards-{images}-{clouds}.zip'
    pending.value.save_as(path)
    with zipfile.ZipFile(path) as bundle:
        manifest = json.loads(bundle.read('manifest.json'))
        assert len(manifest.get('standards', [])) == images
        assert len(manifest.get('clouds', [])) == clouds
        assert all(entry.compress_type == zipfile.ZIP_STORED for entry in bundle.infolist())
        for entry in manifest.get('standards', []) + manifest.get('clouds', []):
            data = bundle.read(entry['path'])
            assert len(data) == entry['bytes'] and hashlib.sha256(data).hexdigest() == entry['sha256']
            if entry.get('kind') == 'xyzbin':
                assert data[:8] == b'ABXXYZ1\0' and struct.unpack('<II', data[8:16]) == (3, 1)
            else:
                assert data[:8] == b'\x89PNG\r\n\x1a\n' and struct.unpack('>II', data[16:24]) == (32, 16)
        for task in manifest['tasks']:
            lines = bundle.read(task['file']).splitlines(keepends=True)
            assert json.loads(lines[-1])['sha256'] == hashlib.sha256(b''.join(lines[1:-1])).hexdigest()


def run():
    SHOTS.mkdir(parents=True, exist_ok=True)
    errors = []
    with tempfile.TemporaryDirectory(prefix='atlas-standards-ui-') as folder, sync_playwright() as playwright:
        options = dict(headless=True)
        if CHROME.exists(): options['executable_path'] = str(CHROME)
        browser = playwright.chromium.launch(**options)
        try:
            for variant in ('webp', 'invalid', 'empty'):
                context = browser.new_context(viewport=dict(width=1440, height=1100), accept_downloads=True)
                page = context.new_page(); page.set_default_timeout(30000)
                page.on('pageerror', lambda error: errors.append(str(error)))
                seed(page, variant)
                before = snapshot(page)
                export = page.get_by_role('button', name='导出示教数据', exact=True)
                export.click()
                dialog = page.get_by_role('dialog', name='导出机器人示教', exact=True)
                images = dialog.get_by_label('导出标准图', exact=False)
                clouds = dialog.get_by_label('导出标准点云', exact=False)
                button = dialog.get_by_role('button', name='下载机器人导入包', exact=True)
                expect(button).to_be_enabled(); expect(images).not_to_be_checked(); expect(clouds).not_to_be_checked()
                if variant == 'webp':
                    download(page, dialog, folder, 0, 0)
                    images.check(); download(page, dialog, folder, 3, 0)
                    expect(dialog.get_by_label('标准资源导出提示')).to_contain_text('3 路相机未保存标准图')
                    clouds.check(); download(page, dialog, folder, 3, 2)
                    expect(dialog).to_contain_text('关联 2 个 Pose')
                    page.screenshot(path=str(SHOTS / 'desktop.png'), full_page=True)
                    for _ in range(10):
                        page.keyboard.press('Tab')
                        assert dialog.evaluate('(el) => el.contains(document.activeElement)')
                    page.set_viewport_size(dict(width=390, height=780))
                    expect(button).to_be_in_viewport()
                    assert dialog.evaluate('(el) => el.scrollWidth <= el.clientWidth')
                    assert dialog.evaluate('(el) => el.getBoundingClientRect().right <= innerWidth && el.getBoundingClientRect().left >= 0')
                    assert button.evaluate('(el) => el.getBoundingClientRect().right <= innerWidth')
                    dialog.locator('.abx-export-body').evaluate('(el) => {el.scrollTop = 0}')
                    page.screenshot(path=str(SHOTS / 'compact.png'))
                    images.uncheck(); download(page, dialog, folder, 0, 2)
                    clouds.uncheck(); download(page, dialog, folder, 0, 0)
                    # Rapid toggles must never expose a ZIP from an earlier selection.
                    images.check(); images.uncheck(); clouds.check()
                    download(page, dialog, folder, 0, 2)
                elif variant == 'invalid':
                    images.check()
                    expect(dialog.get_by_role('alert')).to_contain_text('PNG')
                    expect(button).to_be_disabled()
                    images.uncheck(); clouds.check()
                    download(page, dialog, folder, 0, 2)
                else:
                    expect(images).to_be_disabled(); expect(clouds).to_be_disabled()
                    expect(dialog).to_contain_text('当前任务尚无相机采集数据')
                    download(page, dialog, folder, 0, 0)
                page.keyboard.press('Escape')
                expect(dialog).to_have_count(0); expect(export).to_be_focused()
                assert snapshot(page) == before, 'export must not modify saved teaching data'
                context.close()
                print(f'standard_export_{variant}=passed', flush=True)
            assert not errors, errors
        finally:
            browser.close()


if __name__ == '__main__':
    run()
