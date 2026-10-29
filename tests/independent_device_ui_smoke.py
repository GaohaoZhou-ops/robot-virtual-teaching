"""Default independent browser operation, ZIP pose edits, service restart persistence.

BASE_URL=http://127.0.0.1:21992 VERIFY_STABLE_SERVICE=1 python tests/independent_device_ui_smoke.py
VERIFY_STABLE_SERVICE restarts ONLY an isolated test service (never port 21990).
Optional PROJECT_IMPORT_ZIP exercises a real saved collection too.
"""
import os
import json
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from project_load_modes_smoke import BASE_URL, CHROME, open_loader, choose_file, wait_ready
from teaching_transfer_ui_smoke import ready
from topbar_tools_helpers import topbar_action


def read_workspace(page):
    return page.evaluate("""async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('atlas-route-studio', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const records = await new Promise((resolve, reject) => {
          const request = db.transaction('workspace-session').objectStore('workspace-session').getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        return { meta: records.find(r => r.key === 'meta'),
          configs: records.filter(r => r.key.startsWith('workspace-config:') && r.config?.project).map(r => {
            const { exportedAt, view2d, view3d, ...project } = r.config.project;
            return { key:r.key, project };
          }),
          maps: records.filter(r => r.key.startsWith('workspace-map:')).map(r => ({key:r.key, id:r.mapId, points:r.pointCount})) };
      } finally { db.close(); }
    }""")


