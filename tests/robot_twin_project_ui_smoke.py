"""Save As/export/import robot cards across clean browsers without contacting robots."""
import base64
import json
import subprocess
import tempfile
import zipfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from archive_helpers import start_project_download
from export_separation_ui_smoke import CHROME, ROOT, make_fixtures, load_project
from project_export_save_ui_smoke import SAVE_PICKER
from topbar_tools_helpers import topbar_action

KEY = 'atlas-route-studio:robot-twin-profiles-v1'
CREDENTIALS = 'atlas-route-studio:robot-twin-credentials-v1'
CONFIG = {'version': 1, 'selectedId': 'robot-beta', 'selectedIds': ['robot-beta', 'robot-alpha'], 'profiles': [
    {'id': 'robot-alpha', 'name': '装配机器人', 'address': 'http://192.168.0.112:9090', 'color': '#62c7a0'},
    {'id': 'robot-beta', 'name': '检测机器人', 'address': 'https://10.0.0.21:9443', 'color': '#6baff2'},
]}
SECRET = 'browser-only-test-password'
ARTIFACTS = ROOT / 'test-artifacts' / 'robot-twin-project'
ARTIFACTS.mkdir(parents=True, exist_ok=True)


def open_cards(page):
    page.get_by_role('button', name='同步作业', exact=True).click()
    page.get_by_role('dialog').get_by_role('button', name='真机孪生').click()
    dialog = page.get_by_role('dialog', name='真机孪生', exact=True)
    for profile in CONFIG['profiles']:
        label = profile['name'] + ' ' + profile['address'].removeprefix('http://')
        expect(dialog.get_by_role('checkbox', name=label, exact=True)).to_be_checked()
    return dialog


def inspect(path):
    with zipfile.ZipFile(path) as archive:
        configs = [name for name in archive.namelist() if name.endswith('config/project.json')]
        assert configs
        for name in configs:
            assert json.loads(archive.read(name))['robotTwin'] == CONFIG
        assert all(SECRET.encode() not in archive.read(name) for name in archive.namelist())


with tempfile.TemporaryDirectory(prefix='atlas-twin-project-') as temporary, sync_playwright() as p:
    directory = Path(temporary)
    make_fixtures(directory)
    subprocess.run(['node', '--input-type=module', '-e', r'''
      import {writeFile} from 'node:fs/promises';
      import {buildProjectArchive} from './src/features/workspace/model/projectArchive.js';
      import {projectCollectionFixture, projectCollectionOptions} from './tests/project_collection_helpers.mjs';
      import {linkedProjectFixture} from './tests/linked_project_helpers.mjs';
      const config = JSON.parse(process.argv[2]);
      const collection = await projectCollectionFixture();
      collection.workspaces.independent.config.config.project.robotTwin = config;
      const complete = await buildProjectArchive(collection.workspaces.independent.config.config.project,
        projectCollectionOptions(collection, 'independent'));
      await writeFile(`${process.argv[1]}/collection.zip`, complete.bytes);
      const pair = await linkedProjectFixture();
      pair.independent.config.config.project.robotTwin = config;
      const linked = await buildProjectArchive(pair.independent.config.config.project, {
        mapResource: pair.independent.map, existingRobotPackage: pair.independent.map.portableRobotPackage,
        linkedWorkspace: pair.map,
      });
      await writeFile(`${process.argv[1]}/linked.zip`, linked.bytes);
    ''', str(directory), json.dumps(CONFIG)], cwd=ROOT, check=True)
    browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
    errors, connections = [], []
    try:
        for mode in ['map', 'independent']:
            source = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
            page = source.new_page()
            page.set_default_timeout(60000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('**/__atlas/robot-twin/**', lambda route: (connections.append(route.request.url), route.abort()))
            load_project(page, mode, directory / f'{mode}.zip')
            page.evaluate('''({key, credentials, config, secret}) => {
              localStorage.setItem(key, JSON.stringify(config));
              localStorage.setItem(credentials, JSON.stringify({version:1, credentials:
                config.profiles.map(({id,address}) => ({id,address,password:secret}))}));
            }''', {'key': KEY, 'credentials': CREDENTIALS, 'config': CONFIG, 'secret': SECRET})
            dialog = open_cards(page)
            expect(dialog.locator('input[type=password]')).to_have_count(0)
            dialog.get_by_role('button', name='关闭同步作业', exact=True).click()

            # Real file handle behind the native Save As picker.
            page.evaluate(SAVE_PICKER)
            page.evaluate('window.__saveChoice = {name:"robot-connections.zip"}')
            topbar_action(page, name='另存为工程', exact=True).click()
            page.get_by_text('工程已保存 · robot-connections.zip', exact=False).wait_for()
            encoded = page.evaluate('''async () => {
              const file = await window.__writtenHandles.at(-1).getFile();
              return btoa(Array.from(new Uint8Array(await file.arrayBuffer()), byte => String.fromCharCode(byte)).join(''));
            }''')
            saved = directory / f'{mode}-saved.zip'
            saved.write_bytes(base64.b64decode(encoded))
            inspect(saved)

            # The teaching-data page's Export Project action uses the same config.
            topbar_action(page, name='打开示教数据管理页').click()
            with page.expect_download() as download:
                start_project_download(page, f'{mode}-exported')
            exported = directory / f'{mode}-exported.zip'
            download.value.save_as(exported)
            inspect(exported)
            source.close()

            for path in [saved, exported]:
                fresh = browser.new_context(viewport={'width': 1440, 'height': 1000})
                restored = fresh.new_page()
                restored.set_default_timeout(60000)
                restored.on('pageerror', lambda error: errors.append(str(error)))
                restored.route('**/__atlas/robot-twin/**', lambda route: (connections.append(route.request.url), route.abort()))
                load_project(restored, mode, path)
                stored = restored.evaluate('(key) => JSON.parse(localStorage.getItem(key))', KEY)
                assert stored == CONFIG, stored
                assert restored.evaluate('(key) => localStorage.getItem(key)', CREDENTIALS) is None
                dialog = open_cards(restored)
                expect(dialog.get_by_role('checkbox')).to_have_count(2)
                expect(dialog.locator('input[type=password]')).to_have_count(2)
                restored.screenshot(path=str(ARTIFACTS / f'{path.stem}-cards.png'))
                dialog.get_by_role('button', name='关闭同步作业', exact=True).click()
                restored.reload(wait_until='networkidle')
                dialog = open_cards(restored)
                expect(dialog.locator('input[type=password]')).to_have_count(2)
                fresh.close()
            print(f'{mode}: native Save As and Export Project restore both cards/ports/colors/selection in fresh browsers; passwords excluded.')
        # Both composite loaders reload the page after committing workspaces.
        # Import from the other mode to exercise that path, not just raw parsing.
        for kind in ['collection', 'linked']:
            fresh = browser.new_context(viewport={'width': 1440, 'height': 1000})
            restored = fresh.new_page()
            restored.set_default_timeout(60000)
            restored.on('pageerror', lambda error: errors.append(str(error)))
            restored.route('**/__atlas/robot-twin/**', lambda route: (connections.append(route.request.url), route.abort()))
            load_project(restored, 'map', directory / f'{kind}.zip')
            assert restored.evaluate('(key) => JSON.parse(localStorage.getItem(key))', KEY) == CONFIG
            dialog = open_cards(restored)
            expect(dialog.locator('input[type=password]')).to_have_count(2)
            fresh.close()
            print(f'{kind}: robot cards survive complete-workspace restore and automatic reload.')
        assert not errors, errors
        assert not connections, 'loading or selecting cards must not contact robots'
    finally:
        browser.close()
