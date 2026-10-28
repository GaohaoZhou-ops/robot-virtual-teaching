"""Offline collaboration preserves separate map/object colors and geometry groups."""
import json
import io
import zipfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from teaching_transfer_ui_smoke import BASE_URL, CHROME, ready
from work_sync_ui_smoke import approve, control, offline, close_sync
from placed_object_rendering_ui_smoke import SEED, colors, select_color
from viewer_tools_helpers import display_settings_section
from archive_helpers import start_project_download, read_exported_archive

ARTIFACTS = Path(__file__).resolve().parents[1] / 'test-artifacts' / 'work-sync-display'
ARTIFACTS.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
    host = browser.new_context(viewport={'width': 1440, 'height': 1000}).new_page()
    peer = browser.new_context(viewport={'width': 1440, 'height': 1000}).new_page()
    errors = []
    uploaded_bundles = []
    host.on('request', lambda request: uploaded_bundles.append(request.post_data_buffer)
            if request.method == 'PUT' and request.url.endswith('/bundle') else None)
    for page in [host, peer]:
        page.set_default_timeout(30000)
        page.on('pageerror', lambda error: errors.append(str(error)))
    peer.route('**/__atlas/work-sync/capabilities', lambda route: route.fulfill(json={'local': False}))
    try:
        host.goto(BASE_URL, wait_until='networkidle')
        host.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
        counts = host.evaluate(SEED, {'points': False, 'legacy': False})
        host.goto(BASE_URL + '/workbench', wait_until='networkidle')
        ready(host, 'map')
        select_color(host, '地图', 'height')
        select_color(host, '独立对象', 'source')
        display_settings_section(host, '地图与对象').get_by_role('button', name='隐藏高程色卡', exact=True).click()
        host.keyboard.press('Escape')
        host.keyboard.press('Escape')
        expect(control(host)).to_have_attribute('data-sync-role', 'host', timeout=70000)
        project_key = host.evaluate('''async () => {
          const store = await import('/src/lib/sessionStore.js');
          const {sessionId} = await store.fetchServiceSession();
          const {map, config} = await store.loadWorkspaceSnapshot(sessionId, 'map');
          return JSON.stringify(['map', map.mapId, map.sourceHash, config.config.project.robot.relativePath]);
        }''')
        baseline = colors(host)
        assert max(abs(a-b) for a,b in zip(*baseline)) > 8, baseline
        peer.goto(BASE_URL, wait_until='networkidle')
        peer.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
        approve(host, peer)
        with zipfile.ZipFile(io.BytesIO(uploaded_bundles[0])) as archive:
            envelope = json.loads(archive.read('manifest.json'))
            assert envelope['format'] == 'atlas-route-studio-resource-project'
            assert any(part['kind'] == 'positions' for part in
                       envelope['references']['environment/positions.f32le']['parts'])
            assert 'independentHistory' not in envelope['projectManifest']
        ready(peer, 'map')
        expect(control(peer)).to_have_attribute('data-sync-complete', 'true', timeout=30000)
        canvas = peer.locator('.three-canvas')
        expect(canvas).to_have_attribute('data-placed-object-point-count', str(counts['count']))
        expect(canvas).to_have_attribute('data-color-mode', 'height')
        expect(canvas).to_have_attribute('data-placed-object-color-mode', 'source')
        expect(peer.locator('.height-color-legend')).to_have_count(0)
        actual = colors(peer)
        assert all(max(abs(a-b) for a,b in zip(left, right)) <= 3 for left, right in zip(baseline, actual)), (baseline, actual)
        host.screenshot(path=str(ARTIFACTS / 'host-colors.png'))
        peer.screenshot(path=str(ARTIFACTS / 'peer-colors.png'))
        # Independent fields merge without resetting another device's changes.
        select_color(host, '独立对象', 'white')
        select_color(peer, '地图', 'source')
        for page in [host, peer]:
            expect(page.locator('.three-canvas')).to_have_attribute('data-color-mode', 'source', timeout=12000)
            expect(page.locator('.three-canvas')).to_have_attribute('data-placed-object-color-mode', 'white', timeout=12000)
        select_color(peer, '独立对象', 'source')
        select_color(host, '地图', 'height')
        for page in [host, peer]:
            page.keyboard.press('Escape')
            expect(page.locator('.three-canvas')).to_have_attribute('data-color-mode', 'height', timeout=12000)
            expect(page.locator('.three-canvas')).to_have_attribute('data-placed-object-color-mode', 'source', timeout=12000)
        display_settings_section(peer, '地图与对象').get_by_role('button', name='显示高程色卡', exact=True).click()
        peer.keyboard.press('Escape')
        peer.keyboard.press('Escape')
        for page in [host, peer]:
            expect(page.locator('.height-color-legend')).to_have_count(1, timeout=12000)
        offline(peer).get_by_role('button', name='断开链接', exact=True).click()
        close_sync(peer)
        peer.reload(wait_until='networkidle')
        ready(peer, 'map')
        expect(canvas).to_have_attribute('data-placed-object-point-count', str(counts['count']))
        expect(canvas).to_have_attribute('data-placed-object-color-mode', 'source')
        expect(peer.locator('.height-color-legend')).to_have_count(1)
        assert colors(peer) == actual, 'Saved workspace keeps both color modes and the object mask after reload'
        # The recipient can save a standalone project without the host's source workspace.
        with peer.expect_download() as pending:
            start_project_download(peer, '同步后的分层颜色')
        archive = read_exported_archive(pending.value)
        assert archive['project']['workspace'].get('transfer') is None
        assert archive['project']['workspace']['pointColorMode'] == 'height'
        assert archive['project']['workspace']['placedObjectColorMode'] == 'source'
        assert archive['project']['workspace']['showHeightLegend3D'] is True
        metadata = json.loads(archive['files']['environment/map.json'])
        assert sum(item['count'] for item in metadata['geometry']['layers']['objectRanges']) == counts['count']
        # Reproduce a pre-fix recipient: correct preferences, lost object groups,
        # old checkpoint, and an unsynchronized local navigation edit.
        peer.goto(BASE_URL, wait_until='networkidle')
        peer.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
        peer.evaluate('''async key => {
          const store = await import('/src/lib/sessionStore.js');
          const {sessionId} = await store.fetchServiceSession();
          const {map, config} = await store.loadWorkspaceSnapshot(sessionId, 'map');
          delete map.geometryLayers;
          config.config.project.waypoints.push({id: 'peer-offline', name: '未同步的导航点', x: 0, y: 8, z: 0});
          await store.saveWorkspaceMap(sessionId, map.mapId, map.name, map, 'map');
          await store.saveWorkspaceConfig(sessionId, map.mapId, config.config, 'map');
          const checkpoint = await store.loadWorkSyncCheckpoint(key);
          if (!checkpoint) throw new Error('Missing collaboration checkpoint');
          delete checkpoint.resourceVersion;
          delete checkpoint.document.displaySettings;
          await store.saveWorkSyncCheckpoint(checkpoint);
        }''', project_key)
        peer.goto(BASE_URL + '/workbench', wait_until='networkidle')
        ready(peer, 'map')
        expect(canvas).to_have_attribute('data-placed-object-point-count', '0')
        expect(canvas).to_have_attribute('data-waypoint-count', '1')
        approve(host, peer)
        expect(control(peer)).to_have_attribute('data-sync-complete', 'true', timeout=30000)
        for page in [host, peer]:
            expect(page.locator('.three-canvas')).to_have_attribute('data-placed-object-point-count', str(counts['count']))
            expect(page.locator('.three-canvas')).to_have_attribute('data-waypoint-count', '1', timeout=12000)
        assert colors(peer) == actual, 'Legacy reconnection repairs the object mask'
        assert not errors, errors
        print('Work sync display passed: matching GPU colors, live settings, reload, portable ZIP and legacy repair with offline edits.')
    except Exception:
        host.screenshot(path=str(ARTIFACTS / 'host-failure.png'))
        peer.screenshot(path=str(ARTIFACTS / 'peer-failure.png'))
        print('Page errors:', errors)
        raise
    finally:
        host.goto('about:blank'); peer.goto('about:blank'); browser.close()
