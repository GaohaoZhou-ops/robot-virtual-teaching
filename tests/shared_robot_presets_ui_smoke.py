"""Migrate legacy per-workspace presets and exercise the shared library in a fresh profile."""
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
from robot_preset_management_ui_smoke import seed, open_manager, close_manager, row, rename, delete, save_editor
from robot_presets_ui_smoke import wait_for_robot
from teaching_transfer_ui_smoke import CHROME, BASE_URL
from topbar_tools_helpers import topbar_action

ARTIFACTS = Path(__file__).resolve().parents[1] / 'test-artifacts/shared-robot-presets'


def records(page):
    return page.evaluate('''async () => {
      const db = await new Promise(resolve => { const r = indexedDB.open('atlas-route-studio'); r.onsuccess = () => resolve(r.result); });
      const tx = db.transaction('workspace-session'), store = tx.objectStore('workspace-session');
      const read = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const keys = (await read(store.getAllKeys())).filter(k => k === 'shared-robot-presets' || k.startsWith('workspace-config:') || k.startsWith('independent-history-config:'));
      const values = await Promise.all(keys.map(k => read(store.get(k)))); db.close();
      return Object.fromEntries(values.map(value => [value.key, value]));
    }''')


def assert_shared(page, names):
    data = records(page)
    assert [pose['name'] for pose in data['shared-robot-presets']['poses']] == names
    for key, record in data.items():
        if key == 'shared-robot-presets':
            continue
        poses = record['config']['project']['virtualTeaching']['jointPoses']
        assert [pose['name'] for pose in poses if pose['joints'].get('source') == 'robot-preset'] == names, key
        assert poses[0]['id'] == 'joint-preset' and poses[0]['joints']['values'] == {'shoulder': 12, 'lift': .4}, key
    return data