def run():
    errors, traffic, navigations, sockets = [], [], [], []
    with tempfile.TemporaryDirectory(prefix='atlas-independent-test-') as folder, sync_playwright() as p:
        archive = Path(folder) / 'independent.zip'
        subprocess.run(['node', '--input-type=module', '-e', """
          import { writeFile } from 'node:fs/promises';
          import { teachingTransferFixture } from './tests/teaching_transfer_helpers.mjs';
          import { buildProjectArchive } from './src/features/workspace/model/projectArchive.js';
          const fixture = teachingTransferFixture('independent');
          fixture.map.portableRobotPackage.files[0].bytes = new TextEncoder().encode(
            '<robot name="test"><link name="base_link"><visual><geometry><box size="0.5 0.3 0.3"/></geometry></visual></link>' +
            '<link name="arm"><visual><origin xyz="0 0 0.4"/><geometry><box size="0.1 0.1 0.8"/></geometry></visual></link>' +
            '<joint name="shoulder" type="revolute"><parent link="base_link"/><child link="arm"/><axis xyz="0 1 0"/>' +
            '<limit lower="-2" upper="2" effort="100" velocity="1"/></joint></robot>');
          const result = await buildProjectArchive(fixture.config.config.project, {
            mapResource: fixture.map, existingRobotPackage: fixture.map.portableRobotPackage });
          await writeFile(process.argv[1], result.bytes);
        """, str(archive)], check=True, capture_output=True)
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            page = browser.new_page(viewport={'width':1440, 'height':1000})
            page.set_default_timeout(60_000)
            page.add_init_script('window.showOpenFilePicker = undefined')
            # Simulate the server's remote-IP classification for this local test browser.
            page.route('**/__atlas/work-sync/capabilities', lambda route: route.fulfill(json={'local':False}))
            page.on('request', lambda request: traffic.append(request.url))
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('crash', lambda: errors.append('page crashed'))
            page.on('framenavigated', lambda frame: navigations.append(frame.url) if frame == page.main_frame else None)
            page.on('websocket', lambda socket: sockets.append(socket.url))
            page.goto(BASE_URL, wait_until='networkidle'); wait_ready(page)
            open_loader(page, 'independent'); choose_file(page, archive); ready(page, 'independent')
            topbar_action(page, name='打开全关节浮动窗口').click()
            joint = page.get_by_role('spinbutton', name='shoulder 关节值', exact=True)
            joint.wait_for()
            page.evaluate('window.__independentDocument = "original"')
            start_nav = len(navigations)
            initial_requests = len(traffic)
            for value in [15, 20, 25, 30, 35, 40]:
                joint.fill(str(value)); joint.press('Enter'); page.wait_for_timeout(1800)
                expect(joint).to_have_value(f"{value:.2f}")
                expect(page.locator('.loading-curtain')).to_have_count(0)
                ready(page, 'independent')
            assert page.evaluate('window.__independentDocument') == 'original'
            assert len(navigations) == start_nav, navigations
            assert not [url for url in traffic[initial_requests:] if '/__atlas/work-sync/' in url or '/__atlas/session' in url], traffic[initial_requests:]
            assert not [url for url in traffic if '/__atlas/physics/v1/' in url], 'default pose compute stays local'
            assert not [url for url in traffic if '/__atlas/work-sync/' in url and not url.endswith('/capabilities')], traffic
            assert not [url for url in sockets if '/work-sync/' in url]
            before = read_workspace(page)
            assert before['configs'][0]['project']['robot']['joints']['shoulder'] == 40
            print('independent_zip_pose_edits_no_sync_polling_no_refresh=ok', flush=True)
            if os.environ.get('VERIFY_STABLE_SERVICE') == '1':
                port = urlparse(BASE_URL).port
                assert port and port != 21990, 'Use an isolated service for restart testing'
                assert not [url for url in traffic if '/@vite/' in url]
                assert not sockets, sockets
                app = Path('src/app/App.jsx'); original = app.read_bytes()
                try:
                    app.write_bytes(original + b'\n// isolated service update probe\n')
                    probe = Path('build/service/assets/previous-version-probe.txt')
                    probe.write_text('keep assets used by already open pages')
                    page.wait_for_timeout(3500)
                    assert page.evaluate('window.__independentDocument') == 'original'
                    subprocess.run(['./scripts/restart.sh', str(port)], check=True, capture_output=True)
                    assert probe.exists(), 'service updates keep previous hashed assets available'
                    probe.unlink()
                finally:
                    app.write_bytes(original)
                page.wait_for_timeout(6500)
            else:
                # An unexpected server identity must not cause background refresh.
                page.route('**/__atlas/session', lambda route: route.fulfill(json={'sessionId':'replacement-service'}))
                page.wait_for_timeout(6500)
            assert len(navigations) == start_nav
            assert page.evaluate('window.__independentDocument') == 'original'
            expect(joint).to_have_value('40.00')
            assert read_workspace(page) == before
            page.reload(wait_until='networkidle'); ready(page, 'independent')
            if not page.get_by_role('spinbutton', name='shoulder 关节值', exact=True).is_visible():
                topbar_action(page, name='打开全关节浮动窗口').click()
            expect(page.get_by_role('spinbutton', name='shoulder 关节值', exact=True)).to_have_value('40.00')
            after = read_workspace(page)
            assert after['meta']['sessionId'] == before['meta']['sessionId']
            Path('/tmp/atlas-independent-before.json').write_text(json.dumps(before, ensure_ascii=False))
            Path('/tmp/atlas-independent-after.json').write_text(json.dumps(after, ensure_ascii=False))
            assert after['configs'] == before['configs']
            assert after['maps'] == before['maps']
            print('source_update_and_service_restart_keep_document_manual_reload_keeps_workspace=ok', flush=True)
            if os.environ.get('PROJECT_IMPORT_ZIP'):
                topbar_action(page, name='返回主页面').click()
                open_loader(page, 'independent'); choose_file(page, Path(os.environ['PROJECT_IMPORT_ZIP']))
                ready(page, 'independent')
                loaded = read_workspace(page)
                assert len(loaded['maps']) >= 2
                topbar_action(page, name='打开全关节浮动窗口').click()
                field = page.get_by_role('spinbutton', name='right_J1 关节值', exact=True)
                for value in [5, 10, 15, 20, 25, 30]:
                    field.fill(str(value)); field.press('Enter'); page.wait_for_timeout(1800)
                    ready(page, 'independent')
                    expect(page.locator('.loading-curtain')).to_have_count(0)
                assert read_workspace(page)['maps'] == loaded['maps']
                print('real_collection_independent_pose_adjustments=ok', flush=True)
            assert not errors, errors
            page.screenshot(path='/tmp/atlas-independent-device.png')
        finally:
            browser.close()


if __name__ == '__main__':
    run()
