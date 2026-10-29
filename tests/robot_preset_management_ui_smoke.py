"""Exercise preset CRUD, focus, persistence and portable export in both workspaces."""
import math
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from archive_helpers import read_exported_project, start_project_download
from dual_teaching_workspace_smoke import BASE_URL, create_project, wait_for_home
from export_separation_ui_smoke import load_project
from robot_presets_ui_smoke import scene_values, wait_for_preview, wait_for_robot
from teaching_preset_insertion_ui_smoke import saved_project
from teaching_transfer_ui_smoke import CHROME
from topbar_tools_helpers import topbar_action


def seed(page, mode):
    page.goto(BASE_URL, wait_until='networkidle')
    wait_for_home(page)
    page.evaluate('''async mode => {
      const { teachingTransferFixture } = await import('/tests/teaching_transfer_helpers.mjs');
      const { createRobotJointPreset } = await import('/src/features/robot/model/robotJointPresets.js');
      const store = await import('/src/features/workspace/model/sessionStore.js');
      const { sessionId } = await store.fetchServiceSession();
      const fixture = teachingTransferFixture(mode), project = fixture.config.config.project;
      const joints = ['left_J1', 'right_J1', 'head_pitch_J'].map(name => ({name, type: 'revolute', lower: -180, upper: 180}));
      joints.push({name: 'torso_lift', type: 'prismatic', lower: 0, upper: 1});
      const urdf = '<robot name="preset_test"><link name="base_link"/>' + joints.map((joint, i) => `
        <link name="link_${i}"><visual><geometry><box size="0.1 0.1 0.1"/></geometry></visual></link>
        <joint name="${joint.name}" type="${joint.type}"><parent link="${i ? `link_${i - 1}` : 'base_link'}"/>
          <child link="link_${i}"/><axis xyz="0 0 1"/><origin xyz="0 0 0.2"/>
          <limit lower="${joint.type === 'prismatic' ? 0 : -Math.PI}" upper="${joint.type === 'prismatic' ? 1 : Math.PI}" effort="100" velocity="10"/>
        </joint>`).join('') + '</robot>';
      fixture.map.portableRobotPackage.files[0].bytes = new TextEncoder().encode(urdf);
      project.robot.name = '测试机器人';
      project.robot.joints = {left_J1: 10, right_J1: 20, head_pitch_J: 0, torso_lift: 0.2};
      const presets = [
        {id: 'prepare', name: '准备姿态', robot: project.robot, values: {left_J1: -20, right_J1: 30, head_pitch_J: 10, torso_lift: 0.3}},
        {id: 'finish', name: '结束姿态', robot: project.robot, values: {left_J1: 25, right_J1: -35, head_pitch_J: 15, torso_lift: 0.4}},
        {id: 'other', name: '其他预设', robot: {id: 'other-robot', name: '其他机器人'}, values: {left_J1: 0, right_J1: 0, head_pitch_J: 0, torso_lift: 0}},
      ].map((data, index) => ({...createRobotJointPreset({...data, joints, sequence: index + 2}), createdAt: '2026-01-01T00:00:00.000Z'}));
      // Legacy projects may store angular values in radians. Linear values stay in meters.
      presets[1].joints.angularUnit = 'rad';
      for (const joint of joints.filter(item => item.type !== 'prismatic')) presets[1].joints.values[joint.name] *= Math.PI / 180;
      project.virtualTeaching.jointPoses.push(...presets);
      fixture.config.config.ui.selectedRobot = project.robot;
      await store.saveWorkspaceMap(sessionId, fixture.map.mapId, fixture.map.name, fixture.map, mode);
      await store.saveWorkspaceConfig(sessionId, fixture.map.mapId, fixture.config.config, mode);
      await store.activateWorkspaceMode(sessionId, mode);
    }''', mode)
    page.goto(BASE_URL + '/workbench', wait_until='networkidle')
    wait_for_robot(page)
    page.locator('.loading-curtain').wait_for(state='hidden')


