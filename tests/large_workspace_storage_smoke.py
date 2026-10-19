"""Regression for the real project's geometry + robot exceeding one IDB value."""
import os
from playwright.sync_api import sync_playwright


BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:21990').rstrip('/')
CHROME = os.environ.get('CHROME_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME)
        try:
            page = browser.new_page()
            # A blank page isolates storage operations from the app's autosave.
            page.route('**/storage-test', lambda route: route.fulfill(
                content_type='text/html', body='<html>Workspace storage regression</html>'))
            page.goto(BASE + '/storage-test')
            page.evaluate('''async () => {
              const s = await import('/src/lib/sessionStore.js');
              await s.prepareWorkspaceSession('large-workspace');
              const positions = new Uint8Array(90 * 1024 * 1024);
              positions[0] = 17; positions[positions.length - 1] = 29;
              // A view with an offset must persist only the view's bytes.
              const mesh = new Uint8Array(74 * 1024 * 1024 + 2);
              mesh[1] = 31; mesh[mesh.length - 2] = 43;
              const map = {geometryCacheVersion: 1, positionBuffer: positions.buffer,
                colorBuffer: new Uint8Array([3, 7]).buffer,
                indexBuffer: new Uint32Array([0, 1, 2]).buffer,
                sourceBlob: new Blob(['original geometry']),
                portableRobotPackage: {relativePath: 'robot.bin',
                  files: [{path: 'robot.bin', bytes: mesh.subarray(1, -1)}]}};
              await s.saveWorkspaceMap('large-workspace', 'large-map', 'large.ply', map, 'independent');
              await s.saveWorkspaceConfig('large-workspace', 'large-map', {
                project: {workspace: {teachingSpaceMode: 'independent'},
                  virtualTeaching: {tasks: [{id: 'imported-task', mobileSolve: {version: 3, feasibleCount: 16}}]}}},
                'independent');
              // Existing small ArrayBuffer records remain supported.
              await s.saveWorkspaceMap('large-workspace', 'small-map', 'small.ply',
                {positionBuffer: new Float32Array([1, 2, 3]).buffer}, 'map');
              const small = await s.loadWorkspaceSnapshot('large-workspace', 'map');
              if (new Float32Array(small.map.positionBuffer)[2] !== 3) throw Error('legacy buffer lost');
              await s.activateWorkspaceMode('large-workspace', 'independent');
            }''')
            page.reload()
            result = page.evaluate('''async () => {
              const s = await import('/src/lib/sessionStore.js');
              const verify = async ({map, config}) => {
                const positions = new Uint8Array(map.positionBuffer);
                const mesh = new Uint8Array(map.portableRobotPackage.files[0].bytes);
                if (positions.length !== 90 * 1024 * 1024 || positions[0] !== 17 || positions.at(-1) !== 29)
                  throw Error('geometry bytes changed');
                if (mesh.length !== 74 * 1024 * 1024 || mesh[0] !== 31 || mesh.at(-1) !== 43)
                  throw Error('robot mesh bytes changed');
                if (new Uint8Array(map.colorBuffer)[1] !== 7 || new Uint32Array(map.indexBuffer)[2] !== 2)
                  throw Error('color or triangle bytes changed');
                if (await map.sourceBlob.text() !== 'original geometry') throw Error('source file changed');
                if (config.config.project.virtualTeaching.tasks[0].mobileSolve.feasibleCount !== 16)
                  throw Error('calculation report lost');
              };
              await verify(await s.prepareWorkspaceSession('large-workspace'));
              await verify(await s.loadWorkspaceSnapshot('large-workspace', 'independent'));
              // A service restart archives the packed record; recovery must not
              // serialize its large buffers inline again.
              const restarted = await s.prepareWorkspaceSession('next-workspace');
              if (!restarted.recovery?.available) throw Error('recovery missing');
              await s.activateWorkspaceRecovery('next-workspace', 'independent');
              await verify(await s.prepareWorkspaceSession('next-workspace'));
              const source = await s.loadWorkspaceSnapshot('next-workspace', 'independent');
              const target = await s.loadWorkspaceSnapshot('next-workspace', 'map');
              await s.commitWorkspaceTransfer('next-workspace', source, target, {
                mode: 'map', map: {...source.map, mapId: 'transferred-map', teachingSpaceMode: 'map'},
                config: source.config.config});
              await verify(await s.loadWorkspaceSnapshot('next-workspace', 'map'));
              return {inlineBytesBeforeFix: 164 * 1024 * 1024, restoredReportCount: 16};
            }''')
            print('Large workspace import storage, reload, recovery and transfer passed:', result)
        finally:
            browser.close()


if __name__ == '__main__':
    run()
