"""Initial project progress and direct transition to the loopback fake robot."""
import json
import os
import time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect
from work_sync_ui_smoke import BASE_URL, MODE, CHROME, seed_host, control, offline, close_sync, snapshot

ROBOT = os.environ.get('FAKE_ROBOT_ADDRESS', '127.0.0.1:9090')
with urlopen(f'http://{ROBOT}/__fake_robot/status', timeout=3) as response:
    assert json.load(response)['service'] == 'atlas-fake-robot', 'Only use the local simulator.'
artifacts = Path(__file__).resolve().parents[1] / 'test-artifacts' / 'work-sync'
artifacts.mkdir(parents=True, exist_ok=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path=str(CHROME) if CHROME.exists() else None)
    host = browser.new_context(viewport={'width': 1440, 'height': 1000}).new_page()
    peer = browser.new_context(viewport={'width': 1440, 'height': 1000}).new_page()
    errors, bundle, completion, requests = [], [], [], []
    for page in [host, peer]:
        page.set_default_timeout(30000)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('dialog', lambda dialog: (errors.append(f'Unexpected confirmation: {dialog.message}'), dialog.dismiss()))
    peer.route('**/__atlas/work-sync/capabilities', lambda route: route.fulfill(json={'local': False}))
    peer.route('**/__atlas/work-sync/links/*/bundle', lambda route: bundle.append(route) if route.request.method == 'GET' else route.continue_())
    def hold_completion(route):
        if route.request.post_data_json.get('progress') == 1:
            completion.append(route)
        else:
            route.continue_()
    peer.route('**/__atlas/work-sync/links/*/progress', hold_completion)
    peer.on('request', lambda request: requests.append(request.url))
    try:
        seed_host(host)
        expect(control(host)).to_have_attribute('data-sync-role', 'host')
        peer.goto(BASE_URL, wait_until='networkidle')
        peer.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
        offline(peer).get_by_role('button', name='申请离线协作', exact=True).click()
        close_sync(peer)
        authorization = host.get_by_role('dialog', name='允许另一台设备同步作业？', exact=True)
        authorization.get_by_role('button', name='允许同步（5 分钟）', exact=True).click()
        deadline = time.monotonic() + 60
        while not bundle:
            assert time.monotonic() < deadline, 'Waiting for project download'
            peer.wait_for_timeout(50)
        for page in [host, peer]:
            expect(control(page)).to_have_attribute('data-sync-complete', 'false')
            expect(control(page).get_by_role('progressbar', name='离线工程同步进度')).to_have_attribute('value', '50')
        peer.get_by_role('button', name='同步作业', exact=True).click()
        chooser = peer.get_by_role('dialog', name='选择同步模式', exact=True)
        expect(chooser.get_by_role('button', name='真机孪生')).to_be_disabled()
        expect(chooser.get_by_role('progressbar', name='离线工程同步进度')).to_have_attribute('value', '50')
        peer.screenshot(path=str(artifacts / 'project-transferring.png'))
        bundle[0].continue_()
        deadline = time.monotonic() + 60
        while not completion:
            assert time.monotonic() < deadline, 'Waiting for saved project acknowledgement'
            peer.wait_for_timeout(50)
        expect(control(peer)).to_have_attribute('data-sync-complete', 'false')
        if not chooser.is_visible():
            peer.get_by_role('button', name='同步作业', exact=True).click()
        expect(chooser.get_by_role('button', name='真机孪生')).to_be_disabled()
        expect(chooser.get_by_role('progressbar', name='离线工程同步进度')).to_have_attribute('value', '99')
        completion[0].continue_()
        for page in [host, peer]:
            expect(control(page)).to_have_attribute('data-sync-complete', 'true')
        expect(chooser.get_by_role('progressbar', name='离线工程同步进度')).to_have_attribute('value', '100')
        expect(chooser.get_by_role('button', name='真机孪生')).to_be_enabled()
        peer.screenshot(path=str(artifacts / 'project-complete.png'))
        saved = snapshot(peer, MODE)
        chooser.get_by_role('button', name='真机孪生').click()
        twin = peer.get_by_role('dialog', name='真机孪生', exact=True)
        expect(twin.get_by_text('请先结束离线协作或等待中的授权申请。', exact=True)).to_have_count(0)
        twin.get_by_role('checkbox', name='ABX 机器人 192.168.0.112:9090', exact=True).uncheck()
        twin.get_by_role('button', name='添加机器人', exact=True).click()
        twin.get_by_label('机器人名称', exact=True).fill('离线同步后连接模拟器')
        twin.get_by_label('机器人地址', exact=True).fill(ROBOT)
        twin.get_by_role('button', name='保存机器人', exact=True).click()
        twin.get_by_label('管理员密码', exact=True).fill('admin')
        expect(twin.get_by_role('button', name='连接并同步', exact=True)).to_be_enabled()
        twin.get_by_role('button', name='连接并同步', exact=True).click()
        expect(twin.locator('.robot-twin-success')).to_contain_text('连接成功')
        expect(twin).not_to_be_visible(timeout=5000)
        expect(control(peer)).to_have_attribute('data-twin-phase', 'live')
        expect(control(host)).to_have_attribute('data-sync-phase', 'idle')
        disconnect_at = next(index for index, url in enumerate(requests) if '/work-sync/links/' in url and url.endswith('/disconnect'))
        connect_at = next(index for index, url in enumerate(requests) if url.endswith('/robot-twin/sessions'))
        assert disconnect_at < connect_at, 'Stop collaboration before starting the robot reader'
        assert snapshot(peer, MODE)['project']['virtualTeaching'] == saved['project']['virtualTeaching']
        peer.get_by_role('button', name='停止同步', exact=True).click()
        expect(peer.get_by_role('complementary', name='图谱控制台', exact=True)).to_be_visible()
        assert snapshot(peer, MODE)['mapId'] == saved['mapId']
        peer.get_by_role('button', name='同步作业', exact=True).click()
        chooser.get_by_role('button', name='真机孪生').click()
        twin.get_by_role('button', name='连接并同步', exact=True).click()
        expect(twin.locator('.robot-twin-success')).to_contain_text('连接成功')
        expect(twin).not_to_be_visible(timeout=5000)
        peer.get_by_role('button', name='停止同步', exact=True).click()
        assert not errors, errors
        print('Work sync to twin passed: transfer progress, save acknowledgement, 100% completion, direct mode switch, no confirmation, retained project and fake robot connection.')
    except Exception:
        host.screenshot(path=str(artifacts / 'host-failure.png'))
        peer.screenshot(path=str(artifacts / 'peer-failure.png'))
        print('Page errors:', errors)
        raise
    finally:
        host.goto('about:blank'); peer.goto('about:blank'); browser.close()
