import json
import os
import tempfile
import zipfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from archive_helpers import start_project_download
from export_separation_ui_smoke import load_project, wait_ready
from project_save_target_ui_smoke import switch_mode
from robot_distance_warning_ui_smoke import CHROME, make_fixtures
from topbar_tools_helpers import topbar_action
from viewer_tools_helpers import viewer_tool


def open_settings(page):
    menu = page.get_by_role('dialog', name='3D 距离警告', exact=True)
    if not menu.count():
        page.get_by_role('button', name='碰撞保护距离', exact=True).click()
    toggle = menu.get_by_role('button', name='设置忽略关节', exact=True)
    if toggle.get_attribute('aria-expanded') != 'true':
        toggle.click()
    return menu


def assert_filtered(canvas, ignored, near, collision=''):
    expect(canvas).to_have_attribute('data-collision-ignored-joints', ','.join(sorted(ignored)))
    expect(canvas).to_have_attribute('data-collision-links', collision)
    expect(canvas).to_have_attribute('data-collision-near-links', near)


def check_group_selection(page, mode, archive):
    load_project(page, mode, archive)
    canvas = page.locator('.three-canvas')
    expect(canvas).to_have_attribute('data-collision-state', 'collision')
    menu = open_settings(page)
    expect(menu.get_by_text('勾选后，该关节直接连接的部件不参与碰撞与距离检测。', exact=True)).to_have_count(0)
    groups = [menu.get_by_role('checkbox', name=f'{label}全选', exact=True) for label in ('左臂', '右臂', '本体')]
    left_group, right_group, body_group = groups
    for group in groups:
        expect(group).to_be_visible()
        expect(group).not_to_be_checked()
    left = menu.get_by_role('checkbox', name='忽略 left_L1_mount', exact=True)
    right_group.check()
    expect(menu.get_by_role('checkbox', name='忽略 right_L1_mount', exact=True)).to_be_checked()
    left.check()
    expect(left_group).to_be_checked(indeterminate=True)
    expect(right_group).to_be_checked()
    expect(body_group).not_to_be_checked()

    # Selecting a whole arm includes joints hidden by the search and preserves other groups.
    search = menu.get_by_role('searchbox', name='搜索碰撞检测关节')
    search.fill('left_L1')
    expect(menu.locator('.collision-joint-settings__list').get_by_role('checkbox')).to_have_count(1)
    left_group.focus()
    page.keyboard.press('Space')
    expect(left_group).to_be_checked()
    assert not left_group.evaluate('(el) => el.indeterminate')
    assert_filtered(canvas, ['left_L1_mount', 'left_L2_mount', 'right_L1_mount'], 'torso_link')
    left_group.uncheck()
    assert_filtered(canvas, ['right_L1_mount'], 'torso_link', 'left_L1')
    search.fill('no-matching-joint')
    expect(menu.get_by_text('没有匹配的关节', exact=True)).to_be_visible()
    left_group.check()
    assert_filtered(canvas, ['left_L1_mount', 'left_L2_mount', 'right_L1_mount'], 'torso_link')
    search.fill('')
    expect(menu.get_by_role('checkbox', name='忽略 left_L2_mount', exact=True)).to_be_checked()
    left.uncheck()
    expect(left_group).to_be_checked(indeterminate=True)
    menu.screenshot(path=f'/tmp/atlas-ignored-joint-groups-{mode}.png')
    left_group.click()
    expect(left).to_be_checked()
    body_group.check()
    expect(canvas).to_have_attribute('data-collision-state', 'excluded')
    expect(canvas).to_have_attribute('data-collision-monitored-link-count', '0')
    for group in groups:
        expect(group).to_be_checked()
    menu.get_by_role('button', name='恢复全部关节检测').click()
    assert_filtered(canvas, [], 'right_L1,torso_link', 'left_L1')
    for group in groups:
        expect(group).not_to_be_checked()
        assert not group.evaluate('(el) => el.indeterminate')


