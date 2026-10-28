"""Connect the running workbench to the standalone simulator in an isolated browser."""
import json
import os
import time
from copy import deepcopy
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:21990')
ROBOT = os.environ.get('FAKE_ROBOT_ADDRESS', '127.0.0.1:9090')
PASSWORD = os.environ.get('FAKE_ROBOT_PASSWORD', 'admin')


def robot_status():
    with urlopen(f'http://{ROBOT}/__fake_robot/status', timeout=3) as response:
        return json.load(response)


assert robot_status()['service'] == 'atlas-fake-robot', 'This test only connects to the standalone simulator.'
artifacts = ROOT / 'test-artifacts' / 'fake-robot'
artifacts.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get(
        'PLAYWRIGHT_CHROMIUM_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.set_default_timeout(30000)
    errors = []
    cloud_reads = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: cloud_reads.append(request.url) if request.url.endswith('/xyzbin') else None)
    try:
        page.goto(BASE + '/workbench', wait_until='networkidle')
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator('input[type="file"][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/rotation-map.ply'))
        page.locator('.loading-curtain').wait_for(state='hidden')
        topbar_action(page, name='加载机器人', exact=True).click()
        page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70', exact=True).click()
        canvas = page.locator('.three-canvas')
        expect(canvas).to_have_attribute('data-robot-model-state', 'loaded', timeout=180000)
        offline = [canvas.get_attribute(f'data-robot-{key}') for key in ['x', 'y', 'z', 'yaw']]
        page.get_by_role('button', name='同步作业', exact=True).click()
        page.get_by_role('dialog').get_by_role('button', name='真机孪生').click()
        dialog = page.get_by_role('dialog', name='真机孪生', exact=True)
        dialog.get_by_role('button', name='添加机器人', exact=True).click()
        dialog.get_by_label('机器人名称', exact=True).fill('本地模拟机器人')
        dialog.get_by_label('机器人地址', exact=True).fill(ROBOT)
        dialog.get_by_role('button', name='保存机器人', exact=True).click()
        dialog.get_by_label('管理员密码', exact=True).fill(PASSWORD)
        dialog.get_by_role('button', name='连接并同步', exact=True).click()
        expect(dialog.locator('.robot-twin-success')).to_contain_text('连接成功')
        expect(dialog).not_to_be_visible(timeout=3000)
        first_x = canvas.get_attribute('data-robot-x')
        expect(canvas).not_to_have_attribute('data-robot-x', first_x)
        assert len(json.loads(canvas.get_attribute('data-robot-joint-values'))) >= 20
        follow = page.get_by_role('button', name='机器人后上方跟随视角')
        follow.click()
        expect(canvas).to_have_attribute('data-twin-follow-enabled', 'true')
        first_camera = canvas.get_attribute('data-camera-x')
        expect(canvas).not_to_have_attribute('data-camera-x', first_camera)
        monitor = page.get_by_role('complementary', name='任务监控台', exact=True)
        expect(monitor).to_contain_text('模拟巡检任务', timeout=15000)  # The simulator has a 10-second idle phase.
        cameras = monitor.get_by_role('region', name='本体相机', exact=True)
        picker = cameras.get_by_role('combobox', name='选择本体相机')
        expect(picker.locator('option')).to_have_count(6)
        cameras.get_by_role('switch', name='本体相机实时画面').click()
        expect(cameras).to_have_attribute('data-camera-phase', 'live')
        expect(cameras.get_by_role('img', name='头部左目实时画面')).to_be_visible()
        cameras.get_by_role('button', name='放大本体相机画面').click()
        expanded = page.get_by_role('dialog', name='头部左目 · 实时画面', exact=True)
        first_frame = expanded.locator('img').get_attribute('src')
        expect(expanded.locator('img')).not_to_have_attribute('src', first_frame)
        assert expanded.locator('img').evaluate('(image) => image.complete && image.naturalWidth === 480')
        page.screenshot(path=str(artifacts / 'camera.png'))
        expanded.get_by_role('button', name='关闭放大画面').click()
        picker.select_option('wrist-right')
        expect(cameras.get_by_role('img', name='右手腕实时画面')).to_be_visible()
        assert robot_status()['activeCamera'] == 'wrist-right'
        expect(monitor.get_by_role('list', name='算法结果列表', exact=True).get_by_role('listitem').first).to_be_visible(timeout=25000)
        capture = monitor.get_by_role('region', name='Zivid 采集结果', exact=True)
        expect(capture.get_by_role('img', name='左 Zivid拍摄图像')).to_be_visible()
        expect(capture.get_by_role('img', name='右 Zivid拍摄图像')).to_be_visible()
        image_id = capture.get_attribute('data-capture-id')
        image_url = capture.get_by_role('img', name='左 Zivid拍摄图像').get_attribute('src')
        capture.get_by_role('button', name='点云', exact=True).click()
        left_cloud = capture.get_by_role('img', name='左 Zivid点云', exact=True)
        expect(left_cloud).to_have_attribute('data-point-count', '32400')
        expect(capture.get_by_role('img', name='右 Zivid点云', exact=True)).to_have_attribute('data-point-count', '32400')
        capture.get_by_role('button', name='放大双 Zivid 采集结果').click()
        pair_dialog = page.get_by_role('dialog', name='双 Zivid 采集结果', exact=True)
        expect(pair_dialog.get_by_role('complementary', name='已完成算法列表')).to_be_visible()
        expect(pair_dialog.locator('.robot-twin-capture-history__error')).to_have_count(0)
        expect(pair_dialog.get_by_role('img', name='左 Zivid点云', exact=True)).to_be_visible()
        cloud_canvas = pair_dialog.get_by_role('img', name='左 Zivid点云', exact=True)
        frame_before = cloud_canvas.screenshot()
        bounds = cloud_canvas.bounding_box()
        page.mouse.move(bounds['x'] + bounds['width'] * .4, bounds['y'] + bounds['height'] * .4)
        page.mouse.down()
        page.mouse.move(bounds['x'] + bounds['width'] * .6, bounds['y'] + bounds['height'] * .55, steps=8)
        page.mouse.up()
        assert cloud_canvas.screenshot() != frame_before, 'dragging must rotate the actual point cloud'
        page.screenshot(path=str(artifacts / 'zivid-point-cloud.png'))
        pair_dialog.get_by_role('button', name='图像', exact=True).click()
        expect(pair_dialog.get_by_role('img', name='左 Zivid拍摄图像')).to_be_visible()
        if capture.get_attribute('data-capture-id') == image_id:
            assert pair_dialog.get_by_role('img', name='左 Zivid拍摄图像').get_attribute('src') == image_url, 'mode/size switching reuses the image'
        page.screenshot(path=str(artifacts / 'zivid-images.png'))
        pair_dialog.get_by_role('button', name='关闭采集结果大窗').click()
        expect(monitor.locator('.task-monitor__alarm')).to_be_visible(timeout=35000)
        expect(monitor.locator('[data-result-alarm="true"]').first).to_be_visible()
        assert monitor.locator('.task-monitor__alarm').evaluate('(node) => getComputedStyle(node).color') == 'rgb(255, 142, 131)'
        monitor.locator('.task-monitor__alarm').get_by_role('button', name='查看').click()
        page.screenshot(path=str(artifacts / 'zivid-alarm.png'))
        page.screenshot(path=str(artifacts / 'workbench.png'))
        expect(monitor.locator('.task-monitor__output')).to_have_count(0)
        expect(monitor.get_by_text('原始算法输出', exact=True)).to_have_count(0)
        # Hold real simulator metadata so task timing cannot interrupt history
        # navigation. PNG/XYZ reads still go through the actual server proxy.
        deadline = time.monotonic() + 65
        while True:
            with page.expect_response(lambda response: response.url.endswith('/robot-twin/monitor') and response.ok) as observed:
                pass
            history = observed.value.json()
            if len(history.get('captures', [])) >= 2:
                break
            assert time.monotonic() < deadline, 'waiting for a pair of captures'
        newest, oldest = history['captures'][0], history['captures'][-1]
        old_key = f"{oldest['id']}:left"
        new_key = f"{newest['id']}:right"
        frozen = deepcopy(history)
        frozen.update(captures=[oldest], latestCapture=oldest,
                      results=[item for item in history['results'] if item['captureId'] == oldest['id']])
        monitor_route = '**/__atlas/robot-twin/monitor'
        page.route(monitor_route, lambda route: route.fulfill(json={**frozen, 'taskAgeMs': 0}))
        expect(monitor.locator('.task-monitor__result')).to_have_count(2)
        old_row = monitor.locator(f'[data-result-key="{old_key}"]')
        old_row.get_by_role('button').click()
        expect(old_row).to_have_attribute('data-result-selected', 'true')
        expect(capture).to_have_attribute('data-capture-id', oldest['id'])
        old_image = capture.get_by_role('img', name='左 Zivid拍摄图像')
        expect(old_image).to_be_visible()
        old_pixels = old_image.screenshot()
        old_url = old_image.get_attribute('src')
        frozen.update(deepcopy(history))
        new_row = monitor.locator(f'[data-result-key="{new_key}"]')
        expect(new_row).to_be_attached()
        expect(capture).to_have_attribute('data-capture-id', oldest['id'])
        assert old_image.get_attribute('src') == old_url, 'new results must not replace a selected image'
        new_row.get_by_role('button').click()
        expect(capture).to_have_attribute('data-capture-id', newest['id'])
        expect(old_image).to_be_visible()
        assert old_image.screenshot() != old_pixels, 'selecting history must load different capture pixels'
        expect(new_row).to_have_attribute('data-result-selected', 'true')
        page.screenshot(path=str(artifacts / 'zivid-selected.png'))
        old_row.get_by_role('button').focus()
        old_row.get_by_role('button').press('Enter')
        expect(capture).to_have_attribute('data-selected-side', 'left')
        capture.get_by_role('button', name='点云', exact=True).click()
        expect(capture.get_by_role('img', name='左 Zivid点云', exact=True)).to_have_attribute('data-point-count', '32400')
        new_row.get_by_role('button').click()
        expect(capture).to_have_attribute('data-capture-id', newest['id'])
        expect(capture.get_by_role('button', name='点云', exact=True)).to_have_attribute('aria-pressed', 'true')
        expect(capture.get_by_role('img', name='右 Zivid点云', exact=True)).to_have_attribute('data-point-count', '32400')
        defect = next(item for item in frozen['captures'] if item['sides']['right']['confirmedCount'] == 1 and item['sides']['right']['suspectedCount'] == 0)
        defect_row = monitor.locator(f'[data-result-key="{defect["id"]}:right"]')
        defect_row.get_by_role('button').click()
        expect(capture).to_have_attribute('data-capture-id', defect['id'])
        defect_cloud = capture.get_by_role('img', name='右 Zivid点云', exact=True)
        normal_cloud = capture.get_by_role('img', name='左 Zivid点云', exact=True)
        expect(defect_cloud).to_have_attribute('data-highlighted-point-count', '675')
        expect(normal_cloud).to_have_attribute('data-highlighted-point-count', '0')
        capture.get_by_role('button', name='放大双 Zivid 采集结果').click()
        colored_dialog = page.get_by_role('dialog', name='双 Zivid 采集结果', exact=True)
        expect(colored_dialog.get_by_role('img', name='右 Zivid点云')).to_have_attribute('data-highlighted-point-count', '675')
        page.screenshot(path=str(artifacts / 'zivid-defect-cloud.png'))
        colored_dialog.get_by_role('button', name='关闭采集结果大窗').click()
        expect(defect_cloud).to_have_attribute('data-highlighted-point-count', '675')
        saved_inspection = deepcopy(defect['sides']['right'])
        defect_cloud.evaluate('(node) => node.dataset.testIdentity = "keep-view"')
        reads_before_annotation = len(cloud_reads)
        defect['sides']['right'].update(state='processing', abnormal=False, boxes=[])
        expect(defect_cloud).to_have_attribute('data-highlighted-point-count', '0')
        defect['sides']['right'].update(deepcopy(saved_inspection))
        expect(defect_cloud).to_have_attribute('data-highlighted-point-count', '675')
        expect(defect_cloud).to_have_attribute('data-test-identity', 'keep-view')
        assert len(cloud_reads) == reads_before_annotation, 'late algorithm updates recolor the existing cloud without downloading again'
        defect['sides']['right']['pixelMapping']['offset_x'] = 1
        expect(defect_cloud).to_have_attribute('data-highlighted-point-count', '0')
        expect(capture.get_by_text('异常区域与点云映射不匹配，暂不能着色', exact=True)).to_be_visible()
        defect['sides']['right'].update(deepcopy(saved_inspection))
        expect(defect_cloud).to_have_attribute('data-highlighted-point-count', '675')
        # Isolate one real pair while exercising severity changes. This retains
        # its actual PNG/XYZ buffers and the user's selected history entry.
        saved_history = deepcopy(frozen)
        frozen.update(captures=[defect], latestCapture=defect, resultTotal=2,
                      results=[item for item in frozen['results'] if item['captureId'] == defect['id']])
        def set_boxes(side, boxes, suspected_count):
            confirmed_count = len(boxes) - suspected_count
            summary = dict(state='complete', detectionCount=len(boxes), suspectedCount=suspected_count,
                           confirmedCount=confirmed_count, severity='clear' if not boxes else 'defect' if confirmed_count else 'suspected')
            defect['sides'][side].update(**summary, abnormal=bool(boxes), boxes=deepcopy(boxes))
            row = next(item for item in frozen['results'] if item['camera'] == side)
            row.update(**summary, labels=[box['label'] for box in boxes], detections=deepcopy(boxes))
        high = deepcopy(saved_inspection['boxes'][0])
        low = {**high, 'confidence': 0.6}
        severity_banner = monitor.locator('.task-monitor__alarm')
        view = capture.locator('[data-capture-side="right"]')
        set_boxes('right', [low], 1)
        expect(defect_cloud).to_have_attribute('data-confirmed-point-count', '0')
        expect(defect_cloud).to_have_attribute('data-suspected-point-count', '675')
        expect(severity_banner).to_have_attribute('data-severity', 'suspected')
        expect(defect_row).to_have_attribute('data-severity', 'suspected')
        expect(view).to_have_attribute('data-severity', 'suspected')
        expect(defect_row).to_contain_text('60%')
        expect(severity_banner).to_have_css('color', 'rgb(250, 204, 21)')
        expect(defect_row).to_have_css('border-left-color', 'rgb(250, 204, 21)')
        capture.get_by_role('button', name='图像', exact=True).click()
        expect(view.locator('rect.is-suspected')).to_have_count(1)
        expect(view.locator('rect')).to_have_css('stroke', 'rgb(250, 204, 21)')
        capture.scroll_into_view_if_needed()
        page.screenshot(path=str(artifacts / 'zivid-suspected-image.png'))
        set_boxes('left', [high], 0)
        expect(severity_banner).to_have_attribute('data-severity', 'defect')
        expect(defect_row).to_have_attribute('data-severity', 'suspected')
        expect(severity_banner).to_have_css('color', 'rgb(255, 142, 131)')
        set_boxes('left', [], 0)
        overlapping = {**low, 'x': 170, 'y': 100, 'width': 80, 'height': 40}
        set_boxes('right', [overlapping, high], 1)
        expect(view.locator('rect')).to_have_count(2)
        expect(view.locator('rect').last).not_to_have_class('is-suspected')
        expect(view).to_have_attribute('data-severity', 'defect')
        expect(defect_row).to_have_attribute('data-severity', 'defect')
        expect(defect_row).to_contain_text('含 1 处疑似')
        expect(severity_banner).to_have_attribute('data-severity', 'defect')
        expect(defect_row).to_have_css('border-left-color', 'rgb(255, 142, 131)')
        capture.get_by_role('button', name='点云', exact=True).click()
        expect(defect_cloud).to_have_attribute('data-confirmed-point-count', '675')
        expect(defect_cloud).to_have_attribute('data-suspected-point-count', '650')
        expect(defect_cloud).to_have_attribute('data-highlighted-point-count', '1325')
        capture.get_by_role('button', name='放大双 Zivid 采集结果').click()
        expect(colored_dialog.get_by_role('img', name='右 Zivid点云')).to_have_attribute('data-confirmed-point-count', '675')
        expect(colored_dialog.get_by_role('img', name='右 Zivid点云')).to_have_attribute('data-suspected-point-count', '650')
        page.screenshot(path=str(artifacts / 'zivid-confidence-mixed-cloud.png'))
        colored_dialog.get_by_role('button', name='关闭采集结果大窗').click()
        assert len(cloud_reads) == reads_before_annotation, 'confidence changes reuse the same capture data'
        frozen.clear(); frozen.update(saved_history)
        expect(old_row).to_be_attached()
        # Exercise a run longer than the compact monitor's recent window. Only
        # selected media is fetched, using actual simulator PNG/XYZ responses.
        long_results, long_captures, history_requests = [], {}, []
        history_failure = [True]
        for index in range(18):
            identity = f'c{index:031x}'
            detail = {**deepcopy(oldest), 'id': identity, 'pointName': f'历史检测点 {index + 1}'}
            long_captures[identity] = detail
            for side_index, side in enumerate(['left', 'right']):
                template = next(item for item in history['results'] if item['captureId'] == oldest['id'] and item['camera'] == side)
                long_results.append({**deepcopy(template), 'key': f'{identity}:{side}', 'captureId': identity,
                                     'sequence': index * 2 + side_index + 1, 'pointName': detail['pointName'],
                                     'state': 'processing' if index == 17 else 'complete', 'received': True})
        recent = deepcopy(frozen['results'])
        for index, item in enumerate(recent):
            item['sequence'] = 37 + index
        long_results.extend(recent)
        long_captures.update({item['id']: item for item in frozen['captures']})
        history_route = '**/__atlas/robot-twin/capture-history/**'
        def full_history(route):
            history_requests.append(route.request.url)
            if history_failure[0]:
                route.fulfill(status=502, json={'error': '模拟索引暂不可用'})
                return
            offset = int(route.request.url.rsplit('/', 1)[1])
            rows = long_results[offset:offset + 8]
            route.fulfill(json=dict(runId=history['task']['id'], results=rows,
                                   captures=[long_captures[key] for key in dict.fromkeys(item['captureId'] for item in rows)],
                                   nextOffset=offset + len(rows), total=len(long_results),
                                   pending=any(item['state'] == 'processing' for item in rows), error=''))
        media_route = '**/__atlas/robot-twin/captures/c*/**'
        def history_media(route):
            parts = route.request.url.rsplit('/', 3)
            response = route.fetch(url=f'{parts[0]}/{oldest["id"]}/{parts[2]}/{parts[3]}')
            route.fulfill(response=response)
        page.route(history_route, full_history)
        page.route(media_route, history_media)
        capture.get_by_role('button', name='放大双 Zivid 采集结果').click()
        list_panel = colored_dialog.get_by_role('complementary', name='已完成算法列表')
        expect(list_panel.get_by_text('列表未完整读取：模拟索引暂不可用')).to_be_visible()
        history_failure[0] = False
        list_panel.get_by_role('button', name='重新读取', exact=True).click()
        complete_count = sum(item['state'] == 'complete' for item in long_results)
        expect(list_panel.locator('[data-history-key]')).to_have_count(complete_count)
        assert complete_count > 24
        expect(list_panel.locator('[data-history-key^="c0000000000000000000000000000011:"]')).to_have_count(0)
        historical_id = 'c' + '0' * 31
        historical_row = list_panel.locator(f'[data-history-key="{historical_id}:right"]')
        historical_row.click()
        expect(colored_dialog).to_have_attribute('data-capture-id', historical_id)
        expect(historical_row).to_have_attribute('aria-pressed', 'true')
        expect(colored_dialog.get_by_role('button', name='点云', exact=True)).to_have_attribute('aria-pressed', 'true')
        expect(colored_dialog.get_by_role('img', name='右 Zivid点云')).to_have_attribute('data-point-count', '32400')
        colored_dialog.get_by_role('button', name='图像', exact=True).click()
        expect(colored_dialog.get_by_role('img', name='右 Zivid拍摄图像')).to_be_visible()
        for item in long_results:
            if item['captureId'] == f'c{17:031x}':
                item['state'] = 'complete'
        expect(list_panel.locator('[data-history-key]')).to_have_count(complete_count + 2, timeout=10000)
        expect(colored_dialog).to_have_attribute('data-capture-id', historical_id)
        page.screenshot(path=str(artifacts / 'zivid-completed-history.png'))
        list_panel.locator(f'[data-history-key="c{1:031x}:left"]').focus()
        list_panel.locator(f'[data-history-key="c{1:031x}:left"]').press('Enter')
        expect(colored_dialog).to_have_attribute('data-capture-id', f'c{1:031x}')
        expect(colored_dialog.get_by_role('button', name='图像', exact=True)).to_have_attribute('aria-pressed', 'true')
        page.set_viewport_size({'width': 600, 'height': 800})
        expect(colored_dialog.get_by_role('button', name='关闭采集结果大窗')).to_be_visible()
        assert colored_dialog.evaluate('(node) => node.scrollWidth <= node.clientWidth')
        page.screenshot(path=str(artifacts / 'zivid-completed-history-narrow.png'))
        page.set_viewport_size({'width': 1440, 'height': 1000})
        colored_dialog.get_by_role('button', name='回到最新', exact=True).click()
        expect(colored_dialog).to_have_attribute('data-capture-id', newest['id'])
        colored_dialog.get_by_role('button', name='关闭采集结果大窗').click()
        before_close = len(history_requests)
        page.wait_for_timeout(3500)
        assert len(history_requests) == before_close, 'closing the large viewer stops history polling'
        page.unroute(history_route)
        page.unroute(media_route)
        old_row.get_by_role('button').click()
        capture.get_by_role('button', name='回到最新', exact=True).click()
        expect(capture).to_have_attribute('data-capture-mode', 'latest')
        expect(capture).to_have_attribute('data-capture-id', newest['id'])
        old_row.get_by_role('button').click()
        frozen.update(task={**history['task'], 'id': 'a' * 32}, results=[], captures=[], latestCapture=None)
        expect(capture).to_have_count(0)
        frozen.update(deepcopy(history))
        expect(capture).to_have_attribute('data-capture-mode', 'latest')
        expect(capture).to_have_attribute('data-capture-id', newest['id'])
        page.unroute(monitor_route)
        page.get_by_role('button', name='停止同步', exact=True).click()
        expect(page.get_by_role('complementary', name='图谱控制台', exact=True)).to_be_visible()
        assert [canvas.get_attribute(f'data-robot-{key}') for key in ['x', 'y', 'z', 'yaw']] == offline
        page.wait_for_timeout(1000)
        assert robot_status()['activeCamera'] is None
        # The remembered-password path can reconnect to the same simulator.
        page.get_by_role('button', name='同步作业', exact=True).click()
        page.get_by_role('dialog').get_by_role('button', name='真机孪生').click()
        dialog.get_by_text('本地模拟机器人', exact=True).click()
        expect(dialog.locator('.robot-twin-success')).to_contain_text('连接成功')
        expect(dialog).not_to_be_visible(timeout=3000)
        page.get_by_role('button', name='停止同步', exact=True).click()
        assert not errors, errors
        print('Standalone fake robot UI passed: moving model, follow view, dual Zivid images/point clouds, confidence colors/red priority/late updates, history selection/latest mode, detection alarms, camera switching/expansion, password recall and offline restoration.')
    except Exception:
        page.screenshot(path=str(artifacts / 'failure.png'))
        print('Page errors:', errors)
        raise
    finally:
        browser.close()
