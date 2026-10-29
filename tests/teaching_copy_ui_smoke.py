"""Verify selection actions and clipboard payloads using isolated teaching workspaces."""
import json
import math
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from abx_teaching_export_ui_smoke import BASE_URL, CHROME, seed as seed_invalid
from teaching_preset_insertion_ui_smoke import seed, saved_project, wait_for_saved


ACTIONS = ['导出示教数据', '复制停车点', '复制姿态']
EXPECTED_JOINTS = {
    'head': [20, -15],
    'torso': [25, -50, 25, 0],
    'left_arm': [10, 30, -20, -30, 10, 10, -10],
    'right_arm': [-10, -30, 20, 30, -10, -10, 10],
}


def expect_action(page, name):
    toolbar = page.locator('.teaching-tree-toolbar')
    mode = page.locator('[data-page="teaching-data"]').get_attribute('data-teaching-space-mode')
    expect(toolbar.get_by_role('button', name='导入机器人示教', exact=True)).to_have_count(
        int(mode == 'map' and name == '导出示教数据'))
    for action in ACTIONS:
        expect(toolbar.get_by_role('button', name=action, exact=True)).to_have_count(int(action == name))
    if name:
        expect(toolbar.get_by_role('button', name=name, exact=True)).to_be_enabled()
    assert toolbar.evaluate('node => node.scrollWidth <= node.clientWidth'), 'toolbar must fit'
    return toolbar.get_by_role('button', name=name, exact=True) if name else None


def copied_json(page):
    return json.loads(page.evaluate('() => navigator.clipboard.readText()'))


def expect_preset(data):
    assert list(data) == ['unit', 'joints']
    assert data['unit'] == 'deg'
    assert list(data['joints']) == list(EXPECTED_JOINTS)
    for group, expected in EXPECTED_JOINTS.items():
        assert len(data['joints'][group]) == len(expected)
        for actual, value in zip(data['joints'][group], expected):
            assert math.isclose(actual, value, abs_tol=1e-12)


