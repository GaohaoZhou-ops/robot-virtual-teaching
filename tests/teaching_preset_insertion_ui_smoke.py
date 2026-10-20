"""Insert saved robot poses around a tree selection in isolated workspaces."""
import json
from pathlib import Path
import tempfile
import time
import zipfile

from playwright.sync_api import expect, sync_playwright
from abx_teaching_export_ui_smoke import BASE_URL, CHROME


def seed(page, mode='map', empty=False):
    page.goto(BASE_URL, wait_until='networkidle')
    page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
    page.evaluate("""async ({mode, empty}) => {
      const { teachingTransferFixture } = await import('/tests/teaching_transfer_helpers.mjs');
      const { abxTeachingFixture } = await import('/tests/abx_teaching_helpers.mjs');
      const store = await import('/src/lib/sessionStore.js');
      const { sessionId } = await store.fetchServiceSession();
      const fixture = teachingTransferFixture(mode);
      const { payload, robotPackage, values } = abxTeachingFixture();
      const frame = mode === 'map' ? 'map' : 'virtual_origin';
      payload.workspace.teachingSpaceMode = mode; payload.teachingSpace.mode = mode;
      payload.coordinateSystem.frameId = frame; payload.teachingSpace.frameId = frame;
      for (const task of payload.virtualTeaching.tasks) {
        task.coordinateFrame = frame;
        task.parkingPoints.sort((a, b) => a.sequence - b.sequence);
        for (const parking of task.parkingPoints) {
          parking.mapPose.frameId = frame;
          parking.poses.sort((a, b) => a.sequence - b.sequence);
        }
      }
      payload.virtualTeaching.jointPoses = empty ? [] : [
        { id: 'prepare', name: '巡检准备姿态', offset: 5, robot: payload.robot },
        { id: 'finish', name: '巡检结束姿态', offset: -5, robot: payload.robot },
        { id: 'different', name: '其他机器人预设', offset: 10, robot: { id: 'other' } },
      ].map(preset => ({ id: preset.id, name: preset.name, robot: preset.robot,
        joints: { source: 'robot-preset', angularUnit: 'degree', linearUnit: 'meter',
          values: Object.fromEntries(Object.entries(values).filter(([name]) => !name.startsWith('wheel_'))
            .map(([name, value]) => [name, value + preset.offset])) } }));
      fixture.map.name = payload.map.fileName; fixture.map.sourceHash = payload.map.sourceHash;
      fixture.map.portableRobotPackage = robotPackage;
      fixture.config.config.project = payload; fixture.config.config.ui.selectedRobot = payload.robot;
      await store.saveWorkspaceMap(sessionId, fixture.map.mapId, fixture.map.name, fixture.map, mode);
      await store.saveWorkspaceConfig(sessionId, fixture.map.mapId, fixture.config.config, mode);
      await store.activateWorkspaceMode(sessionId, mode);
    }""", dict(mode=mode, empty=empty))
    page.goto(BASE_URL + '/teaching-data', wait_until='networkidle')
    page.locator('.loading-curtain').wait_for(state='hidden')
    expect(page.get_by_role('button', name='导出示教数据', exact=True)).to_be_visible()


def saved_project(page, mode='map'):
    return page.evaluate("""async mode => {
      const store = await import('/src/lib/sessionStore.js');
      const saved = await store.loadWorkspaceConfig((await store.fetchServiceSession()).sessionId, mode);
      return saved.config.project;
    }""", mode)


def wait_for_saved(page, predicate, mode='map'):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        project = saved_project(page, mode)
        if project and predicate(project):
            return project
        time.sleep(0.1)
    raise AssertionError('Expected workspace changes were not saved')


