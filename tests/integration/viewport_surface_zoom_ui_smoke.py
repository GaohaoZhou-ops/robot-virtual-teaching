"""Zoom into a placed workpiece past an empty-space pivot without a dead zone."""
import io
import json
import math
import os
from pathlib import Path

from PIL import Image
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / 'test-artifacts/viewport-surface-zoom'
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:22279').rstrip('/')


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get(
            'PLAYWRIGHT_CHROMIUM_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            page.goto(BASE, wait_until='networkidle')
            page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
            page.evaluate('''async () => {
                const { viewportSurfaceZoomFixture } = await import('/tests/fixtures/viewport_surface_zoom_fixture.mjs');
                const store = await import('/src/features/workspace/model/sessionStore.js');
                const { sessionId } = await store.fetchServiceSession();
                const fixture = await viewportSurfaceZoomFixture();
                await store.saveWorkspaceMap(sessionId, fixture.map.mapId, fixture.map.name, fixture.map, 'map');
                await store.saveWorkspaceConfig(sessionId, fixture.map.mapId, fixture.config, 'map');
                await store.activateWorkspaceMode(sessionId, 'map');
            }''')
            page.goto(BASE + '/workbench', wait_until='networkidle')
            page.locator('.loading-curtain').wait_for(state='hidden')
            canvas = page.get_by_label('三维点云交互画布', exact=True)
            expect(canvas).to_have_attribute('data-ply-mesh-visible', 'true')
            expect(canvas).to_have_attribute('data-placed-object-point-count', '6561')
            expect(canvas).to_have_attribute('data-color-mode', 'source')
            box = canvas.bounding_box()
            page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)

            def state():
                d = canvas.evaluate('el => ({...el.dataset})')
                surface_distance = 5 - float(d['cameraY'])
                zoom = float(d['opticalZoom'])
                return {'distance': float(d['cameraDistance']), 'surfaceDistance': surface_distance,
                        'near': float(d['cameraNear']), 'zoom': zoom,
                        'scale': zoom / surface_distance,
                        'target': [float(d['target' + a]) for a in 'XYZ']}

            before = state()
            samples, fragments = [], []
            for step in range(36):
                page.mouse.wheel(0, -120)
                page.wait_for_function('old => Number(document.querySelector(".three-canvas").dataset.effectiveCameraDistance) !== old',
                                       arg=before['distance'] / before['zoom'])
                page.wait_for_timeout(45)
                after = state()
                after['magnification'] = after['scale'] / before['scale']
                samples.append(after)
                if step in (12, 24, 29, 35):
                    screenshot = canvas.screenshot(path=str(ARTIFACTS / f'zoom-{step + 1}.png'))
                    image = Image.open(io.BytesIO(screenshot)).convert('RGB')
                    width, height = image.size
                    region = image.crop((width // 3, height // 3, width * 2 // 3, height * 2 // 3))
                    pixels = region.tobytes()
                    fragments.append(sum(r > b * 1.5 and r > 90 for r, b in zip(pixels[0::3], pixels[2::3]))
                                     / (region.width * region.height))
                before = after
            (ARTIFACTS / 'samples.json').write_text(json.dumps({'samples': samples, 'redFragments': fragments}, indent=2))
            assert min(s['magnification'] for s in samples) > 1.08, samples
            assert max(fragments) < 0.01, fragments
            assert all(s['surfaceDistance'] > s['near'] > 0 for s in samples), samples
            assert all(math.isfinite(s['scale']) for s in samples)
            expect(canvas).to_have_attribute('data-zoom-anchor-pick-count', '1')
            assert not errors, errors
            print('PASS: placed workpiece zoom stays responsive, avoids surface clipping and has no depth fragments', flush=True)
        finally:
            context.close()
            browser.close()


if __name__ == '__main__':
    run()
