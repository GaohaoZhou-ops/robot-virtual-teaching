"""Check contextual deletion in isolated browser workspaces, never the user's data."""
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from teaching_preset_insertion_ui_smoke import BASE_URL, CHROME, seed, wait_for_saved


def task(project):
    return next(item for item in project['virtualTeaching']['tasks'] if item['id'] == 'task/中文')


def route_points(project):
    return [point for point in project['waypoints'] if point['source'] != 'teaching-parking-point']


def run():
    shots = Path('/tmp/atlas-teaching-capture-delete')
    shots.mkdir(exist_ok=True)
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            for mode in ('map', 'independent'):
                context = browser.new_context(viewport=dict(width=1440, height=1000))
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                seed(page, mode=mode)
                page.goto(BASE_URL + '/workbench', wait_until='networkidle')
                page.locator('.loading-curtain').wait_for(state='hidden')
                panel = page.get_by_role('region', name='虚拟示教', exact=True)
                expect(panel).to_be_visible()
                tree = page.get_by_role('tree', name='虚拟示教任务停车点层级')
                delete = panel.locator('.teaching-capture-delete')
                record = panel.get_by_role('button', name='记录当前姿态', exact=True)
                task_button = tree.get_by_role('button', name='打开示教任务 装配任务：中文校验', exact=True)
                parking_b = tree.get_by_role('button', name='选择当前停车点 停车点 B', exact=True)
                pose_a = tree.get_by_role('treeitem', name='预览机械臂姿态 姿态 a1', exact=True)
                dimensions = []

                def check_layout(label):
                    expect(delete).to_have_text(label)
                    expect(delete).to_be_enabled()
                    box, capture_box = delete.bounding_box(), record.bounding_box()
                    assert box['x'] >= capture_box['x'] + capture_box['width'], (box, capture_box)
                    assert abs(box['y'] - capture_box['y']) < 0.1, (box, capture_box)
                    assert abs(box['height'] - capture_box['height']) < 0.1, (box, capture_box)
                    dimensions.append((box['x'], box['width'], capture_box['width']))
                    assert dimensions[-1] == dimensions[0], dimensions
                    assert tree.locator('[role="treeitem"][aria-selected="true"]').count() == 1

                task_button.click()
                check_layout('删除示教')
                original = wait_for_saved(page, lambda project: len(task(project)['parkingPoints']) == 2, mode)
                page.once('dialog', lambda dialog: dialog.dismiss())
                delete.click()
                expect(task_button).to_be_visible()
                expect(panel).to_have_attribute('data-teaching-point-count', '3')

                pose_a.click()
                check_layout('删除姿态')
                expect(pose_a).to_have_attribute('aria-selected', 'true')
                # Choosing a task with an already-selected first parking point
                # must still select the task rather than that parking point.
                task_button.click()
                check_layout('删除示教')
                parking_b.click()
                check_layout('删除停车点')
                page.screenshot(path=str(shots / f'{mode}-parking.png'), full_page=True)
                page.once('dialog', lambda dialog: dialog.dismiss())
                delete.click()
                expect(panel).to_have_attribute('data-parking-point-count', '2')

                pose_b = tree.get_by_role('treeitem', name='预览机械臂姿态 姿态 b1', exact=True)
                pose_b.click()
                check_layout('删除姿态')
                page.screenshot(path=str(shots / f'{mode}-pose.png'), full_page=True)
                page.once('dialog', lambda dialog: dialog.accept())
                delete.click()
                expect(pose_b).to_have_count(0)
                check_layout('删除停车点')
                after_pose = wait_for_saved(page, lambda project:
                    next(stop for stop in task(project)['parkingPoints'] if stop['id'] == 'parking-b')['poses'] == [], mode)
                assert task(after_pose)['parkingPoints'][0] == task(original)['parkingPoints'][0]
                expect(page.locator('.three-canvas')).to_have_attribute('data-parking-ghost-state', 'hidden')

                # Deleting a parking point selects its parent task, even when
                # the active parking point changes to another remaining stop.
                page.once('dialog', lambda dialog: dialog.accept())
                delete.click()
                expect(parking_b).to_have_count(0)
                check_layout('删除示教')
                after_parking = wait_for_saved(page, lambda project: len(task(project)['parkingPoints']) == 1, mode)
                assert task(after_parking)['parkingPoints'][0] == task(original)['parkingPoints'][0]
                assert route_points(after_parking) == route_points(original)
                assert not any(point['id'] == 'parking-b' for point in after_parking['waypoints'])

                # An empty task is still deletable while recording is disabled.
                empty_task = tree.get_by_role('button', name='打开示教任务 空任务', exact=True)
                empty_task.click()
                check_layout('删除示教')
                expect(record).to_be_disabled()
                page.once('dialog', lambda dialog: dialog.accept())
                delete.click()
                expect(empty_task).to_have_count(0)
                task_button.click()
                check_layout('删除示教')
                page.screenshot(path=str(shots / f'{mode}-task.png'), full_page=True)
                page.once('dialog', lambda dialog: dialog.accept())
                delete.click()
                expect(delete).to_have_count(0)
                expect(panel).to_have_attribute('data-teaching-task-count', '0')
                final = wait_for_saved(page, lambda project: project['virtualTeaching']['tasks'] == [], mode)
                assert route_points(final) == route_points(original)
                page.reload(wait_until='networkidle')
                expect(page.get_by_role('region', name='虚拟示教', exact=True)).to_have_attribute('data-teaching-task-count', '0')
                context.close()
            assert not errors, errors
        finally:
            browser.close()
    print('Map/independent teaching: selection labels, fixed widths, cancellation, scoped deletion, preview cleanup and reload passed.')


if __name__ == '__main__':
    run()