def run():
    with tempfile.TemporaryDirectory(prefix='atlas-ignore-joints-') as temporary, sync_playwright() as p:
        directory = Path(temporary)
        for mode in ('map', 'independent'):
            (directory / mode).mkdir()
            make_fixtures(directory / mode, mode)
            (directory / mode / 'grouped').mkdir()
            make_fixtures(directory / mode / 'grouped', mode, extra_links=[['left_L2', 1.2]])
        executable = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or (str(CHROME) if CHROME.exists() else None)
        browser = p.chromium.launch(headless=True, executable_path=executable)
        errors = []
        try:
            for mode in ('map', 'independent'):
                context = browser.new_context(viewport={'width': 1440, 'height': 960})
                context.add_init_script('''(() => {
                  const NativeWorker = window.Worker;
                  window.__collisionIndexBuilds = 0;
                  window.Worker = class extends NativeWorker {
                    constructor(url, options) { super(url, options); this.collision = String(url).includes('robotCollision.worker'); }
                    postMessage(message, ...args) {
                      if (this.collision && message.type === 'init') window.__collisionIndexBuilds += 1;
                      return super.postMessage(message, ...args);
                    }
                  };
                })()''')
                page = context.new_page()
                page.set_default_timeout(30_000)
                page.on('pageerror', lambda error: errors.append(str(error)))
                load_project(page, mode, directory / mode / 'mixed.zip')
                canvas = page.locator('.three-canvas')
                warning = page.get_by_label('机器人距离警告', exact=True)
                expect(canvas).to_have_attribute('data-collision-state', 'collision')
                expect(warning.get_by_role('button')).to_have_count(0)
                menu = open_settings(page)
                expect(menu.get_by_role('checkbox')).to_have_count(6)
                left = menu.get_by_role('checkbox', name='忽略 left_L1_mount', exact=True)
                right = menu.get_by_role('checkbox', name='忽略 right_L1_mount', exact=True)
                body = menu.get_by_role('checkbox', name='忽略 torso_link_mount', exact=True)
                left.focus()
                page.keyboard.press('Space')
                expect(left).to_be_checked()
                expect(canvas).to_have_attribute('data-collision-state', 'near')
                assert_filtered(canvas, ['left_L1_mount'], 'right_L1,torso_link')
                assert abs(float(canvas.get_attribute('data-collision-minimum-distance')) - 0.05) < 0.001
                expect(warning.locator('[data-collision-side="left"]')).to_have_count(0)
                expect(warning.locator('[data-collision-side="right"]')).to_have_count(1)
                expect(canvas).to_have_attribute('data-collision-highlighted-links', 'right_L1,torso_link')
                expect(canvas).to_have_attribute('data-collision-monitored-link-count', '2')

                search = menu.get_by_role('searchbox', name='搜索碰撞检测关节')
                search.fill('right_L1')
                expect(menu.get_by_role('checkbox')).to_have_count(4)
                right.check()
                search.fill('')
                body.check()
                expect(canvas).to_have_attribute('data-collision-state', 'excluded')
                expect(canvas).to_have_attribute('data-collision-monitored-link-count', '0')
                expect(canvas).to_have_attribute('data-collision-minimum-distance', '')
                expect(canvas).to_have_attribute('data-collision-highlighted-links', '')
                expect(warning).to_have_count(0)
                expect(page.get_by_label('碰撞保护距离', exact=True)).to_have_text('已全部忽略')
                left.uncheck()
                expect(canvas).to_have_attribute('data-collision-state', 'collision')
                assert_filtered(canvas, ['right_L1_mount', 'torso_link_mount'], '', 'left_L1')
                menu.get_by_role('button', name='恢复全部关节检测').click()
                assert_filtered(canvas, [], 'right_L1,torso_link', 'left_L1')
                assert page.evaluate('window.__collisionIndexBuilds') == 1, 'Changing joints must reuse the environment index'

                # Hidden warnings do not suspend filtering or collision detection.
                menu.get_by_role('switch', name='显示距离警告').click()
                left.check()
                right.check()
                assert_filtered(canvas, ['left_L1_mount', 'right_L1_mount'], 'torso_link')
                expect(warning).to_have_count(0)
                menu.get_by_role('switch', name='显示距离警告').click()
                expect(warning).to_be_visible()
                page.screenshot(path=f'/tmp/atlas-ignored-joints-{mode}.png', full_page=True)
                menu.get_by_role('button', name='关闭距离警告').click()

                # Exclusions remain configurable while the detector is disabled.
                viewer_tool(page, name='关闭碰撞保护').click()
                expect(canvas).to_have_attribute('data-collision-state', 'disabled')
                expect(page.get_by_role('button', name='碰撞保护距离')).to_have_text('检测关闭')
                menu = open_settings(page)
                expect(menu.get_by_role('checkbox')).to_have_count(6)
                left.uncheck()
                menu.get_by_role('button', name='关闭距离警告').click()
                viewer_tool(page, name='开启碰撞保护').click()
                assert_filtered(canvas, ['right_L1_mount'], 'torso_link', 'left_L1')
                open_settings(page).get_by_role('checkbox', name='忽略 left_L1_mount', exact=True).check()
                assert_filtered(canvas, ['left_L1_mount', 'right_L1_mount'], 'torso_link')
                page.get_by_role('button', name='关闭距离警告').click()

                with page.expect_download() as download:
                    start_project_download(page)
                exported = directory / f'{mode}-ignored.zip'
                download.value.save_as(exported)
                with zipfile.ZipFile(exported) as archive:
                    payload = json.loads(archive.read('config/project.json'))
                    assert payload['robot']['collisionIgnoredJoints'] == ['left_L1_mount', 'right_L1_mount']
                page.wait_for_function('''async mode => {
                  const db = await new Promise(resolve => { const r = indexedDB.open('atlas-route-studio', 1); r.onsuccess = () => resolve(r.result); });
                  const record = await new Promise(resolve => { const r = db.transaction('workspace-session').objectStore('workspace-session').get(`workspace-config:${mode}`); r.onsuccess = () => resolve(r.result); });
                  db.close();
                  return record?.config?.project?.robot?.collisionIgnoredJoints?.length === 2;
                }''', arg=mode)
                page.reload(wait_until='networkidle')
                wait_ready(page)
                assert_filtered(canvas, ['left_L1_mount', 'right_L1_mount'], 'torso_link')

                other = 'independent' if mode == 'map' else 'map'
                load_project(page, other, directory / other / 'mixed.zip')
                assert_filtered(canvas, [], 'right_L1,torso_link', 'left_L1')
                switch_mode(page, mode)
                assert_filtered(canvas, ['left_L1_mount', 'right_L1_mount'], 'torso_link')

                # Portable project restoration and replacing a project with the same robot.
                fresh = browser.new_context()
                restored = fresh.new_page()
                restored.on('pageerror', lambda error: errors.append(str(error)))
                load_project(restored, mode, exported)
                assert_filtered(restored.locator('.three-canvas'), ['left_L1_mount', 'right_L1_mount'], 'torso_link')
                fresh.close()
                load_project(page, mode, directory / mode / 'mixed.zip')
                assert_filtered(canvas, [], 'right_L1,torso_link', 'left_L1')
                check_group_selection(page, mode, directory / mode / 'grouped' / 'mixed.zip')
                context.close()
                print(f'{mode}_joint_filter_groups_search_distance_highlights_reset_persistence_and_isolation=ok', flush=True)
            assert not errors, errors
        finally:
            browser.close()


if __name__ == '__main__':
    run()