def run():
    errors = []
    with tempfile.TemporaryDirectory(prefix='atlas-copy-ui-') as directory, sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            for mode in ['map', 'independent']:
                context = browser.new_context(viewport=dict(width=1440, height=1000),
                                              permissions=['clipboard-read', 'clipboard-write'],
                                              accept_downloads=True)
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                seed(page, mode)
                before = wait_for_saved(page, lambda project:
                                        project['virtualTeaching']['jointPoses'][0]['joints'].get('count') == 20, mode)
                task = page.get_by_role('button', name='选择示教任务 装配任务：中文校验', exact=True)
                parking = page.get_by_role('button', name='选择停车点 停车点 A', exact=True)
                pose = page.get_by_role('button', name='查看机械臂姿态 姿态 a1', exact=True)
                assert page.get_by_role('button', name='导出示教数据', exact=True).count() == 0
                expect(page.get_by_role('button', name='导入机器人示教', exact=True)).to_have_count(0)
                task.click()
                export = expect_action(page, '导出示教数据')
                if mode == 'map':
                    export.click()
                    dialog = page.get_by_role('dialog', name='导出机器人示教', exact=True)
                    expect(dialog.get_by_role('button', name='下载机器人导入包', exact=True)).to_be_enabled()
                    page.keyboard.press('Escape')
                else:
                    with page.expect_download() as pending:
                        export.click()
                    output = Path(directory) / 'teaching.json'
                    pending.value.save_as(output)
                    assert json.loads(output.read_text())['statistics']['taskCount'] == 2
                parking.click()
                expect_action(page, '复制停车点').click()
                expect(page.get_by_role('status').filter(has_text='停车点「停车点 A」已复制到剪贴板')).to_be_visible()
                copied = copied_json(page)
                assert copied['format'] == 'atlas-route-studio-parking-point'
                assert copied['coordinateSystem']['frameId'] == ('map' if mode == 'map' else 'virtual_origin')
                source = before['virtualTeaching']['tasks'][0]['parkingPoints'][0]
                assert copied['parkingPoint']['mapPose'] == source['mapPose']
                assert [point['name'] for point in copied['parkingPoint']['poses']] == ['姿态 a1', '姿态 a2']
                assert copied['parkingPoint']['poses'][0]['fullBodyJoints']['values'] == source['poses'][0]['fullBodyJoints']['values']
                assert 'cameraCapture' not in json.dumps(copied)
                pose.click()
                expect_action(page, '复制姿态').click()
                expect(page.get_by_role('status').filter(has_text='姿态「姿态 a1」已复制到剪贴板')).to_be_visible()
                expect_preset(copied_json(page))
                # Verify the actual clipboard can pass back through the existing preset importer.
                restored = page.evaluate("""async () => {
                  const { readRobotPresetFile } = await import('/src/features/robot/model/robotJointPresets.js');
                  const { ABX_JOINT_NAMES } = await import('/src/features/teaching/model/abxFormat.js');
                  const definitions = Object.values(ABX_JOINT_NAMES).flat().reverse()
                    .map(name => ({ name, type: 'revolute', lower: -180, upper: 180 }));
                  return readRobotPresetFile(await navigator.clipboard.readText(), definitions, 'copied.json');
                }""")
                assert len(restored['values']) == 20 and restored['values']['head_yaw_J'] == 20
                page.get_by_role('button', name='选择停车点 停车点 B', exact=True).click()
                page.get_by_role('button', name='查看机械臂姿态 姿态 b1', exact=True).click()
                expect_action(page, '复制姿态').click()
                expect(page.get_by_role('status').filter(has_text='姿态「姿态 b1」已复制到剪贴板')).to_be_visible()
                expect_preset(copied_json(page))
                page.set_viewport_size(dict(width=1180, height=720))
                expect_action(page, '复制姿态')
                page.locator('.teaching-tree-toolbar').screenshot(path=f'/tmp/atlas-copy-{mode}-toolbar.png')
                after = saved_project(page, mode)
                assert after['virtualTeaching']['tasks'] == before['virtualTeaching']['tasks']
                assert after['waypoints'] == before['waypoints']
                assert after['virtualTeaching']['jointPoses'] == before['virtualTeaching']['jointPoses']

                if mode == 'map':
                    # Exercise the HTTP fallback with a real browser copy operation.
                    page.evaluate("""() => {
                      window.testClipboard = navigator.clipboard;
                      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
                    }""")
                    parking.click()
                    pose.click()
                    expect_action(page, '复制姿态').click()
                    expect(page.get_by_role('status').filter(has_text='姿态「姿态 a1」已复制到剪贴板')).to_be_visible()
                    page.evaluate("Object.defineProperty(navigator, 'clipboard', { configurable: true, value: window.testClipboard })")
                    expect_preset(copied_json(page))
                    # Denial must report failure and leave the previous clipboard intact.
                    previous = page.evaluate('navigator.clipboard.readText()')
                    page.evaluate("""() => {
                      window.testExecCommand = document.execCommand;
                      navigator.clipboard.writeText = async () => { throw new Error('denied'); };
                      document.execCommand = () => false;
                    }""")
                    expect_action(page, '复制姿态').click()
                    expect(page.get_by_role('status').filter(has_text='复制姿态失败')).to_be_visible()
                    assert page.evaluate('navigator.clipboard.readText()') == previous
                    expect(page.locator('textarea[aria-hidden="true"]')).to_have_count(0)
                    page.evaluate('() => { document.execCommand = window.testExecCommand; }')
                context.close()

            context = browser.new_context(viewport=dict(width=1440, height=1000),
                                          permissions=['clipboard-read', 'clipboard-write'])
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            seed_invalid(page, invalid=True)
            page.evaluate("navigator.clipboard.writeText('preserve existing clipboard')")
            page.get_by_role('button', name='选择停车点 停车点 A', exact=True).click()
            page.get_by_role('button', name='查看机械臂姿态 姿态 a1', exact=True).click()
            expect_action(page, '复制姿态').click()
            expect(page.get_by_role('status').filter(has_text='复制姿态失败')).to_contain_text('head_yaw_J')
            assert page.evaluate('navigator.clipboard.readText()') == 'preserve existing clipboard'
            page.evaluate("""async () => {
              const store = await import('/src/features/workspace/model/sessionStore.js');
              const { sessionId } = await store.fetchServiceSession();
              const saved = await store.loadWorkspaceConfig(sessionId, 'map');
              saved.config.project.virtualTeaching.tasks = [];
              await store.saveWorkspaceConfig(sessionId, saved.mapId, saved.config, 'map');
            }""")
            page.reload(wait_until='networkidle')
            page.locator('.loading-curtain').wait_for(state='hidden')
            expect(page.locator('[data-page="teaching-data"]')).to_have_attribute('data-teaching-task-count', '0')
            expect_action(page, None)
            context.close()
            assert not errors, errors
        finally:
            browser.close()
    print('Teaching clipboard UI: selection, preset round-trip, rad/deg, parking, both modes, fallback, denial and invalid/empty data passed')


if __name__ == '__main__':
    run()
