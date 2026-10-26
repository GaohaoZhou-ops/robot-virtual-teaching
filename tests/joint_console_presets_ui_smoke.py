"""Record console poses, share them with presets, and inspect real downloaded exports.

Uses synthetic robot/workspace data in a fresh browser profile.
"""
import json
import math
import tempfile
import zipfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from abx_teaching_export_ui_smoke import BASE_URL, CHROME
from robot_preset_management_ui_smoke import close_manager, open_manager, rename, row, save_editor
from robot_presets_ui_smoke import scene_values, wait_for_robot
from teaching_preset_insertion_ui_smoke import wait_for_saved
from topbar_tools_helpers import topbar_action

ARTIFACTS = Path(__file__).resolve().parents[1] / 'test-artifacts/joint-console-presets'


def seed(page):
    page.goto(BASE_URL, wait_until='networkidle')
    page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
    page.evaluate('''async () => {
      const { teachingTransferFixture } = await import('/tests/teaching_transfer_helpers.mjs');
      const { abxTeachingFixture } = await import('/tests/abx_teaching_helpers.mjs');
      const store = await import('/src/lib/sessionStore.js');
      const { sessionId } = await store.fetchServiceSession();
      const { payload, robotPackage, values, model, stamp } = abxTeachingFixture();
      const urdf = `<robot name="${model}"><link name="base_link"/>` + Object.keys(values).map((name, i) => `
        <link name="link_${i}"><visual><geometry><box size="0.04 0.04 0.04"/></geometry></visual></link>
        <joint name="${name}" type="${name.startsWith('wheel_') ? 'continuous' : 'revolute'}">
          <parent link="${i ? `link_${i - 1}` : 'base_link'}"/><child link="link_${i}"/>
          <axis xyz="0 0 1"/><origin xyz="0 0 0.05"/>
          <limit lower="${-Math.PI}" upper="${Math.PI}" effort="100" velocity="10"/>
        </joint>`).join('') + '</robot>';
      robotPackage.files[0].bytes = new TextEncoder().encode(urdf);
      payload.robot.joints = values;
      const pose = (id, name, source) => ({ id, name, robot: payload.robot, createdAt: stamp, updatedAt: stamp,
        joints: { source, angularUnit: 'degree', linearUnit: 'meter', values: {...values} } });
      const canonical = pose('canonical', '原有顶部预设', 'robot-preset');
      const legacy = pose('console-old', '旧关节记录', 'joint-console');
      payload.virtualTeaching.jointPoses = [canonical, legacy];
      for (const mode of ['map', 'independent']) {
        const fixture = teachingTransferFixture(mode);
        fixture.map.portableRobotPackage = robotPackage;
        fixture.map.name = payload.map.fileName; fixture.map.sourceHash = payload.map.sourceHash;
        const project = structuredClone(payload);
        fixture.config.config.project = project;
        if (mode === 'independent') {
          project.workspace.teachingSpaceMode = mode; project.teachingSpace.mode = mode;
          project.map.teachingSpaceMode = mode; project.map.coordinateFrame = 'virtual_origin';
          project.coordinateSystem.frameId = project.teachingSpace.frameId = 'virtual_origin';
          project.virtualTeaching.jointPoses = [canonical];
          for (const task of project.virtualTeaching.tasks) {
            task.coordinateFrame = 'virtual_origin';
            for (const parking of task.parkingPoints) {
              parking.mapPose.frameId = 'virtual_origin';
              for (const point of parking.poses) point.mapPose.frameId = 'virtual_origin';
            }
          }
        }
        fixture.config.config.ui.selectedRobot = payload.robot;
        await store.saveWorkspaceMap(sessionId, fixture.map.mapId, fixture.map.name, fixture.map, mode);
        await store.saveWorkspaceConfig(sessionId, fixture.map.mapId, fixture.config.config, mode);
      }
      // Recreate the previous schema: the shared library omitted console poses.
      const db = await new Promise(resolve => { const r = indexedDB.open('atlas-route-studio'); r.onsuccess = () => resolve(r.result); });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('workspace-session', 'readwrite');
        tx.objectStore('workspace-session').put({key: 'shared-robot-presets', version: 1, revision: 3, poses: [canonical]});
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
      }); db.close();
      await store.activateWorkspaceMode(sessionId, 'map');
    }''')
    page.goto(BASE_URL + '/workbench', wait_until='networkidle')
    wait_for_robot(page)
    page.locator('.loading-curtain').wait_for(state='hidden')


def record(page, name, angle):
    page.get_by_role('button', name='打开全关节浮动窗口', exact=True).click()
    panel = page.get_by_role('dialog', name='全关节控制浮动窗口', exact=True)
    field = panel.get_by_role('spinbutton', name='left_J1 关节值', exact=True)
    field.fill(str(angle)); field.press('Enter')
    page.wait_for_function('angle => JSON.parse(document.querySelector(".three-canvas").dataset.robotJointValues).left_J1 === angle', arg=angle)
    panel.get_by_role('textbox', name='新关节姿态名称', exact=True).fill(name)
    panel.get_by_role('button', name='记录当前关节姿态', exact=True).click()
    expect(panel.get_by_role('button', name='执行关节姿态 ' + name, exact=True)).to_be_enabled()
    identity = panel.locator('.joint-pose-row').filter(has=page.get_by_role('button', name='执行关节姿态 ' + name, exact=True)).get_attribute('data-joint-pose-id')
    panel.get_by_role('button', name='关闭全关节浮动窗口', exact=True).click()
    expect(topbar_action(page, '应用预设姿态 ' + name, exact=True)).to_be_enabled()
    page.keyboard.press('Escape')
    return identity


