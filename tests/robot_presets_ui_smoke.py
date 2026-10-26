import json
import math
import os
import re
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from dual_teaching_workspace_smoke import BASE_URL, create_project, wait_for_home
from topbar_tools_helpers import topbar_action
from teaching_preset_insertion_ui_smoke import wait_for_saved


SAMPLE_PATH = Path(__file__).resolve().parent / 'fixtures' / 'sample-pre-teaching-pose.json'
SAMPLE = json.loads(SAMPLE_PATH.read_text())
SAMPLE_NAMES = {
    'head': ['head_yaw_J', 'head_pitch_J'],
    'torso': ['ankle_pitch_J', 'knee_pitch_J', 'waist_pitch_J', 'waist_yaw_J'],
    'left_arm': [f'left_J{index}' for index in range(1, 8)],
    'right_arm': [f'right_J{index}' for index in range(1, 8)],
}
SAMPLE_VALUES = {name: SAMPLE['joints'][group][index]
                 for group, names in SAMPLE_NAMES.items() for index, name in enumerate(names)}


def import_file(page, file):
    dialog = page.get_by_role('dialog', name='新建预设姿态', exact=True)
    if not dialog.is_visible():
        topbar_action(page, '新建预设姿态', exact=True).click()
    with page.expect_file_chooser() as chooser:
        dialog.get_by_role('button', name='导入预设姿态', exact=True).click()
    chooser.value.set_files(file)
    expect(dialog).to_have_attribute('aria-busy', 'false')


def scene_values(page):
    return json.loads(page.locator('.three-canvas').get_attribute('data-robot-joint-values') or '{}')


def preview_values(page):
    return json.loads(page.locator('.robot-preset-dialog .teaching-pose-robot-canvas')
                      .get_attribute('data-applied-joint-values') or '{}')


def wait_for_preview(page, expected):
    expect(page.get_by_label('预设姿态三维预览', exact=True)).to_have_attribute(
        'data-preview-state', 'ready', timeout=180_000)
    page.wait_for_function('''expected => {
        const canvas = document.querySelector('.robot-preset-dialog .teaching-pose-robot-canvas');
        const values = JSON.parse(canvas?.dataset.appliedJointValues || '{}');
        return Object.entries(expected).every(([name, value]) => Math.abs(values[name] - value) < 1e-6);
    }''', arg=expected)


def wait_for_robot(page):
    page.wait_for_function(
        "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
        timeout=180_000,
    )