def open_manager(page, count):
    button = topbar_action(page, '管理预设姿态', exact=True)
    assert button.evaluate('el => el.previousElementSibling.textContent') == '新建预设姿态'
    button.click()
    dialog = page.get_by_role('dialog', name='管理预设姿态', exact=True)
    expect(dialog).to_be_visible()
    expect(dialog.locator('li')).to_have_count(count)
    return dialog


def row(dialog, identity):
    return dialog.locator(f'li[data-preset-id="{identity}"]')


def close_manager(dialog):
    dialog.get_by_role('button', name='完成', exact=True).click()
    expect(dialog).to_have_count(0)


def save_editor(page, manager):
    page.get_by_role('dialog', name='编辑预设姿态', exact=True).get_by_role('button', name='保存姿态', exact=True).click()
    expect(page.get_by_role('dialog', name='编辑预设姿态', exact=True)).to_have_count(0)
    expect(manager).to_be_visible()


def rename(manager, identity, name):
    item = row(manager, identity)
    item.get_by_role('button', name='重命名预设姿态', exact=False).click()
    item.get_by_role('textbox', name='预设姿态新名称', exact=True).fill(name)
    item.get_by_role('button', name='保存名称', exact=True).click()
    expect(item.get_by_role('textbox')).to_have_count(0)


def delete(manager, identity):
    item = row(manager, identity)
    item.get_by_role('button', name='删除预设姿态', exact=False).click()
    item.get_by_role('button', name='确认删除', exact=True).click()
    expect(item).to_have_count(0)