def switch(page, mode):
    topbar_action(page, '切换到地图示教' if mode == 'map' else '切换到独立示教', exact=True).click()
    page.locator(f'[data-app-page="workbench"][data-teaching-space-mode="{mode}"][aria-hidden="false"]').wait_for()
    wait_for_robot(page)


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='joint-console-presets-') as directory, sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        page = browser.new_page(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
        page.set_default_timeout(30000)
        errors = []; page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            seed(page)
            expect(topbar_action(page, '应用预设姿态 旧关节记录', exact=True)).to_be_enabled()
            page.keyboard.press('Escape')
            new_id = record(page, '地图关节记录', 43)
            manager = open_manager(page, 3)
            rename(manager, 'console-old', '旧关节记录已同步')
            row(manager, 'console-old').get_by_role('button', name='编辑预设姿态', exact=False).click()
            editor = page.get_by_role('dialog', name='编辑预设姿态', exact=True)
            expect(editor.get_by_role('spinbutton', name='left_J1 预设关节值', exact=True)).to_have_value('10')
            editor.get_by_role('spinbutton', name='left_J1 预设关节值', exact=True).fill('17')
            save_editor(page, manager)
            close_manager(manager)
            topbar_action(page, '应用预设姿态 旧关节记录已同步', exact=True).click()
            page.wait_for_function('JSON.parse(document.querySelector(".three-canvas").dataset.robotJointValues).left_J1 === 17')
            topbar_action(page, '应用预设姿态 地图关节记录', exact=True).click()
            page.wait_for_function('JSON.parse(document.querySelector(".three-canvas").dataset.robotJointValues).left_J1 === 43')
            captured = scene_values(page)
            saved = wait_for_saved(page, lambda project: any(pose['id'] == new_id for pose in project['virtualTeaching']['jointPoses']))
            assert next(pose for pose in saved['virtualTeaching']['jointPoses'] if pose['id'] == new_id)['joints']['values'] == captured

            # The second workspace sees the same records, and can create another.
            switch(page, 'independent')
            expect(topbar_action(page, '应用预设姿态 地图关节记录', exact=True)).to_be_enabled()
            page.keyboard.press('Escape')
            independent_id = record(page, '独立关节记录', -25)
            wait_for_saved(page, lambda project: any(pose['id'] == independent_id for pose in project['virtualTeaching']['jointPoses']), 'independent')
            page.goto(BASE_URL + '/teaching-data', wait_until='domcontentloaded')
            page.locator('.loading-curtain').wait_for(state='hidden')
            page.get_by_role('button', name='选择示教任务 装配任务：中文校验', exact=True).click()
            with page.expect_download() as pending:
                page.get_by_role('button', name='导出示教数据', exact=True).click()
            independent_file = Path(directory) / 'independent.json'
            pending.value.save_as(independent_file)
            joint_poses = json.loads(independent_file.read_text())['jointPoses']
            assert next(pose for pose in joint_poses if pose['id'] == independent_id)['joints']['values']['left_J1'] == -25
            assert any(pose['id'] == new_id for pose in joint_poses)

            page.goto(BASE_URL + '/workbench', wait_until='networkidle'); wait_for_robot(page)
            switch(page, 'map')
            page.reload(wait_until='networkidle'); wait_for_robot(page)
            manager = open_manager(page, 4)
            expect(row(manager, independent_id)).to_contain_text('独立关节记录')
            page.screenshot(path=str(ARTIFACTS / 'shared-console-presets.png'), full_page=True)
            close_manager(manager)
            page.goto(BASE_URL + '/teaching-data', wait_until='domcontentloaded')
            page.locator('.loading-curtain').wait_for(state='hidden')
            page.get_by_role('button', name='选择示教任务 装配任务：中文校验', exact=True).click()
            page.get_by_role('button', name='导出示教数据', exact=True).click()
            dialog = page.get_by_role('dialog', name='导出机器人示教', exact=True)
            expect(dialog.get_by_label('随包预设姿态')).to_contain_text('已携带 4 个预设 / 基础姿态')
            with page.expect_download() as pending:
                dialog.get_by_role('button', name='下载机器人导入包', exact=True).click()
            bundle_path = Path(directory) / 'robot-teaching.zip'
            pending.value.save_as(bundle_path)
            with zipfile.ZipFile(bundle_path) as bundle:
                manifest = json.loads(bundle.read('manifest.json'))
                for index, task in enumerate(manifest['tasks']):
                    records = [json.loads(line) for line in bundle.read(task['file']).splitlines()]
                    basics = [entry for entry in records if entry['type'] == 'basic_pose']
                    assert [entry['name'] for entry in basics] == ['原有顶部预设', '旧关节记录已同步', '地图关节记录', '独立关节记录']
                    assert [entry['record']['joints_rad']['left_arm'][0] for entry in basics] == [math.radians(angle) for angle in [10, 17, 43, -25]]
                    assert records[0]['point_count'] == ('5' if index == 0 else '0'), 'presets must not become executable steps'
                    assert records[0]['basic_pose_count'] == records[-1]['basic_pose_count'] == '4'
            assert not errors, errors
            print('Console presets: legacy migration, immediate topbar display/application, editing, cross-workspace capture, reload, independent JSON and real robot ZIP export passed.', flush=True)
        except Exception:
            page.screenshot(path=str(ARTIFACTS / 'failure.png'), full_page=True)
            print('page errors:', errors, flush=True)
            raise
        finally:
            browser.close()


if __name__ == '__main__':
    run()
