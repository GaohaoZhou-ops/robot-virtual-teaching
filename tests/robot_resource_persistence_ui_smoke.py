"""Robot resource changes must survive reload; uses a disposable browser profile."""
import json
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from topbar_tools_helpers import topbar_action

BASE_URL = os.environ.get('BASE_URL', 'http://127.0.0.1:21994').rstrip('/')
CHROME = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')


def records(page):
    return page.evaluate('''async () => {
      const store = await import('/src/lib/sessionStore.js');
      const {sessionId} = await store.fetchServiceSession();
      const active = await store.loadWorkspaceSnapshot(sessionId, 'map');
      const companion = await store.loadWorkspaceSnapshot(sessionId, 'independent');
      const summarize = value => ({mapId: value.map.mapId, sourceHash: value.map.sourceHash,
        positions: Array.from(new Float32Array(value.map.positionBuffer)),
        tasks: value.config.config.project.teachingTasks,
        packagePath: value.map.portableRobotPackage?.relativePath || null,
        packageDigest: value.map.portableRobotPackage?.resourceDigest || null,
        selection: value.config.config.ui.selectedRobot});
      return {active: summarize(active), companion: summarize(companion)};
    }''')


def loaded(page, old=False):
    page.locator('[data-session-state="ready"]:visible').wait_for()
    page.locator('.loading-curtain').wait_for(state='hidden')
    page.wait_for_function('''old => {
      const d = document.querySelector('.three-canvas')?.dataset;
      return d?.robotModelState === 'loaded' && (old ? +d.robotLinkCount === 3 : +d.robotLinkCount > 3);
    }''', arg=old, timeout=120_000)


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME)
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        page.set_default_timeout(30_000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            page.goto(BASE_URL, wait_until='networkidle')
            page.locator('[data-session-state="ready"]:visible').wait_for()
            page.evaluate('''async () => {
              const {teachingTransferFixture} = await import('/tests/teaching_transfer_helpers.mjs');
              const store = await import('/src/lib/sessionStore.js');
              const {sessionId} = await store.fetchServiceSession();
              const {robots} = await (await fetch('/__atlas/robots')).json();
              const robot = robots.find(robot => robot.name === 'botx_abx_zivid_m70');
              if (!robot) throw new Error('This test requires the installed BOTX camera model');
              const fixture = teachingTransferFixture('map');
              fixture.config.config.project.robot = {...fixture.config.config.project.robot, ...robot, joints: {}};
              // Legacy archive configuration has no explicit portableResourceId.
              fixture.config.config.ui.selectedRobot = fixture.config.config.project.robot;
              fixture.map.portableRobotPackage = {...robot, resourceDigest: 'old-cached-camera-test', files: [{
                path: robot.relativePath, mimeType: 'application/xml', bytes: new TextEncoder().encode(`
                  <robot name="cached_old_botx"><link name="base_link"><visual><geometry><box size=".4 .3 .4"/></geometry></visual></link>
                  <link name="zivid_left_link"/><joint name="zivid_left_mount_joint" type="fixed"><parent link="base_link"/>
                    <child link="zivid_left_link"/><origin xyz="0 0 .5" rpy="0 3.1415926536 -1.5707963267948966"/></joint>
                  <link name="zivid_left_optical_frame"/><joint name="zivid_left_optical_joint" type="fixed">
                    <parent link="zivid_left_link"/><child link="zivid_left_optical_frame"/><origin xyz="0 0 .125" rpy="0 0 -1.5707963268"/></joint></robot>`)
              }]};
              const companion = teachingTransferFixture('independent');
              for (const item of [companion, fixture]) {
                await store.saveWorkspaceMap(sessionId, item.map.mapId, item.map.name, item.map, item.mode);
                await store.saveWorkspaceConfig(sessionId, item.map.mapId, item.config.config, item.mode);
              }
              window.oldPackage = fixture.map.portableRobotPackage;
            }''')
            page.goto(BASE_URL + '/workbench', wait_until='networkidle')
            loaded(page, old=True)
            initial = records(page)
            assert initial['active']['packageDigest'] == 'old-cached-camera-test'
            # An imported/offline project still uses its own bundled resources.
            page.route('**/__atlas/robot-files/**', lambda route: route.abort())
            page.reload(wait_until='networkidle')
            loaded(page, old=True)
            page.unroute('**/__atlas/robot-files/**')
            before = records(page)
            assert before['active']['packageDigest'] == 'old-cached-camera-test'

            topbar_action(page, name='加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70').click()
            loaded(page)
            page.wait_for_function('''async () => {
              const store = await import('/src/lib/sessionStore.js');
              const data = await store.loadWorkspaceSnapshot((await store.fetchServiceSession()).sessionId, 'map');
              return data.config.config.ui.selectedRobot?.portableResourceId === null;
            }''')
            selected = records(page)
            if os.environ.get('EXPECT_OLD_BUG') == '1':
                assert selected['active']['packageDigest'] == 'old-cached-camera-test'
                page.reload(wait_until='networkidle')
                loaded(page, old=True)
                print('Reproduced: catalog selection saves but old cached package returns after reload')
                return
            assert selected['active']['packagePath'] is None, selected['active']['packagePath']
            optical_pose = page.locator('.three-canvas').get_attribute('data-zivid-left-optical-quaternion')
            for _ in range(2):
                page.reload(wait_until='networkidle')
                loaded(page)
                expect(page.locator('.three-canvas')).to_have_attribute('data-zivid-left-optical-quaternion', optical_pose)
                after = records(page)
                assert after['active']['packagePath'] is None
                for key in ['mapId', 'sourceHash', 'positions', 'tasks']:
                    assert after['active'][key] == selected['active'][key], key
                assert after['companion'] == before['companion']

            # Repair an old inconsistent database: explicit catalog choice + old bundle.
            page.evaluate('''async () => {
              const db = await new Promise((resolve, reject) => { const r = indexedDB.open('atlas-route-studio'); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); });
              await new Promise((resolve, reject) => {
                const tx=db.transaction('workspace-session','readwrite'), s=tx.objectStore('workspace-session');
                tx.oncomplete=resolve; tx.onabort=()=>reject(tx.error);
                const r=s.get('workspace-map:map');
                r.onsuccess=()=>{const map=r.result; map.portableRobotPackage={relativePath:'botx_abx_zivid_m70/urdf/botx_abx_zivid_m70.urdf',
                  resourceDigest:'stale-invalid-package', files:[]}; s.put(map);};
              }); db.close();
            }''')
            page.reload(wait_until='networkidle')
            loaded(page)
            assert records(page)['active']['packagePath'] is None

            # Failed map-cache writes must also roll back the robot selection.
            result = page.evaluate('''async () => {
              const store = await import('/src/lib/sessionStore.js');
              const {sessionId}=await store.fetchServiceSession();
              const before=await store.loadWorkspaceSnapshot(sessionId,'independent');
              const config=structuredClone(before.config.config);
              config.ui.selectedRobot={...config.project.robot,portableResourceId:null};
              const put=IDBObjectStore.prototype.put;
              IDBObjectStore.prototype.put=function(value,...args) {
                const request=put.call(this,value,...args);
                if (value.key==='workspace-map:independent' && value.portableRobotPackage===null) throw new Error('injected robot cache failure');
                return request;
              };
              let error='';
              try {await store.saveWorkspaceConfig(sessionId,before.map.mapId,config,'independent');}
              catch(e) {error=e.message;} finally {IDBObjectStore.prototype.put=put;}
              const after=await store.loadWorkspaceSnapshot(sessionId,'independent');
              return {error, configUnchanged:JSON.stringify(before.config)===JSON.stringify(after.config),
                packagePreserved:after.map.portableRobotPackage?.relativePath===before.map.portableRobotPackage.relativePath};
            }''')
            assert result == {'error': 'injected robot cache failure', 'configUnchanged': True, 'packagePreserved': True}, result
            assert not errors, errors
            print(json.dumps({'passed': True, 'checks': ['offline portable restore', 'catalog replacement', 'two reloads', 'optical pose stable', 'old cache repair', 'map and teaching preserved', 'other workspace preserved', 'atomic rollback']}, ensure_ascii=False))
        finally:
            out = Path('test-artifacts/robot-resource-persistence')
            out.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(out / 'last-state.png'))
            browser.close()


if __name__ == '__main__':
    run()