def run():
    errors = []
    with tempfile.TemporaryDirectory(prefix='atlas-preset-manager-') as temporary, sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            for mode in ('map', 'independent'):
                context = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
                page = context.new_page()
                page.set_default_timeout(30_000)
                page.on('pageerror', lambda error: errors.append(str(error)))
                seed(page, mode)
                original = saved_project(page, mode)
                robot_before = scene_values(page)
                manager = open_manager(page, 3)
                expect(manager.get_by_role('button', name='关闭预设姿态管理', exact=True)).to_be_focused()
                expect(row(manager, 'other').get_by_role('button', name='编辑预设姿态', exact=False)).to_be_disabled()
                expect(page.locator('.app-shell[data-app-page="workbench"]')).to_have_attribute('inert', '')

                row(manager, 'prepare').get_by_role('button', name='编辑预设姿态', exact=False).click()
                editor = page.get_by_role('dialog', name='编辑预设姿态', exact=True)
                expect(manager).to_be_hidden()
                expect(editor.get_by_role('textbox', name='预设姿态名称')).to_have_value('准备姿态')
                expect(editor.get_by_role('spinbutton', name='left_J1 预设关节值')).to_have_value('-20')
                wait_for_preview(page, dict(left_J1=-20, right_J1=30, head_pitch_J=10, torso_lift=0.3))
                editor.get_by_role('button', name='弧度 rad', exact=True).click()
                editor.get_by_role('button', name='当前姿态', exact=True).click()
                wait_for_preview(page, robot_before)
                assert abs(float(editor.get_by_role('spinbutton', name='left_J1 预设关节值').input_value())
                           - math.radians(robot_before['left_J1'])) < 1e-9
                expect(editor.get_by_role('spinbutton', name='torso_lift 预设关节值')).to_have_value('0.2')
                editor.get_by_role('button', name='重置姿态', exact=True).click()
                wait_for_preview(page, {joint: 0 for joint in robot_before})
                assert editor.get_by_role('spinbutton').evaluate_all('(inputs) => inputs.every(input => Number(input.value) === 0)')
                expect(editor.get_by_role('textbox', name='预设姿态名称')).to_have_value('准备姿态')
                expect(editor.get_by_role('button', name='弧度 rad', exact=True)).to_have_attribute('aria-pressed', 'true')
                assert scene_values(page) == robot_before
                editor.get_by_role('button', name='角度 °', exact=True).click()
                editor.get_by_role('spinbutton', name='left_J1 预设关节值').fill('80')
                editor.get_by_role('spinbutton', name='torso_lift 预设关节值').fill('0.6')
                wait_for_preview(page, dict(left_J1=80, torso_lift=0.6))
                editor.get_by_role('textbox', name='预设姿态名称').fill('取消的修改')
                page.keyboard.press('Escape')
                expect(manager).to_be_visible()
                expect(row(manager, 'prepare').get_by_role('button', name='编辑预设姿态 准备姿态')).to_be_focused()
                assert saved_project(page, mode)['virtualTeaching']['jointPoses'] == original['virtualTeaching']['jointPoses']

                row(manager, 'prepare').get_by_role('button', name='编辑预设姿态', exact=False).click()
                editor.get_by_role('spinbutton', name='left_J1 预设关节值').fill('999')
                editor.get_by_role('button', name='保存姿态', exact=True).click()
                expect(editor.get_by_role('alert')).to_contain_text('请修正')
                editor.get_by_role('spinbutton', name='left_J1 预设关节值').fill('-40')
                editor.get_by_role('textbox', name='预设姿态名称').fill('准备姿态 · 已编辑')
                save_editor(page, manager)
                edited = next(pose for pose in saved_project(page, mode)['virtualTeaching']['jointPoses'] if pose['id'] == 'prepare')
                assert edited['joints']['values']['left_J1'] == -40
                assert edited['createdAt'] == '2026-01-01T00:00:00.000Z'
                assert scene_values(page) == robot_before

                item = row(manager, 'prepare')
                item.get_by_role('button', name='重命名预设姿态', exact=False).click()
                name = item.get_by_role('textbox', name='预设姿态新名称')
                expect(name).to_be_focused()
                name.fill('   ')
                expect(item.get_by_role('button', name='保存名称', exact=True)).to_be_disabled()
                name.fill('结束姿态')
                item.get_by_role('button', name='保存名称', exact=True).click()
                expect(manager.get_by_role('alert')).to_contain_text('同名姿态')
                name.fill('  工位 A · 预备  ')
                item.get_by_role('button', name='保存名称', exact=True).click()
                expect(name).to_have_count(0)
                expect(item.get_by_role('button', name='重命名预设姿态 工位 A · 预备', exact=True)).to_be_focused()

                row(manager, 'finish').get_by_role('button', name='编辑预设姿态', exact=False).click()
                expect(editor.get_by_role('spinbutton', name='left_J1 预设关节值')).to_have_value('25')
                expect(editor.get_by_role('spinbutton', name='torso_lift 预设关节值')).to_have_value('0.4')
                wait_for_preview(page, dict(left_J1=25, right_J1=-35, head_pitch_J=15, torso_lift=0.4))
                save_editor(page, manager)
                rename(manager, 'other', '工位 A · 预备')  # Same name is allowed for a different robot.

                manager.get_by_role('button', name='新建预设姿态', exact=True).click()
                new_editor = page.get_by_role('dialog', name='新建预设姿态', exact=True)
                new_editor.get_by_role('textbox', name='预设姿态名称').fill('检测姿态')
                new_editor.get_by_role('spinbutton', name='left_J1 预设关节值').fill('42')
                new_editor.get_by_role('button', name='保存姿态', exact=True).click()
                expect(new_editor).to_have_count(0)
                expect(manager.locator('li')).to_have_count(4)
                expect(manager.get_by_role('button', name='新建预设姿态', exact=True)).to_be_focused()
                manager.get_by_role('button', name='新建预设姿态', exact=True).click()
                new_editor.get_by_role('button', name='取消', exact=True).click()
                expect(manager.locator('li')).to_have_count(4)
                assert scene_values(page) == robot_before

                row(manager, 'finish').get_by_role('button', name='删除预设姿态', exact=False).click()
                page.keyboard.press('Escape')
                expect(row(manager, 'finish')).to_be_visible()
                expect(row(manager, 'finish').get_by_role('button', name='删除预设姿态 结束姿态')).to_be_focused()
                delete(manager, 'finish')
                delete(manager, 'other')
                expect(manager.locator('li')).to_have_count(2)
                page.screenshot(path=f'/tmp/atlas-preset-manager-{mode}.png', animations='disabled')
                page.set_viewport_size({'width': 390, 'height': 844})
                assert manager.evaluate('el => {const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && el.scrollWidth <= el.clientWidth;}')
                page.screenshot(path=f'/tmp/atlas-preset-manager-{mode}-mobile.png', animations='disabled')
                manager.get_by_role('button', name='完成', exact=True).focus()
                page.keyboard.press('Tab')
                expect(manager.get_by_role('button', name='关闭预设姿态管理', exact=True)).to_be_focused()
                page.set_viewport_size({'width': 1440, 'height': 1000})
                close_manager(manager)
                expect(page.get_by_role('button', name='机器人菜单', exact=True)).to_be_focused()
                expect(topbar_action(page, '应用预设姿态 工位 A · 预备', exact=True)).to_be_enabled()
                expect(topbar_action(page, '应用预设姿态 检测姿态', exact=True)).to_be_enabled()
                expect(page.get_by_role('button', name='应用预设姿态 结束姿态', exact=True, include_hidden=True)).to_have_count(0)
                topbar_action(page, '应用预设姿态 工位 A · 预备', exact=True).click()
                page.wait_for_function("JSON.parse(document.querySelector('.three-canvas').dataset.robotJointValues).left_J1 === -40")
                page.reload(wait_until='networkidle')
                wait_for_robot(page)
                manager = open_manager(page, 2)
                expect(row(manager, 'prepare')).to_contain_text('工位 A · 预备')
                current = saved_project(page, mode)
                assert current['virtualTeaching']['tasks'] == original['virtualTeaching']['tasks']
                assert current['virtualTeaching']['jointPoses'][0] == original['virtualTeaching']['jointPoses'][0]
                close_manager(manager)

                if mode == 'map':
                    with page.expect_download(timeout=120_000) as download:
                        start_project_download(page)
                    project = read_exported_project(download.value)
                    assert project['virtualTeaching']['jointPoses'] == current['virtualTeaching']['jointPoses']
                    archive_path = Path(temporary) / 'presets.zip'
                    download.value.save_as(str(archive_path))
                    restored = browser.new_context(viewport={'width': 1440, 'height': 1000})
                    target = restored.new_page()
                    target.on('pageerror', lambda error: errors.append(str(error)))
                    load_project(target, mode, archive_path)
                    imported_manager = open_manager(target, 2)
                    expect(imported_manager).to_contain_text('工位 A · 预备')
                    expect(imported_manager).to_contain_text('检测姿态')
                    imported_manager.get_by_role('button', name='编辑预设姿态 工位 A · 预备', exact=True).click()
                    expect(target.get_by_role('dialog', name='编辑预设姿态').get_by_role('spinbutton', name='left_J1 预设关节值')).to_have_value('-40')
                    wait_for_preview(target, dict(left_J1=-40, torso_lift=0.3))
                    restored.close()

                manager = open_manager(page, 2)
                for identity in manager.locator('li').evaluate_all('(items) => items.map(item => item.dataset.presetId)'):
                    delete(manager, identity)
                expect(manager).to_contain_text('暂无预设姿态')
                close_manager(manager)
                page.reload(wait_until='networkidle')
                wait_for_robot(page)
                manager = open_manager(page, 0)
                expect(manager.get_by_role('button', name='新建预设姿态', exact=True)).to_be_enabled()
                context.close()

            # The management entry also explains what to do before a robot is loaded.
            context = browser.new_context()
            page = context.new_page()
            page.goto(BASE_URL, wait_until='networkidle')
            wait_for_home(page)
            create_project(page, 'map')
            manager = open_manager(page, 0)
            expect(manager.get_by_role('button', name='新建预设姿态', exact=True)).to_be_disabled()
            expect(manager).to_contain_text('请先加载机器人')
            context.close()
            assert not errors, errors
        finally:
            browser.close()
    print('Preset management: CRUD, cancellation, names, units, focus, mobile layout, isolation, reload and ZIP restore passed')


if __name__ == '__main__':
    run()