def run():
    errors = []
    chrome = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    executable = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or (str(chrome) if chrome.exists() else None)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=executable)
        for mode in ('map', 'independent'):
            context = browser.new_context(viewport={'width': 1440, 'height': 1000})
            page = context.new_page()
            page.set_default_timeout(30_000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            model_requests = []
            page.on('request', lambda request: model_requests.append(request.url)
                    if '/__atlas/robot-files/' in request.url else None)
            page.goto(BASE_URL, wait_until='networkidle')
            wait_for_home(page)
            create_project(page, mode)
            expect(topbar_action(page, '新建预设姿态', exact=True)).to_be_disabled()
            expect(page.get_by_role('button', name='导入预设姿态', exact=True, include_hidden=True)).to_have_count(0)
            topbar_action(page, '加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70', exact=True).click()
            wait_for_robot(page)
            before = scene_values(page)
            canvas = page.locator('.three-canvas')
            base_pose = {key: canvas.get_attribute(f'data-robot-{key}') for key in ('x', 'y', 'z', 'yaw')}

            topbar_action(page, '新建预设姿态', exact=True).click()
            dialog = page.get_by_role('dialog', name='新建预设姿态', exact=True)
            expect(dialog).to_be_visible()
            expect(dialog.get_by_role('textbox', name='预设姿态名称')).to_be_focused()
            wait_for_preview(page, before)
            preview_box = page.get_by_label('预设姿态三维预览', exact=True).bounding_box()
            editor_box = dialog.locator('.robot-preset-dialog__editor').bounding_box()
            assert preview_box['x'] + preview_box['width'] <= editor_box['x']
            loaded_requests = len(model_requests)
            expect(dialog.get_by_role('button', name='导入预设姿态', exact=True)).to_be_enabled()
            assert dialog.locator('.robot-preset-dialog__pose-actions button').all_text_contents() == [
                '重置姿态', '当前姿态', '导入预设姿态', '粘贴关节值']
            expect(dialog.locator('input[type="file"]')).to_be_hidden()
            expect(dialog.get_by_role('spinbutton')).to_have_count(20)
            assert dialog.locator('[data-preset-group]').evaluate_all(
                '(items) => items.map(item => item.dataset.presetGroup)'
            ) == ['left', 'right', 'body', 'head']
            assert dialog.get_by_role('spinbutton', name='wheel_LF_J 预设关节值').count() == 0
            save_and_apply = dialog.get_by_role('button', name='保存并应用', exact=True)
            expect(save_and_apply).to_be_enabled()
            assert save_and_apply.evaluate('el => el.previousElementSibling.textContent') == '保存姿态'
            assert save_and_apply.evaluate('el => getComputedStyle(el).color') == 'rgb(244, 201, 93)'
            save_and_apply.click()
            expect(dialog.get_by_role('alert')).to_contain_text('请输入预设姿态名称')
            name = f'{mode} 准备姿态'
            dialog.get_by_role('textbox', name='预设姿态名称').fill(name)
            left = dialog.get_by_role('spinbutton', name='left_J1 预设关节值', exact=True)
            left.fill('')
            dialog.get_by_role('button', name='保存姿态', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('请修正')
            expect(left).to_have_attribute('aria-invalid', 'true')
            expect(dialog.locator('.robot-preset-dialog__preview > p')).to_contain_text('上次有效的位置')
            assert abs(preview_values(page)['left_J1'] - before['left_J1']) < 1e-6
            left.fill('999')
            save_and_apply.click()
            expect(dialog).to_contain_text(re.compile(r'超出关节(?:软)?限位'))
            assert abs(preview_values(page)['left_J1'] - before['left_J1']) < 1e-6
            assert scene_values(page) == before, 'invalid save-and-apply must not move the robot'
            dialog.get_by_role('button', name='重置姿态', exact=True).click()
            expect(dialog.get_by_role('alert')).to_have_count(0)
            expect(dialog.locator('input[aria-invalid="true"]')).to_have_count(0)
            assert dialog.get_by_role('spinbutton').evaluate_all('(inputs) => inputs.every(input => Number(input.value) === 0)')
            wait_for_preview(page, {joint: 0 for joint in SAMPLE_VALUES})
            dialog.get_by_role('button', name='当前姿态', exact=True).click()
            wait_for_preview(page, before)

            expected = dict(left_J1=-20, right_J1=35, ankle_pitch_J=10, knee_pitch_J=-15,
                            waist_pitch_J=10, waist_yaw_J=20, head_yaw_J=12, head_pitch_J=-10)
            for joint, value in expected.items():
                dialog.get_by_role('spinbutton', name=f'{joint} 预设关节值', exact=True).fill(str(value))
            dialog.get_by_role('button', name='弧度 rad', exact=True).click()
            assert abs(float(left.input_value()) - math.radians(-20)) < 1e-9
            dialog.get_by_role('spinbutton', name='right_J1 预设关节值', exact=True).fill(str(math.pi / 6))
            expected['right_J1'] = 30
            for _ in range(3):
                dialog.get_by_role('button', name='角度 °', exact=True).click()
                assert abs(float(left.input_value()) + 20) < 1e-8
                dialog.get_by_role('button', name='弧度 rad', exact=True).click()
            assert scene_values(page) == before, 'editing a preset must not move the robot'
            wait_for_preview(page, expected)
            assert len(model_requests) == loaded_requests, 'joint edits must reuse the loaded preview model'
            expect(dialog.locator('.robot-preset-dialog__preview > p')).not_to_contain_text('上次有效的位置')
            page.screenshot(path=f'/tmp/atlas-robot-preset-{mode}.png', full_page=True)
            page.set_viewport_size({'width': 390, 'height': 844})
            assert dialog.evaluate('el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && el.scrollWidth <= el.clientWidth; }')
            expect(save_and_apply).to_be_in_viewport()
            assert dialog.locator('.robot-preset-dialog__pose-actions').evaluate('el => el.scrollWidth <= el.clientWidth')
            page.screenshot(path=f'/tmp/atlas-robot-preset-{mode}-mobile.png', full_page=True)
            page.set_viewport_size({'width': 1440, 'height': 1000})
            save = dialog.get_by_role('button', name='保存姿态', exact=True)
            save.focus()
            page.keyboard.press('Tab')
            expect(save_and_apply).to_be_focused()
            page.keyboard.press('Tab')
            expect(dialog.get_by_role('button', name='关闭预设姿态窗口')).to_be_focused()
            save.click()
            expect(dialog).to_have_count(0)
            assert scene_values(page) == before, 'saving must not apply the preset'
            expect(page.get_by_role('navigation', name='工作台工具栏').get_by_role('button', name='机器人菜单')).to_be_focused()
            topbar_action(page, f'应用预设姿态 {name}', exact=True).click()
            page.wait_for_function('''expected => {
                const values = JSON.parse(document.querySelector('.three-canvas').dataset.robotJointValues);
                return Object.entries(expected).every(([name, value]) => Math.abs(values[name] - value) < 1e-6);
            }''', arg=expected)
            assert {key: canvas.get_attribute(f'data-robot-{key}') for key in base_pose} == base_pose
            assert all(scene_values(page)[key] == value for key, value in before.items() if key.startswith('wheel'))

            page.reload(wait_until='networkidle')
            wait_for_robot(page)
            topbar_action(page, f'应用预设姿态 {name}', exact=True).click()
            page.wait_for_function('''expected => {
                const values = JSON.parse(document.querySelector('.three-canvas').dataset.robotJointValues);
                return Object.entries(expected).every(([name, value]) => Math.abs(values[name] - value) < 1e-6);
            }''', arg=expected)
            topbar_action(page, '新建预设姿态', exact=True).click()
            dialog.get_by_role('textbox', name='预设姿态名称').fill(name)
            dialog.get_by_role('spinbutton', name='left_J1 预设关节值', exact=True).fill('25')
            before_duplicate = scene_values(page)
            save_and_apply.click()
            expect(dialog.get_by_role('alert')).to_contain_text('同名姿态')
            assert scene_values(page) == before_duplicate
            page.keyboard.press('Escape')
            expect(dialog).to_have_count(0)
            expect(topbar_action(page, f'应用预设姿态 {name}', exact=True)).to_have_count(1)
            page.screenshot(path=f'/tmp/atlas-robot-presets-menu-{mode}.png', full_page=True)

            import_file(page, str(SAMPLE_PATH))
            imported = dialog
            expect(imported).to_be_visible()
            expect(page.get_by_role('dialog')).to_have_count(1)
            expect(imported.get_by_role('textbox', name='预设姿态名称')).to_have_value('sample-pre-teaching-pose')
            for joint, value in SAMPLE_VALUES.items():
                assert abs(float(imported.get_by_role('spinbutton', name=f'{joint} 预设关节值', exact=True).input_value()) - value) < 1e-8
            wait_for_preview(page, SAMPLE_VALUES)
            imported.get_by_role('button', name='弧度 rad', exact=True).click()
            imported.get_by_role('button', name='重置姿态', exact=True).click()
            assert imported.get_by_role('spinbutton').evaluate_all('(inputs) => inputs.every(input => Number(input.value) === 0)')
            wait_for_preview(page, {joint: 0 for joint in SAMPLE_VALUES})
            imported.get_by_role('button', name='当前姿态', exact=True).click()
            live = scene_values(page)
            wait_for_preview(page, live)
            for joint in SAMPLE_VALUES:
                assert abs(float(imported.get_by_role('spinbutton', name=f'{joint} 预设关节值', exact=True).input_value())
                           - math.radians(live[joint])) < 1e-9
            expect(imported.get_by_role('button', name='弧度 rad', exact=True)).to_have_attribute('aria-pressed', 'true')
            expect(imported.get_by_role('textbox', name='预设姿态名称')).to_have_value('sample-pre-teaching-pose')
            assert all(abs(live[joint] - value) < 1e-6 for joint, value in expected.items())
            imported.get_by_role('button', name='取消', exact=True).click()
            expect(topbar_action(page, '应用预设姿态 sample-pre-teaching-pose', exact=True)).to_have_count(0)

            import_file(page, str(SAMPLE_PATH))
            expect(imported).to_be_visible()
            imported_name = f'{mode} 导入姿态'
            imported.get_by_role('textbox', name='预设姿态名称').fill(imported_name)
            imported.get_by_role('spinbutton', name='left_J1 预设关节值', exact=True).fill('15')
            wait_for_preview(page, {**SAMPLE_VALUES, 'left_J1': 15})
            # Reimporting the same file in the same form replaces values, preserving the entered name.
            import_file(page, str(SAMPLE_PATH))
            expect(imported.get_by_role('textbox', name='预设姿态名称')).to_have_value(imported_name)
            assert abs(float(imported.get_by_role('spinbutton', name='left_J1 预设关节值', exact=True).input_value())
                       - SAMPLE_VALUES['left_J1']) < 1e-8
            imported.get_by_role('button', name='弧度 rad', exact=True).click()
            assert abs(float(imported.get_by_role('spinbutton', name='head_yaw_J 预设关节值', exact=True).input_value())
                       - math.radians(SAMPLE_VALUES['head_yaw_J'])) < 1e-9
            wait_for_preview(page, SAMPLE_VALUES)
            page.screenshot(path=f'/tmp/atlas-robot-preset-import-{mode}.png', full_page=True)
            imported.get_by_role('button', name='保存并应用', exact=True).click()
            expect(imported).to_have_count(0)
            page.wait_for_function('''expected => {
                const values = JSON.parse(document.querySelector('.three-canvas').dataset.robotJointValues);
                return Object.entries(expected).every(([name, value]) => Math.abs(values[name] - value) < 1e-6);
            }''', arg=SAMPLE_VALUES)
            assert {key: canvas.get_attribute(f'data-robot-{key}') for key in base_pose} == base_pose
            assert all(scene_values(page)[key] == value for key, value in before.items() if key.startswith('wheel'))
            saved = wait_for_saved(page, lambda project: all(
                abs(project['robot']['joints'].get(joint, float('inf')) - value) < 1e-6
                for joint, value in SAMPLE_VALUES.items()), mode)
            presets = [pose for pose in saved['virtualTeaching']['jointPoses'] if pose['name'] == imported_name]
            assert len(presets) == 1
            assert all(abs(presets[0]['joints']['values'][joint] - value) < 1e-6
                       for joint, value in SAMPLE_VALUES.items())

            invalid = json.loads(json.dumps(SAMPLE))
            invalid['joints']['head'] = [0]
            topbar_action(page, '新建预设姿态', exact=True).click()
            draft_name = f'{mode} 待完善姿态'
            imported.get_by_role('textbox', name='预设姿态名称').fill(draft_name)
            imported.get_by_role('spinbutton', name='left_J1 预设关节值', exact=True).fill('17')
            imported.get_by_role('button', name='弧度 rad', exact=True).click()
            wait_for_preview(page, {**SAMPLE_VALUES, 'left_J1': 17})
            before_invalid_import = preview_values(page)
            draft_values = imported.get_by_role('spinbutton').evaluate_all('(items) => items.map(item => item.value)')
            import_file(page, {'name': 'invalid.json', 'mimeType': 'application/json',
                               'buffer': json.dumps(invalid).encode()})
            expect(imported.get_by_role('alert')).to_contain_text('head 必须包含 2 个关节值')
            expect(imported.get_by_role('textbox', name='预设姿态名称')).to_have_value(draft_name)
            expect(imported.get_by_role('button', name='弧度 rad', exact=True)).to_have_attribute('aria-pressed', 'true')
            assert imported.get_by_role('spinbutton').evaluate_all('(items) => items.map(item => item.value)') == draft_values
            assert preview_values(page) == before_invalid_import
            assert all(abs(scene_values(page)[joint] - value) < 1e-6 for joint, value in SAMPLE_VALUES.items())

            radians = {'unit': 'rad', 'joints': {group: [math.radians(value) for value in values]
                                               for group, values in SAMPLE['joints'].items()}}
            import_file(page, {'name': 'radians.json', 'mimeType': 'application/json',
                               'buffer': json.dumps(radians).encode()})
            expect(imported.get_by_role('alert')).to_have_count(0)
            expect(imported.get_by_role('textbox', name='预设姿态名称')).to_have_value(draft_name)
            expect(imported.get_by_role('button', name='弧度 rad', exact=True)).to_have_attribute('aria-pressed', 'true')
            assert abs(float(imported.get_by_role('spinbutton', name='left_J1 预设关节值', exact=True).input_value())
                       - radians['joints']['left_arm'][0]) < 1e-9
            wait_for_preview(page, SAMPLE_VALUES)
            imported.get_by_role('button', name='取消', exact=True).click()
            expect(topbar_action(page, f'应用预设姿态 {draft_name}', exact=True)).to_have_count(0)
            expect(topbar_action(page, f'应用预设姿态 {imported_name}', exact=True)).to_have_count(1)

            page.reload(wait_until='networkidle')
            wait_for_robot(page)
            assert all(abs(scene_values(page)[joint] - value) < 1e-6 for joint, value in SAMPLE_VALUES.items())
            topbar_action(page, f'应用预设姿态 {name}', exact=True).click()
            topbar_action(page, f'应用预设姿态 {imported_name}', exact=True).click()
            page.wait_for_function('''expected => {
                const values = JSON.parse(document.querySelector('.three-canvas').dataset.robotJointValues);
                return Object.entries(expected).every(([name, value]) => Math.abs(values[name] - value) < 1e-6);
            }''', arg=SAMPLE_VALUES)
            context.close()
            print(f'{mode}: live preview, reset/current pose, invalid input/import isolation, save-and-apply, units, reload and keyboard passed', flush=True)
        assert not errors, errors
        browser.close()


if __name__ == '__main__':
    run()
