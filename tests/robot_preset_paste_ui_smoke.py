"""Paste real robot joint JSON without changing the workspace until explicitly applied."""
import json
import math
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from dual_teaching_workspace_smoke import BASE_URL, create_project, wait_for_home
from robot_presets_ui_smoke import SAMPLE_NAMES, preview_values, scene_values, wait_for_preview, wait_for_robot
from teaching_preset_insertion_ui_smoke import wait_for_saved
from topbar_tools_helpers import topbar_action


SAMPLE = {
    'unit': 'deg',
    'joints': {
        'head': [0.24375915527344683, 2.8955841064452947],
        'torso': [47.22061157086062, -99.250488278297, 53.2260131820101, -0.05218505859223995],
        'left_arm': [40.52430723962643, -5.0301704392649595, -2.6594741820497787,
                     120.54498595832747, 86.25059966784394, -0.9778518676466826, 0.7684936523208733],
        'right_arm': [-37.09485625181744, 6.895259855246482, 3.175639343167233,
                      -117.904133602449, -83.26658935299129, 1.8560714721127305, -1.3564544677330745],
    },
}
VALUES = {name: SAMPLE['joints'][group][index]
          for group, names in SAMPLE_NAMES.items() for index, name in enumerate(names)}


def run():
    errors = []
    output = Path('test-artifacts/robot-preset-paste')
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        try:
            for mode in ('map', 'independent'):
                context = browser.new_context(viewport={'width': 1440, 'height': 1000},
                                              permissions=['clipboard-read', 'clipboard-write'])
                page = context.new_page()
                page.set_default_timeout(30_000)
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(BASE_URL, wait_until='networkidle')
                wait_for_home(page)
                create_project(page, mode)
                topbar_action(page, '加载机器人', exact=True).click()
                page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70', exact=True).click()
                wait_for_robot(page)
                before = scene_values(page)
                topbar_action(page, '新建预设姿态', exact=True).click()
                dialog = page.get_by_role('dialog', name='新建预设姿态', exact=True)
                name = f'{mode} 剪贴板姿态'
                dialog.get_by_role('textbox', name='预设姿态名称').fill(name)
                wait_for_preview(page, before)
                initial_preview = preview_values(page)
                initial_fields = dialog.get_by_role('spinbutton').evaluate_all('(inputs) => inputs.map(input => input.value)')
                toggle = dialog.get_by_role('button', name='粘贴关节值', exact=True)
                toggle.click()
                text = dialog.get_by_role('textbox', name='关节值 JSON', exact=True)
                parse = dialog.get_by_role('button', name='解析关节值', exact=True)
                expect(text).to_be_focused()
                expect(dialog.get_by_role('spinbutton')).to_have_count(0)
                expect(parse).to_be_disabled()
                expect(dialog.get_by_role('button', name='保存姿态', exact=True)).to_be_disabled()
                expect(dialog.get_by_role('button', name='保存并应用', exact=True)).to_be_disabled()
                expect(dialog.get_by_role('button', name='弧度 rad', exact=True)).to_be_disabled()

                invalid_groups = json.loads(json.dumps(SAMPLE))
                invalid_groups['joints']['head'] = [0]
                invalid_limit = json.loads(json.dumps(SAMPLE))
                invalid_limit['joints']['left_arm'][0] = 999
                for raw, message in [('{invalid json', 'JSON'), (json.dumps(invalid_groups), 'head 必须包含 2'),
                                     (json.dumps(invalid_limit), '限位')]:
                    text.fill(raw)
                    parse.click()
                    expect(dialog.get_by_role('alert')).to_contain_text(message)
                    expect(text).to_have_value(raw)
                    expect(text).to_be_focused()
                    assert preview_values(page) == initial_preview
                    assert scene_values(page) == before
                dialog.get_by_role('button', name='返回关节表单', exact=True).click()
                expect(toggle).to_be_focused()
                assert dialog.get_by_role('spinbutton').evaluate_all('(inputs) => inputs.map(input => input.value)') == initial_fields
                expect(dialog.get_by_role('textbox', name='预设姿态名称')).to_have_value(name)

                toggle.click()
                raw = json.dumps(SAMPLE, indent=2)
                # Headless Chromium's clipboard exercises native paste, including the modal's key handling.
                page.evaluate('(text) => navigator.clipboard.writeText(text)', raw)
                text.select_text()
                text.press('Meta+V')
                expect(text).to_have_value(raw)
                expect(dialog.get_by_role('alert')).to_have_count(0)
                text.press('Tab')
                expect(dialog.get_by_role('button', name='返回关节表单', exact=True)).to_be_focused()
                page.keyboard.press('Shift+Tab')
                expect(text).to_be_focused()
                page.screenshot(path=str(output / f'{mode}-paste.png'), full_page=True)
                page.set_viewport_size({'width': 390, 'height': 844})
                text.scroll_into_view_if_needed()
                assert dialog.evaluate('el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth')
                assert text.evaluate('el => el.getBoundingClientRect().right <= innerWidth')
                page.screenshot(path=str(output / f'{mode}-paste-mobile.png'), full_page=True)
                page.set_viewport_size({'width': 1440, 'height': 1000})
                parse.click()
                expect(text).to_have_count(0)
                expect(toggle).to_be_focused()
                expect(dialog.get_by_role('spinbutton')).to_have_count(20)
                expect(dialog.get_by_role('textbox', name='预设姿态名称')).to_have_value(name)
                for joint, value in VALUES.items():
                    assert abs(float(dialog.get_by_role('spinbutton', name=f'{joint} 预设关节值', exact=True).input_value()) - value) < 1e-8
                wait_for_preview(page, VALUES)
                assert scene_values(page) == before
                page.screenshot(path=str(output / f'{mode}-parsed.png'), full_page=True)

                toggle.click()
                expect(text).to_have_value('')
                radians = {'unit': 'rad', 'joints': {group: [math.radians(value) for value in values]
                                                    for group, values in SAMPLE['joints'].items()}}
                text.fill(json.dumps(radians))
                parse.click()
                expect(dialog.get_by_role('button', name='弧度 rad', exact=True)).to_have_attribute('aria-pressed', 'true')
                assert abs(float(dialog.get_by_role('spinbutton', name='left_J1 预设关节值', exact=True).input_value())
                           - radians['joints']['left_arm'][0]) < 1e-9
                wait_for_preview(page, VALUES)
                dialog.get_by_role('button', name='保存姿态', exact=True).click()
                expect(dialog).to_have_count(0)
                assert scene_values(page) == before
                saved = wait_for_saved(page, lambda project: any(pose['name'] == name
                                       for pose in project['virtualTeaching']['jointPoses']), mode)
                pose = next(pose for pose in saved['virtualTeaching']['jointPoses'] if pose['name'] == name)
                assert all(abs(pose['joints']['values'][joint] - value) < 1e-8 for joint, value in VALUES.items())
                page.reload(wait_until='networkidle')
                wait_for_robot(page)
                topbar_action(page, f'应用预设姿态 {name}', exact=True).click()
                page.wait_for_function('''expected => {
                  const values = JSON.parse(document.querySelector('.three-canvas').dataset.robotJointValues);
                  return Object.entries(expected).every(([joint, value]) => Math.abs(values[joint] - value) < 1e-6);
                }''', arg=VALUES)
                context.close()
                print(f'{mode}: native paste, invalid input isolation, 20-joint mapping, deg/rad, focus, mobile layout and saved pose reload passed', flush=True)
            assert not errors, errors
        finally:
            browser.close()


if __name__ == '__main__':
    run()
