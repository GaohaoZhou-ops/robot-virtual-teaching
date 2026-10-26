"""Enter accepts end-effector edits; Escape still restores only the current edit."""
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from dual_teaching_workspace_smoke import BASE_URL, create_project, wait_for_home
from end_effector_cancel_smoke import begin, cancel, move_x
from end_effector_control_smoke import load_robot, number_attr
from robot_drag_undo_smoke import assert_restored, drag, state, undo_depth
from teaching_preset_insertion_ui_smoke import wait_for_saved
from topbar_tools_helpers import topbar_action
from viewer_tools_helpers import viewer_tool


def closed(page, canvas):
    expect(page.get_by_label('机械臂末端空间球', exact=True)).to_have_count(0)
    for name, value in {'control-state': 'idle', 'dragging': 'false', 'space-ball-visible': 'false',
                        'transform-attached': 'false'}.items():
        expect(canvas).to_have_attribute(f'data-end-effector-{name}', value)
    expect(canvas).to_be_focused()


def run():
    errors = []
    output = Path('test-artifacts/end-effector-confirm')
    output.mkdir(parents=True, exist_ok=True)
    chrome = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=chrome)
        try:
            for mode in ('map', 'independent'):
                context = browser.new_context(viewport={'width': 1440, 'height': 1000})
                page = context.new_page()
                page.set_default_timeout(30_000)
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(BASE_URL, wait_until='networkidle')
                wait_for_home(page)
                create_project(page, mode)
                load_robot(page)
                canvas = page.locator('.three-canvas')
                viewer_tool(page, name='定位机器人模型').click()
                page.wait_for_timeout(400)

                # Both Enter keys commit a dirty numeric field before accepting the entire edit.
                for side in ('left', 'right'):
                    for label, attribute, delta, key in [('X (m)', 'x', .012, 'Enter'),
                                                        ('YAW (°)', 'yaw', 1.5, 'NumpadEnter')]:
                        before = begin(page, canvas, side)
                        target = number_attr(canvas, f'end-effector-target-{attribute}') + delta
                        field = page.get_by_role('spinbutton', name=f'末端 {label}', exact=True)
                        field.fill(str(target))
                        field.press(key)
                        closed(page, canvas)
                        actual = number_attr(canvas, f'end-effector-target-{attribute}')
                        difference = actual - target if attribute == 'x' else (actual - target + 180) % 360 - 180
                        assert abs(difference) < 1e-5, (mode, side, attribute, target, actual)
                        accepted = state(canvas)
                        assert accepted['joints'] != before['joints']
                        begin(page, canvas, side)
                        move_x(page, canvas)
                        cancel(page, canvas, accepted)

                # Input-method confirmation, repeated keys and modified Enter are not shortcuts.
                before = begin(page, canvas, 'left')
                field = page.get_by_role('spinbutton', name='末端 X (m)', exact=True)
                field.fill(str(number_attr(canvas, 'end-effector-target-x') + .012))
                for extra in [{'isComposing': True}, {'keyCode': 229}, {'repeat': True},
                              {'ctrlKey': True}, {'metaKey': True}, {'altKey': True}, {'shiftKey': True}]:
                    field.dispatch_event('keydown', {'key': 'Enter', 'code': 'Enter', **extra})
                    expect(canvas).to_have_attribute('data-end-effector-control-state', 'active')
                    expect(field).to_be_focused()
                    assert_restored(canvas, before)
                field.press('Tab')
                accepted = state(canvas)
                panel = page.get_by_label('机械臂末端空间球', exact=True)
                expect(panel).to_contain_text('Enter 确认 · Esc 取消调整')
                page.screenshot(path=str(output / f'{mode}-hint.png'), full_page=True)
                panel.get_by_role('button', name='RPY 旋转', exact=True).press('Enter')
                closed(page, canvas)
                assert_restored(canvas, accepted)

                # Accepting a drag retains its undo entry and releases an active pointer gesture.
                before = begin(page, canvas, 'right')
                x, y = drag(page, canvas, dx=8, dy=-5, release=False)
                canvas.press('Enter')
                closed(page, canvas)
                accepted = state(canvas)
                assert accepted['joints'] != before['joints']
                page.mouse.move(x + 10, y + 7, steps=3)
                page.mouse.up()
                assert_restored(canvas, accepted)
                assert undo_depth(canvas) == 1
                canvas.press('Control+z')
                assert_restored(canvas, before)

                # Modal and inactive-page Enter must not accept the adjustment underneath.
                before = begin(page, canvas, 'left')
                move_x(page, canvas)
                accepted = state(canvas)
                topbar_action(page, '新建预设姿态', exact=True).click()
                dialog = page.get_by_role('dialog', name='新建预设姿态', exact=True)
                dialog.get_by_role('textbox', name='预设姿态名称').press('Enter')
                expect(dialog).to_be_visible()
                expect(canvas).to_have_attribute('data-end-effector-control-state', 'active')
                assert_restored(canvas, accepted)
                dialog.get_by_role('button', name='关闭预设姿态窗口', exact=True).click()
                topbar_action(page, '打开示教数据管理页', exact=False).click()
                page.keyboard.press('Enter')
                expect(canvas).to_have_attribute('data-end-effector-control-state', 'active')
                assert_restored(canvas, accepted)
                page.get_by_role('button', name='返回主工作台继续示教').click()
                canvas.press('Enter')
                closed(page, canvas)
                assert_restored(canvas, accepted)

                wait_for_saved(page, lambda project: all(abs(project['robot']['joints'][joint] - value) < 1e-7
                               for joint, value in accepted['joints'].items()), mode)
                page.reload(wait_until='networkidle')
                expect(canvas).to_have_attribute('data-robot-model-state', 'loaded', timeout=180_000)
                assert_restored(canvas, accepted)
                expect(canvas).to_have_attribute('data-end-effector-control-state', 'idle')
                assert not errors, errors
                context.close()
                print(f'{mode}: Enter/numpad, numeric commit, Escape, IME/modifiers, drag cleanup/undo, modal/page scope and reload passed', flush=True)
        finally:
            browser.close()


if __name__ == '__main__':
    run()
