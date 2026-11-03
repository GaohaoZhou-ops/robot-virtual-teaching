"""Exercise durable iPad snapshots in real IndexedDB without user workspaces."""
import os
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:22076').rstrip('/')
CHROME = os.environ.get('CHROME_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=CHROME)
    try:
        page = browser.new_page()
        page.route('**/library-storage-test', lambda route: route.fulfill(content_type='text/html', body='<html>iPad library test</html>'))
        page.goto(BASE + '/library-storage-test')
        page.wait_for_load_state('networkidle')
        print(page.evaluate('''async () => {
          const s = await import('/src/features/workspace/model/sessionStore.js');
          const { projectCollectionFixture } = await import('/tests/project_collection_helpers.mjs');
          const { teachingTransferFixture } = await import('/tests/teaching_transfer_helpers.mjs');
          const check = (value, message) => { if (!value) throw Error(message); };
          const sid = 'ipad-library-test';
          await s.prepareWorkspaceSession(sid);
          const original = await projectCollectionFixture();
          await s.restoreWorkspaceCollection(sid, original, 'map');
          let entries = await s.saveIPadProjectLibrary(sid);
          check(entries.length === 4, 'Map, independent project and both historical groups must be listed');
          for (const entry of entries) {
            const snapshot = [...Object.values(original.workspaces), ...original.independentHistory]
              .find(item => entry.id === item.mode + ':' + item.map.mapId);
            const tasks = snapshot.config.config.project.virtualTeaching.tasks;
            const poses = tasks.reduce((n, task) => n + task.parkingPoints.reduce((count, point) => count + point.poses.length, 0), 0);
            check(entry.taskCount === tasks.length && entry.poseCount === poses, 'Teaching counts were lost');
          }
          await s.clearAllWorkspaceCaches(sid);
          check(!(await s.prepareWorkspaceSession(sid)).map, 'Workspace cache should be empty');
          await s.restoreIPadLibraryProject(sid, 'map:' + original.workspaces.map.map.mapId);
          const active = await s.loadWorkspaceSnapshot(sid, 'map');
          const companions = await s.loadProjectCompanions(sid, 'map');
          check(companions.independentHistory.length === 2, 'Historical groups must survive cache clearing');
          const restored = [active, companions.companionWorkspace, ...companions.independentHistory];
          const expected = [...Object.values(original.workspaces), ...original.independentHistory];
          for (const snapshot of restored) {
            const before = expected.find(item => item.map.mapId === snapshot.map.mapId);
            check(JSON.stringify(snapshot.config.config.project) === JSON.stringify(before.config.config.project), 'Poses, calibration or relation changed');
            check(String(new Uint8Array(snapshot.map.positionBuffer)) === String(new Uint8Array(before.map.positionBuffer)), 'Geometry changed');
            check(snapshot.map.portableRobotPackage.files.length === before.map.portableRobotPackage.files.length, 'Robot resources lost');
          }
          const updated = structuredClone(active.config.config);
          updated.project.virtualTeaching.tasks[0].name = 'edited on iPad';
          await s.saveWorkspaceConfig(sid, active.map.mapId, updated, 'map');
          await s.saveIPadProjectLibrary(sid);
          const failedUpdate = structuredClone(updated);
          failedUpdate.project.virtualTeaching.tasks[0].name = 'must not replace saved copy';
          await s.saveWorkspaceConfig(sid, active.map.mapId, failedUpdate, 'map');
          const put = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = function(value, ...args) {
            if (value.key === 'ipad-library-config:map:' + active.map.mapId) throw Error('simulated write failure');
            return put.call(this, value, ...args);
          };
          let writeFailed = false;
          try { await s.saveIPadProjectLibrary(sid); } catch { writeFailed = true; }
          finally { IDBObjectStore.prototype.put = put; }
          check(writeFailed, 'Failed snapshot must report failure');
          await s.restoreIPadLibraryProject(sid, 'map:' + active.map.mapId);
          check((await s.loadWorkspaceSnapshot(sid, 'map')).config.config.project.virtualTeaching.tasks[0].name === 'edited on iPad', 'Failed save replaced last complete snapshot');
          const other = teachingTransferFixture('map'); other.map.mapId = 'different-map';
          await s.saveWorkspaceMap(sid, other.map.mapId, 'other.ply', other.map, 'map');
          // An incomplete import must not create an unusable native list entry.
          check((await s.saveIPadProjectLibrary(sid)).length === 4, 'Partial import leaked into library');
          await s.saveWorkspaceConfig(sid, other.map.mapId, other.config.config, 'map');
          await s.saveIPadProjectLibrary(sid);
          await s.restoreIPadLibraryProject(sid, 'map:' + active.map.mapId);
          check((await s.loadWorkspaceSnapshot(sid, 'map')).config.config.project.virtualTeaching.tasks[0].name === 'edited on iPad', 'Opening another map replaced previous work');
          await s.resetWorkspaceSession('new-service');
          await s.restoreIPadLibraryProject('new-service', 'map:' + active.map.mapId);
          check((await s.prepareWorkspaceSession('new-service')).map.mapId === active.map.mapId, 'Service restart lost library');

          const large = teachingTransferFixture('map'); large.map.mapId = 'large-library-map';
          const positions = new Float32Array(Math.floor(70 * 1024 * 1024 / 12) * 3);
          positions[0] = 17; positions[positions.length - 1] = 29;
          large.map.positionBuffer = positions.buffer;
          await s.saveWorkspaceMap('new-service', large.map.mapId, 'large.ply', large.map, 'map');
          await s.saveWorkspaceConfig('new-service', large.map.mapId, large.config.config, 'map');
          await s.saveIPadProjectLibrary('new-service');
          await s.clearAllWorkspaceCaches('new-service');
          await s.restoreIPadLibraryProject('new-service', 'map:large-library-map');
          const bytes = new Float32Array((await s.loadWorkspaceSnapshot('new-service', 'map')).map.positionBuffer);
          check(bytes.length === positions.length && bytes[0] === 17 && bytes.at(-1) === 29, 'Large packed geometry changed');
          let rejected = false;
          try { await s.restoreIPadLibraryProject('new-service', 'map:missing'); } catch { rejected = true; }
          check(rejected && (await s.loadWorkspaceSnapshot('new-service', 'map')).map.mapId === large.map.mapId, 'Failed open changed current work');
          return {projects: (await s.saveIPadProjectLibrary('new-service')).length, largeBytes: bytes.byteLength, restoredHistory: companions.independentHistory.length};
        }'''))
    finally:
        browser.close()
