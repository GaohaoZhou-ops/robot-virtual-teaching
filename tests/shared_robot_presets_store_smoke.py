"""IndexedDB migration/atomicity checks in an isolated blank browser page."""
import os
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:22199')


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        page = browser.new_page()
        try:
            page.route('**/__preset-store-harness', lambda route: route.fulfill(content_type='text/html', body='<title>Preset storage fixture</title>'))
            page.goto(BASE + '/__preset-store-harness')
            result = page.evaluate('''async () => {
              const s = await import('/src/features/workspace/model/sessionStore.js');
              const { teachingTransferFixture } = await import('/tests/teaching_transfer_helpers.mjs');
              const { createRobotJointPreset } = await import('/src/features/robot/model/robotJointPresets.js');
              const check = (condition, text) => { if (!condition) throw new Error(text); };
              const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
              const session = 'preset-store-fixture';
              await s.prepareWorkspaceSession(session);
              const make = (id, name) => createRobotJointPreset({id, name, robot: {id: 'test-robot'},
                joints: [{name: 'left_J1', type: 'revolute'}], values: {left_J1: 30}});
              const map = teachingTransferFixture('map'), independent = teachingTransferFixture('independent');
              const mapPreset = make('canonical', '地图保留'), duplicate = make('duplicate', '独立重复');
              map.config.config.project.virtualTeaching.jointPoses.push(mapPreset);
              independent.config.config.project.virtualTeaching.jointPoses.push(duplicate);
              const seed = async () => {
                for (const fixture of [map, independent]) {
                  await s.saveWorkspaceMap(session, fixture.map.mapId, fixture.map.name, fixture.map, fixture.mode);
                  await s.saveWorkspaceConfig(session, fixture.map.mapId, fixture.config.config, fixture.mode);
                }
              };
              const raw = async () => {
                const db = await new Promise(resolve => { const r = indexedDB.open('atlas-route-studio'); r.onsuccess = () => resolve(r.result); });
                const tx = db.transaction('workspace-session'), store = tx.objectStore('workspace-session');
                const keys = ['shared-robot-presets','workspace-config:map','workspace-config:independent'];
                const values = await Promise.all(keys.map(k => new Promise(resolve => { const r=store.get(k); r.onsuccess=()=>resolve(r.result); })));
                db.close(); return values;
              };
              const failPut = async action => {
                const original = IDBObjectStore.prototype.put;
                IDBObjectStore.prototype.put = function(value, ...args) {
                  if (value.key === 'workspace-config:independent') throw new Error('injected preset snapshot failure');
                  return original.call(this, value, ...args);
                };
                let error;
                try { await action(); } catch (reason) { error = reason; }
                finally { IDBObjectStore.prototype.put = original; }
                check(error?.message.includes('injected'), 'fixture must reach the injected write failure');
              };
              await seed();
              const beforeMigration = await raw();
              await failPut(() => s.loadSharedRobotPresets());
              check(equal(await raw(), beforeMigration), 'failed migration must roll back the library AND both workspace snapshots');
              const initial = await s.loadSharedRobotPresets();
              check(initial.poses.length === 1 && initial.poses[0].id === 'canonical', 'migration chooses only map presets');
              const baseline = await raw();
              for (const record of baseline.slice(1)) {
                const poses = record.config.project.virtualTeaching.jointPoses;
                check(equal(poses[0], map.config.config.project.virtualTeaching.jointPoses[0]), 'ordinary poses remain unchanged');
                check(poses[1].id === 'canonical', 'both workspaces use the canonical identity');
              }
              const editedConfig = structuredClone(baseline[1].config);
              editedConfig.project.virtualTeaching.jointPoses[1].name = '独立编辑';
              await failPut(() => s.saveWorkspaceConfig(session, map.map.mapId, editedConfig, 'map', {presetLibrary: initial}));
              check(equal(await raw(), baseline), 'failed preset edit must not partially update the library or caches');
              const saved = await s.saveWorkspaceConfig(session, map.map.mapId, editedConfig, 'map', {presetLibrary: initial});
              const updated = await raw();
              check(updated[0].poses[0].name === '独立编辑', 'shared edit is persisted');
              check(updated.slice(1).every(r => r.config.project.virtualTeaching.jointPoses[1].name === '独立编辑'), 'edit reaches both caches');
              let staleError;
              try { await s.saveWorkspaceConfig(session, map.map.mapId, baseline[1].config, 'map', {presetLibrary: initial}); }
              catch (error) { staleError = error; }
              check(staleError?.message.includes('其他页面'), 'stale writers cannot overwrite a newer shared edit');
              check(equal(await raw(), updated), 'stale write leaves data intact');
              await s.saveWorkspaceConfig(session, independent.map.mapId, independent.config.config, 'independent');
              check((await raw())[2].config.project.virtualTeaching.jointPoses[1].name === '独立编辑', 'old autosaves cannot reintroduce independent copies');
              const noPresets = structuredClone(editedConfig); noPresets.project.virtualTeaching.jointPoses.pop();
              const cleared = await s.saveWorkspaceConfig(session, map.map.mapId, noPresets, 'map', {presetLibrary: saved.presetLibrary});
              check(cleared.presetLibrary.poses.length === 0 && (await s.loadSharedRobotPresets()).poses.length === 0, 'deleting the last preset remains authoritative after reload');
              const imported = await s.importSharedRobotPresets(session, [make('new', '新导入')]);
              check(imported.poses.length === 1 && (await raw()).slice(1).every(r => r.config.project.virtualTeaching.jointPoses[1].id === 'new'), 'explicit imports join the shared library');
              const repeated = await s.importSharedRobotPresets(session, [make('other-id', '新导入')]);
              check(repeated.poses.length === 1, 'reimporting the same robot/name does not duplicate it');
              await s.clearAllWorkspaceCaches(session);
              check((await s.loadSharedRobotPresets()).poses.length === 0, 'global reset clears the shared library');
              map.config.config.project.virtualTeaching.jointPoses.pop();
              await seed();
              check((await s.loadSharedRobotPresets()).poses.length === 0, 'an explicitly empty map library wins over independent presets during migration');
              // Simulate the already-deployed v1 shared library plus console
              // records that were still stored locally in both workspaces/history.
              const legacy = (id, angle) => ({...make(id, '同名关节记录'),
                joints: {source: 'joint-console', angularUnit: 'degree', linearUnit: 'meter', values: {left_J1: angle}}});
              const currentMap = structuredClone(map.config.config);
              currentMap.project.virtualTeaching.jointPoses.push(mapPreset, legacy('console-map', 12));
              const currentIndependent = structuredClone(independent.config.config);
              currentIndependent.project.virtualTeaching.jointPoses.push(legacy('console-independent', 34));
              const older = structuredClone(currentMap);
              older.project.virtualTeaching.jointPoses = [legacy('console-map', 99), legacy('console-history', 56)];
              const db = await new Promise(resolve => { const r=indexedDB.open('atlas-route-studio'); r.onsuccess=()=>resolve(r.result); });
              await new Promise((resolve, reject) => {
                const tx=db.transaction('workspace-session','readwrite'), store=tx.objectStore('workspace-session');
                store.put({key:'shared-robot-presets', version:1, revision:7, poses:[mapPreset]});
                for (const [key, config] of [['workspace-config:map',currentMap], ['workspace-config:independent',currentIndependent],
                  ['independent-history-config:legacy',older]]) store.put({key, sessionId:session, mapId:key.includes('independent') ? independent.map.mapId : map.map.mapId, config});
                tx.oncomplete=resolve; tx.onabort=()=>reject(tx.error);
              }); db.close();
              const v1 = await raw();
              await failPut(() => s.loadSharedRobotPresets());
              check(equal(await raw(), v1), 'console migration failure rolls back v1 library and all snapshots');
              const upgraded = await s.loadSharedRobotPresets();
              check(upgraded.version === 2 && upgraded.revision === 8, 'existing libraries upgrade once');
              check(equal(upgraded.poses.map(p=>p.id), ['canonical','console-map','console-independent','console-history']),
                'console poses from both modes/history join without reviving discarded independent robot presets');
              check(equal(upgraded.poses.slice(1).map(p=>p.joints.values.left_J1), [12,34,56]),
                'same-name poses retain distinct values and current snapshots take priority');
              check(equal(await s.loadSharedRobotPresets(), upgraded), 'migration is idempotent');
              const afterUpgrade = await raw();
              check(afterUpgrade.slice(1).every(r => r.config.project.virtualTeaching.jointPoses.length === 5), 'console poses reach both workspace caches');
              const deleted = structuredClone(afterUpgrade[1].config);
              deleted.project.virtualTeaching.jointPoses = deleted.project.virtualTeaching.jointPoses.filter(p => p.joints.source !== 'joint-console');
              await s.saveWorkspaceConfig(session, map.map.mapId, deleted, 'map', {presetLibrary:upgraded});
              check(equal((await s.loadSharedRobotPresets()).poses.map(p=>p.id), ['canonical']),
                'deleted migrated console records must not reappear from history on reload');
              return 'Shared preset storage: map-priority migration, atomic rollback, stale-writer protection, empty deletion, imports and global reset passed.';
            }''')
            print(result, flush=True)
        finally:
            browser.close()


if __name__ == '__main__':
    run()
