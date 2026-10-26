"""Full desktop document round-trip through the real native loopback server.

Run with VISION_WORKBENCH_CONNECTION pointing to the JSON emitted by
VisionWorkbenchServerHarness; no user browser, cache or project is touched.
"""
import json
import os
import zipfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
CONNECTION = json.loads(Path(os.environ['VISION_WORKBENCH_CONNECTION']).read_text())
ARTIFACTS = ROOT / 'vision/test-artifacts/workbench'
ARTIFACTS.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    context = browser.new_context(viewport={'width': 1440, 'height': 960}, accept_downloads=True)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script('window.AtlasVision = ' + json.dumps({'native': True, 'immersive': True, 'token': CONNECTION['token']}) + ''';
      window.nativeMessages=[];
      window.webkit={messageHandlers:{atlasWorkbench:{postMessage:async (message)=>{
        nativeMessages.push(message); return message.type==='ready' ? {type:'resume',generation:7} : true;
      }}}};
      // Match WebKit's file export capabilities, not Chrome's file picker API.
      window.showSaveFilePicker=undefined;
    ''')
    base = CONNECTION['origin']
    imported = '/__atlas/vision-native/imports/' + CONNECTION['importID']
    assert page.request.get(base + imported).status == 401
    assert page.request.get(base + imported, headers={'Origin': 'https://example.com'}).status == 403
    assert page.request.get(base + '/__atlas/work-sync/capabilities').json()['local'] is False
    assert page.request.get(base + '/%2e%2e/Info.plist').status == 404
    page.goto(base + '/workbench')
    page.wait_for_load_state('networkidle')
    page.locator('[data-session-state="ready"]').wait_for(state='attached')
    assert '工程' in page.get_by_role('button', name='工程菜单').inner_text()
    page.evaluate('(detail)=>window.dispatchEvent(new CustomEvent("atlas-vision-command", {detail}))',
                  {'type': 'import', 'id': CONNECTION['importID'], 'name': 'workbench.zip'})
    expect(page.locator('.map-identity')).to_contain_text('完整工作台演练.ply', timeout=45000)
    page.locator('.loading-curtain').wait_for(state='hidden')
    create = page.get_by_role('button', name='新建示教任务', exact=True)
    expect(create).to_be_enabled(timeout=30000)
    expect(page.get_by_role('button', name='打开全关节浮动窗口')).to_be_enabled()
    page.wait_for_function('nativeMessages.filter(m=>m.type==="openScene").length===1', timeout=60000)
    first_scene = page.evaluate('nativeMessages.find(m=>m.type==="openScene")')
    assert first_scene['generation'] == 7 and first_scene['revision']
    assert first_scene['manifest']['robotRoot'], 'Automatic entry must wait for the imported robot'
    page.locator('.vision-workbench-notice').wait_for(state='hidden')
    page.screenshot(path=str(ARTIFACTS / 'full-workbench.png'), full_page=True)
    create.click()
    dialog = page.get_by_role('dialog', name='新建示教任务', exact=True)
    expect(dialog).to_be_visible()
    dialog.get_by_role('textbox', name='新示教任务名称').fill('Vision Pro 本机编辑')
    print('Task actions:', dialog.get_by_role('button').all_text_contents(), flush=True)
    dialog.get_by_role('button', name='创建任务', exact=True).click()
    expect(dialog).not_to_be_visible()
    # Exercise the native scene bridge with the real robot loader, geometry
    # conversion, native disk upload validation, and complete task snapshot.
    page.evaluate('window.dispatchEvent(new CustomEvent("atlas-vision-command", {detail:{type:"scene"}}))')
    page.wait_for_function('nativeMessages.filter(m=>m.type==="openScene").length===2', timeout=60000)
    second_scene = page.evaluate('nativeMessages.filter(m=>m.type==="openScene").at(-1)')
    assert second_scene['revision'] != first_scene['revision'], 'Edits must mark the native scene outdated'
    scene = second_scene['manifest']
    assert scene['robotRoot'] and len(scene['assets']) >= 4
    assert len([node for node in scene['nodes'] if node.get('joint')]) == 3
    assert scene['clips'], 'Saved robot motion must reach the spatial scene'
    page.locator('.vision-workbench-notice').wait_for(state='hidden')
    with page.expect_download(timeout=60000) as pending:
        page.evaluate('window.dispatchEvent(new CustomEvent("atlas-vision-command", {detail:{type:"save"}}))')
    output = ARTIFACTS / 'edited-project.zip'
    pending.value.save_as(str(output))
    with zipfile.ZipFile(output) as archive:
        config = json.loads(archive.read('config/project.json'))
        tasks = config['virtualTeaching']['tasks']
        assert any(task['name'] == 'Vision Pro 本机编辑' for task in tasks)
        assert any(task['name'] == '检查动作' for task in tasks)
        assert any(name.endswith('robot.urdf') for name in archive.namelist())
        assert 'environment/positions.f32le' in archive.namelist()
    # Leave while conversion is uploading geometry. A late export must never
    # reopen an immersive project after the user has returned to the gateway.
    uploads = []
    page.route('**/__atlas/vision-native/assets/*', lambda route: uploads.append(route))
    with page.expect_request('**/__atlas/vision-native/assets/*'):
        page.evaluate('window.dispatchEvent(new CustomEvent("atlas-vision-command", {detail:{type:"scene"}}))')
    page.evaluate('window.dispatchEvent(new CustomEvent("atlas-vision-command", {detail:{type:"home",generation:8}}))')
    page.wait_for_function('nativeMessages.some(m=>m.type==="home")')
    assert page.evaluate('nativeMessages.filter(m=>m.type==="openScene").length') == 2
    for route in uploads:
        try: route.abort()
        except Exception: pass  # AbortController may already have canceled it.
    page.unroute('**/__atlas/vision-native/assets/*')
    page.reload()
    page.locator('[data-session-state="ready"]').wait_for(state='attached')
    expect(page.locator('.map-identity')).to_contain_text('完整工作台演练.ply', timeout=30000)
    expect(page.locator('body')).to_contain_text('Vision Pro 本机编辑')
    expect(page.get_by_role('button', name='新建示教任务', exact=True)).to_be_enabled(timeout=30000)
    page.wait_for_function('nativeMessages.filter(m=>m.type==="openScene").length===1', timeout=60000)
    assert page.evaluate('nativeMessages.find(m=>m.type==="openScene").manifest.clips.length') > 0
    assert not errors, errors
    browser.close()
print('Vision workbench: automatic immersive import/reload, canceled scene launch, scene revision, native isolation, robot hierarchy, task editing and ZIP round-trip passed.')
