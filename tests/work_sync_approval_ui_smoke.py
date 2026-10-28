"""Consent/progress without another click, with the peer notification channel blocked."""
import time
from playwright.sync_api import expect, sync_playwright
from work_sync_ui_smoke import BASE_URL, CHROME, seed_host, home, offline, close_sync, control

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, **({'executable_path': str(CHROME)} if CHROME.exists() else {}))
    host_context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    peer_context = browser.new_context(viewport={'width': 1194, 'height': 834}, has_touch=True, is_mobile=True)
    peer_context.add_init_script('''const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(url, protocols) {
          if (String(url).includes('/__atlas/work-sync/events')) throw new DOMException('Fixture blocks notifications', 'SecurityError');
          super(url, protocols);
        }
      };''')
    host, peer = host_context.new_page(), peer_context.new_page()
    errors, held, requests = [], [], []
    for page in [host, peer]:
        page.set_default_timeout(30000)
        page.on('pageerror', lambda error: errors.append(str(error)))
    peer.route('**/__atlas/work-sync/capabilities', lambda route: route.fulfill(json={'local': False}))
    host.route('**/__atlas/work-sync/links/*/bootstrap', lambda route: held.append(route) if route.request.method == 'PUT' else route.continue_())
    peer.on('request', lambda request: requests.append(request.url) if '/__atlas/work-sync/' in request.url else None)
    try:
        seed_host(host)
        home(host)
        expect(control(host)).to_have_attribute('data-sync-role', 'host')
        peer.goto(BASE_URL, wait_until='networkidle')
        peer.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
        offline(peer).get_by_role('button', name='申请离线协作', exact=True).click()
        expect(offline(peer).get_by_role('button', name='等待主机授权', exact=True)).to_be_disabled()
        authorization = host.get_by_role('dialog', name='允许另一台设备同步作业？', exact=True)
        authorization.get_by_role('button', name='允许同步（5 分钟）', exact=True).click()
        deadline = time.monotonic() + 30
        while not held:
            assert time.monotonic() < deadline, 'packaging did not reach the initial snapshot upload'
            host.wait_for_timeout(50)
        expect(authorization).to_have_count(0)
        expect(control(peer)).to_have_attribute('data-sync-phase', 'preparing', timeout=8000)
        expect(offline(peer).get_by_role('button', name='重新申请授权', exact=True)).to_be_disabled()
        progress = peer.get_by_role('dialog', name='离线协作', exact=True).get_by_role('progressbar', name='离线工程同步进度')
        expect(progress).to_be_visible()
        assert 0 <= int(progress.get_attribute('value')) <= 25
        assert len([path for path in requests if path.endswith('/requests')]) == 1
        peer.screenshot(path='/tmp/atlas-ipad-sync-preparing.png')
        held[0].continue_()
        expect(control(peer)).to_have_attribute('data-sync-phase', 'connected', timeout=60000)
        expect(control(peer)).to_have_attribute('data-sync-complete', 'true')
        expect(control(host)).to_have_attribute('data-sync-complete', 'true')
        assert len([path for path in requests if path.endswith('/requests')]) == 1
        expect(host.get_by_role('dialog', name='重新授权同步作业', exact=True)).to_have_count(0)
        close_sync(peer)
        assert not errors, errors
        print('Sync approval UI passed: one request, immediate preparation feedback, disabled duplicate requests, blocked WebSocket recovery and automatic transfer completion.')
    finally:
        browser.close()