def run():
    errors = []
    with tempfile.TemporaryDirectory(prefix='atlas-insert-action-') as directory, sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            page = browser.new_page(viewport=dict(width=1440, height=1000), accept_downloads=True)
            page.on('pageerror', lambda error: errors.append(str(error)))
            seed(page)
            original = wait_for_saved(page, lambda project:
                                      project['virtualTeaching']['jointPoses'][0]['joints'].get('count') == 20)
            insert = page.get_by_role('button', name='插入动作', exact=True)
            toolbar = page.locator('.teaching-tree-toolbar')
            up = toolbar.get_by_role('button', name='上移', exact=True)
            down = toolbar.get_by_role('button', name='下移', exact=True)
            task = page.get_by_role('button', name='选择示教任务 装配任务：中文校验', exact=True)
            parking = page.get_by_role('button', name='选择停车点 停车点 A', exact=True)
            parking_branch = page.locator('.teaching-tree-branch--parking').filter(has=parking)
            anchor = page.get_by_role('button', name='查看机械臂姿态 姿态 a1', exact=True)
            task.click()
            expect(insert).to_have_count(0)
            expect(up).to_have_count(0)
            expect(down).to_have_count(0)
            parking.click()
            expect(insert).to_have_count(0)
            expect(up).to_have_count(0)
            expect(down).to_have_count(0)
            anchor.click()
            expect(insert).to_be_visible()
            expect(up).to_be_disabled()
            expect(down).to_be_enabled()
            assert insert.bounding_box()['x'] < page.get_by_role('button', name='继续示教', exact=True).bounding_box()['x']
            assert insert.bounding_box()['x'] < up.bounding_box()['x'] < down.bounding_box()['x']
            assert insert.bounding_box()['y'] == up.bounding_box()['y'] == down.bounding_box()['y']
            assert toolbar.evaluate('node => node.scrollWidth <= node.clientWidth'), 'toolbar controls must fit'
            assert insert.evaluate("node => getComputedStyle(node).backgroundColor") == 'rgb(231, 185, 75)'
            page.screenshot(path='/tmp/atlas-insert-action-toolbar.png', full_page=True)
            insert.click()
            dialog = page.get_by_role('dialog', name='插入动作', exact=True)
            expect(dialog.get_by_label('预设动作', exact=True)).to_have_value('prepare')
            assert dialog.locator('option').all_text_contents() == ['巡检准备姿态', '巡检结束姿态']
            expect(dialog.get_by_role('radio', name='之后', exact=True)).to_be_checked()
            page.keyboard.press('Escape')
            expect(dialog).to_have_count(0)
            expect(insert).to_be_focused()
            assert parking_branch.locator('.teaching-point-row').count() == 2

            insert.click()
            dialog.get_by_role('radio', name='之前', exact=True).check()
            expect(dialog.get_by_label('插入顺序预览')).to_contain_text('巡检准备姿态')
            page.screenshot(path='/tmp/atlas-insert-action-dialog.png', full_page=True)
            dialog.get_by_role('button', name='确认插入', exact=True).click()
            expect(dialog).to_have_count(0)
            expect(page.get_by_label('机械臂姿态名称', exact=True)).to_have_value('巡检准备姿态')
            assert parking_branch.locator('.teaching-point-row .teaching-tree-label > span').all_text_contents() == [
                '巡检准备姿态', '姿态 a1', '姿态 a2']
            anchor.click()
            insert.click()
            dialog.get_by_label('预设动作', exact=True).select_option('finish')
            dialog.get_by_role('button', name='确认插入', exact=True).click()
            expect(page.get_by_label('机械臂姿态名称', exact=True)).to_have_value('巡检结束姿态')
            expected_names = ['巡检准备姿态', '姿态 a1', '巡检结束姿态', '姿态 a2']
            assert parking_branch.locator('.teaching-point-row .teaching-tree-label > span').all_text_contents() == expected_names
            up.click()
            up.click()
            expect(up).to_be_disabled()
            expect(page.get_by_label('机械臂姿态名称', exact=True)).to_have_value('巡检结束姿态')
            assert parking_branch.locator('.teaching-point-row .teaching-tree-label > span').all_text_contents() == [
                '巡检结束姿态', '巡检准备姿态', '姿态 a1', '姿态 a2']
            down.click()
            down.click()
            down.click()
            expect(down).to_be_disabled()
            expect(up).to_be_enabled()
            expect(page.get_by_label('机械臂姿态名称', exact=True)).to_have_value('巡检结束姿态')
            expected_names = ['巡检准备姿态', '姿态 a1', '姿态 a2', '巡检结束姿态']
            assert parking_branch.locator('.teaching-point-row .teaching-tree-label > span').all_text_contents() == expected_names
            saved = wait_for_saved(page, lambda project:
                                   [pose['name'] for pose in project['virtualTeaching']['tasks'][0]['parkingPoints'][0]['poses']]
                                   == expected_names)
            poses = saved['virtualTeaching']['tasks'][0]['parkingPoints'][0]['poses']
            assert poses[0]['mapPose'] == poses[1]['mapPose'] == poses[3]['mapPose']
            assert poses[0]['fullBodyJoints']['values']['head_yaw_J'] == 25
            assert poses[3]['fullBodyJoints']['values']['head_yaw_J'] == 15
            assert saved['virtualTeaching']['jointPoses'] == original['virtualTeaching']['jointPoses']
            assert saved['waypoints'] == original['waypoints']
            page.reload(wait_until='networkidle')
            page.locator('.loading-curtain').wait_for(state='hidden')
            assert parking_branch.locator('.teaching-point-row .teaching-tree-label > span').all_text_contents() == expected_names
            page.get_by_role('button', name='导出示教数据', exact=True).click()
            export = page.get_by_role('dialog', name='导出机器人示教', exact=True)
            with page.expect_download() as pending:
                export.get_by_role('button', name='下载机器人导入包', exact=True).click()
            output = Path(directory) / 'inserted.zip'
            pending.value.save_as(output)
            with zipfile.ZipFile(output) as bundle:
                manifest = json.loads(bundle.read('manifest.json'))
                rows = [json.loads(line) for line in bundle.read(manifest['tasks'][0]['file']).splitlines()]
                assert [row['label'] for row in rows if row.get('record', {}).get('joints_rad')] == expected_names + ['姿态 b1']
                assert len([row for row in rows if row.get('record', {}).get('type') == 'route_navigation']) == 2
            page.close()

            for empty in [False, True]:
                independent = browser.new_page(viewport=dict(width=1180, height=850))
                independent.on('pageerror', lambda error: errors.append(str(error)))
                seed(independent, 'independent', empty)
                independent.get_by_role('button', name='查看机械臂姿态 姿态 a1', exact=True).click()
                independent.get_by_role('button', name='插入动作', exact=True).click()
                dialog = independent.get_by_role('dialog', name='插入动作', exact=True)
                if empty:
                    expect(dialog.get_by_role('button', name='确认插入', exact=True)).to_be_disabled()
                    expect(dialog).to_contain_text('暂无匹配的预设姿态')
                    dialog.get_by_role('button', name='取消', exact=True).click()
                else:
                    dialog.get_by_role('button', name='确认插入', exact=True).click()
                    expect(independent.get_by_label('机械臂姿态名称', exact=True)).to_have_value('巡检准备姿态')
                    independent_parking = independent.locator('.teaching-tree-branch--parking').filter(
                        has=independent.get_by_role('button', name='选择停车点 停车点 A', exact=True))
                    assert independent_parking.locator('.teaching-point-row .teaching-tree-label > span').all_text_contents() == [
                        '姿态 a1', '巡检准备姿态', '姿态 a2']
                    independent.locator('.teaching-tree-toolbar').get_by_role('button', name='上移', exact=True).click()
                    expect(independent.get_by_label('机械臂姿态名称', exact=True)).to_have_value('巡检准备姿态')
                    assert independent_parking.locator('.teaching-point-row .teaching-tree-label > span').all_text_contents() == [
                        '巡检准备姿态', '姿态 a1', '姿态 a2']
                independent.close()
            assert not errors, errors
        finally:
            browser.close()
    print('Teaching actions UI: insertion, up/down, boundaries, selection, reload, ZIP and independent mode passed')


if __name__ == '__main__':
    run()
