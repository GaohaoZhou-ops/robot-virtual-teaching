"""Nonblocking sync progress, clickable completion feedback and polling fallback."""
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
    errors, held, completion, requests = [], [], [], []
    for page in [host, peer]:
        page.set_default_timeout(30000)
        page.on('pageerror', lambda error: errors.append(str(error)))
    peer.route('**/__atlas/work-sync/capabilities', lambda route: route.fulfill(json={'local': False}))
    host.route('**/__atlas/work-sync/links/*/bootstrap', lambda route: held.append(route) if route.request.method == 'PUT' else route.continue_())
    peer.route('**/__atlas/work-sync/links/*/progress', lambda route: completion.append(route)
               if route.request.post_data_json.get('progress') == 1 else route.continue_())
    peer.on('request', lambda request: requests.append(request.url) if '/__atlas/work-sync/' in request.url else None)
    try:
        seed_host(host)
        home(host)
        expect(control(host)).to_have_attribute('data-sync-role', 'host')
        peer.goto(BASE_URL, wait_until='networkidle')
        peer.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
        for page in [host, peer]:
            page.evaluate('''() => {
              window.__syncFeedback = { states: [], overlays: [] };
              const sample = () => {
                const feedback = window.__syncFeedback;
                const button = [...document.querySelectorAll('.work-sync__trigger')].find(el => el.getClientRects().length);
                const state = button?.dataset.syncButtonState;
                if (state && feedback.states.at(-1)?.state !== state) feedback.states.push({ state, at: performance.now() });
                if (document.querySelector('.loading-curtain')) feedback.overlays.push(performance.now());
              };
              new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, attributes: true });
              sample();
            }''')
        offline(peer).get_by_role('button', name='申请离线协作', exact=True).click()
        expect(peer.locator('dialog[open]')).to_have_count(0)
        expect(offline(peer).get_by_role('button', name='等待主机授权', exact=True)).to_be_disabled()
        authorization = host.get_by_role('dialog', name='允许另一台设备同步作业？', exact=True)
        authorization.get_by_role('button', name='允许同步（5 分钟）', exact=True).click()
        deadline = time.monotonic() + 30
        while not held:
            assert time.monotonic() < deadline, 'packaging did not reach the initial snapshot upload'
            host.wait_for_timeout(50)
        expect(authorization).to_have_count(0)
        expect(control(peer)).to_have_attribute('data-sync-phase', 'preparing', timeout=8000)
        expect(peer.locator('dialog[open]')).to_have_count(0)
        for page in [host, peer]:
            button = control(page).locator('.work-sync__trigger')
            expect(button).to_be_enabled()
            expect(button).to_have_attribute('data-sync-button-state', 'progress')
            progress = button.get_by_role('progressbar', name='离线工程同步进度')
            expect(progress).to_be_visible()
            value = int(progress.get_attribute('value'))
            assert 0 <= value <= 25
            expect(button).to_contain_text(f'{value}%')
            button.click()
            expect(page.get_by_role('dialog', name='选择同步模式', exact=True)).to_be_visible()
            close_sync(page)
        expect(offline(peer).get_by_role('button', name='重新申请授权', exact=True)).to_be_disabled()
        expect(peer.locator('dialog[open] progress')).to_have_count(0)
        close_sync(peer)
        assert len([path for path in requests if path.endswith('/requests')]) == 1
        peer.screenshot(path='/tmp/atlas-ipad-sync-preparing.png')
        held[0].continue_()
        deadline = time.monotonic() + 60
        while not completion:
            assert time.monotonic() < deadline, 'project was not saved before completion acknowledgement'
            peer.wait_for_timeout(50)
        expect(peer.locator('[data-app-page="workbench"]')).to_be_visible()
        for page in [host, peer]:
            button = control(page).locator('.work-sync__trigger')
            if page is peer:
                expect(button.locator('progress')).to_have_attribute('value', '99')
            else:
                assert 75 <= int(button.locator('progress').get_attribute('value')) < 100
            expect(button).to_be_enabled()
            expect(page.locator('dialog[open], .loading-curtain')).to_have_count(0)
            button.click()
            expect(page.get_by_role('dialog', name='选择同步模式', exact=True)).to_be_visible()
            close_sync(page)
            assert not page.evaluate('window.__syncFeedback.overlays'), 'Sync import displayed a blocking loading overlay'
        peer.screenshot(path='/tmp/atlas-sync-button-saving.png')
        completion[0].continue_()
        button = control(peer).locator('.work-sync__trigger')
        expect(button).to_have_attribute('data-sync-button-state', 'complete')
        expect(button.locator('progress')).to_have_attribute('value', '100')
        expect(button.locator('.work-sync__button-check')).to_be_visible()
        assert button.locator('.work-sync__button-check path').evaluate('el => getComputedStyle(el).animationName') == 'work-sync-button-check-draw'
        button.screenshot(path='/tmp/atlas-sync-button-complete.png', animations='disabled')
        button.click()
        chooser = peer.get_by_role('dialog', name='选择同步模式', exact=True)
        expect(chooser).to_be_visible()
        expect(button).to_have_attribute('data-sync-button-state', 'idle', timeout=2000)
        expect(button).to_have_text('同步作业')
        expect(button.locator('progress, .work-sync__button-check')).to_have_count(0)
        expect(chooser).to_be_visible()
        close_sync(peer)
        expect(control(peer)).to_have_attribute('data-sync-phase', 'connected', timeout=60000)
        expect(control(peer)).to_have_attribute('data-sync-complete', 'true')
        expect(control(host)).to_have_attribute('data-sync-complete', 'true')
        assert len([path for path in requests if path.endswith('/requests')]) == 1
        expect(host.get_by_role('dialog', name='重新授权同步作业', exact=True)).to_have_count(0)
        peer.wait_for_timeout(3500)
        for page in [host, peer]:
            feedback = page.evaluate('window.__syncFeedback')
            completed = [item for item in feedback['states'] if item['state'] == 'complete']
            assert len(completed) == 1, feedback
            restored = next(item for item in feedback['states'] if item['state'] == 'idle' and item['at'] > completed[0]['at'])
            duration = restored['at'] - completed[0]['at']
            assert 900 <= duration <= 1500, duration
            assert not feedback['overlays'], feedback
            expect(control(page).locator('.work-sync__trigger')).to_be_enabled()
        assert not errors, errors
        print('Sync button UI passed: no automatic progress dialog/overlay, clickable at preparation/save/completion, 99% until save acknowledgement, animated check for 1s, no repeat on heartbeat, and blocked WebSocket recovery.')
    finally:
        host.goto('about:blank'); peer.goto('about:blank')
        browser.close()