def switch(page, mode, group='工位 B'):
    topbar_action(page, '切换到地图示教' if mode == 'map' else '切换到独立示教', exact=True).click()
    if mode == 'independent':
        page.get_by_role('button', name='进入独立示教 ' + group, exact=True).click()
    page.locator(f'[data-app-page=workbench][data-teaching-space-mode={mode}][aria-hidden=false]').wait_for()
    wait_for_robot(page)


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        page.set_default_timeout(30000)
        errors = []; page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            seed(page, 'map')
            page.wait_for_timeout(300)  # Drain fixture hydration's debounced autosave.
            page.evaluate('''async () => {
              const store = await import('/src/lib/sessionStore.js');
              const { teachingTransferFixture } = await import('/tests/teaching_transfer_helpers.mjs');
              const { sessionId } = await store.fetchServiceSession();
              const original = await store.loadWorkspaceSnapshot(sessionId, 'map');
              const mapPresets = original.config.config.project.virtualTeaching.jointPoses.filter(p => p.joints.source === 'robot-preset');
              // Recreate the OLD schema: separate lists, with independent active.
              const db = await new Promise(resolve => { const r = indexedDB.open('atlas-route-studio'); r.onsuccess = () => resolve(r.result); });
              await new Promise((resolve, reject) => { const tx = db.transaction('workspace-session', 'readwrite');
                tx.objectStore('workspace-session').delete('shared-robot-presets'); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
              const fixture = teachingTransferFixture('independent');
              fixture.map.portableRobotPackage = original.map.portableRobotPackage;
              fixture.config.config.project.robot = original.config.config.project.robot;
              fixture.config.config.ui.selectedRobot = original.config.config.project.robot;
              fixture.config.config.project.workspace.independentTeachingName = '工位 A';
              fixture.config.config.project.virtualTeaching.jointPoses.push(...mapPresets.map(p => ({...p, id: 'duplicate-' + p.id, name: p.name + '重复'})));
              await store.saveWorkspaceMap(sessionId, fixture.map.mapId, fixture.map.name, fixture.map, 'independent');
              await store.saveWorkspaceConfig(sessionId, fixture.map.mapId, fixture.config.config, 'independent');
              const previous = await store.loadWorkspaceSnapshot(sessionId, 'independent');
              fixture.map.mapId = 'independent-b'; fixture.map.teachingGroupId = 'independent-b';
              fixture.config.config.project.workspace.independentTeachingName = '工位 B';
              await store.switchIndependentWorkspace(sessionId, {activeMode: 'independent', expectedConfig: previous.config,
                replacement: {map: fixture.map, config: fixture.config.config}});
            }''')
            page.reload(wait_until='networkidle'); wait_for_robot(page)
            names = ['准备姿态', '结束姿态', '其他预设']
            assert_shared(page, names)
            manager = open_manager(page, 3)
            expect(manager).to_contain_text('地图示教与独立示教共用')
            rename(manager, 'prepare', '共享准备')
            names[0] = '共享准备'; assert_shared(page, names)
            manager.get_by_role('button', name='新建预设姿态', exact=True).click()
            editor = page.get_by_role('dialog', name='新建预设姿态', exact=True)
            editor.get_by_role('textbox', name='预设姿态名称').fill('独立新增')
            editor.get_by_role('spinbutton', name='left_J1 预设关节值').fill('42')
            editor.get_by_role('button', name='保存姿态', exact=True).click()
            expect(editor).not_to_be_visible(); expect(manager.locator('li')).to_have_count(4)
            names.append('独立新增'); data = assert_shared(page, names)
            new_id = data['shared-robot-presets']['poses'][-1]['id']
            close_manager(manager); switch(page, 'map')
            manager = open_manager(page, 4)
            row(manager, new_id).get_by_role('button', name='编辑预设姿态', exact=False).click()
            editor = page.get_by_role('dialog', name='编辑预设姿态', exact=True)
            expect(editor.get_by_role('spinbutton', name='left_J1 预设关节值')).to_have_value('42')
            editor.get_by_role('spinbutton', name='left_J1 预设关节值').fill('-35')
            save_editor(page, manager)
            data = assert_shared(page, names)
            assert data['shared-robot-presets']['poses'][-1]['joints']['values']['left_J1'] == -35
            delete(manager, 'finish'); names.remove('结束姿态'); assert_shared(page, names)
            page.screenshot(path=str(ARTIFACTS / 'map-shared-library.png'), full_page=True)
            close_manager(manager); switch(page, 'independent', '工位 A')
            manager = open_manager(page, 3)
            for identity in ['prepare', 'other', new_id]:
                delete(manager, identity)
            assert_shared(page, [])
            close_manager(manager); switch(page, 'map')
            manager = open_manager(page, 0); close_manager(manager)
            page.reload(wait_until='networkidle'); wait_for_robot(page)
            manager = open_manager(page, 0); close_manager(manager)
            assert_shared(page, [])
            # A stale legacy autosave cannot repopulate the authoritative empty list.
            page.evaluate('''async () => {
              const store = await import('/src/lib/sessionStore.js');
              const { createRobotJointPreset } = await import('/src/lib/robotJointPresets.js');
              const { sessionId } = await store.fetchServiceSession();
              const snapshot = await store.loadWorkspaceSnapshot(sessionId, 'independent');
              snapshot.config.config.project.virtualTeaching.jointPoses.push(createRobotJointPreset({id: 'stale', name: '旧副本',
                robot: snapshot.config.config.project.robot, joints: [{name: 'left_J1', type: 'revolute'}], values: {left_J1: 0}}));
              await store.saveWorkspaceConfig(sessionId, snapshot.map.mapId, snapshot.config.config, 'independent');
            }''')
            assert_shared(page, [])
            assert not errors, errors
            print('Shared preset UI: map-authoritative migration while independent is active, history cleanup, bidirectional CRUD, empty-library deletion, reload and stale-cache protection passed.', flush=True)
        except Exception as error:
            page.screenshot(path=str(ARTIFACTS / 'failure.png'), full_page=True)
            print('failure:', repr(error), 'page errors:', errors, flush=True)
            raise
        finally:
            browser.close()


if __name__ == '__main__':
    run()
