"""Exercise actual worker JPEGs, concurrent camera channels and browser fallback."""
import os
from playwright.sync_api import sync_playwright


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or None)
    page = browser.new_page()
    page.route('**/__encoder_test', lambda route: route.fulfill(content_type='text/html', body='<!doctype html><title>JPEG test</title>'))
    page.goto(os.environ.get('BASE_URL', 'http://127.0.0.1:21992') + '/__encoder_test')
    result = page.evaluate('''async () => {
      const {createScreenJPEGEncoder} = await import('/src/lib/ipadScreenEncoder.js');
      const check = (value, message) => { if (!value) throw new Error(message); };
      const canvas = color => {
        const result = document.createElement('canvas'); result.width = 960; result.height = 600;
        const context = result.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 960, 600);
        return result;
      };
      const verify = async (blob, component) => {
        check(blob.type === 'image/jpeg', 'JPEG type');
        const bitmap = await createImageBitmap(blob);
        check(bitmap.width === 960 && bitmap.height === 600, 'Dimensions must stay unchanged');
        const output = canvas('#000'); output.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
        const pixel = output.getContext('2d').getImageData(480, 300, 1, 1).data;
        check(pixel[component] > 240 && pixel[(component + 1) % 3] < 15, 'Camera channels must not mix pixels');
      };
      const encoder = createScreenJPEGEncoder();
      const red = canvas('#f00'), green = canvas('#0f0'), blue = canvas('#00f');
      // A successful test must use the worker, not silently fall back to toBlob.
      for (const source of [red, green, blue]) source.toBlob = () => { throw new Error('Unexpected worker fallback'); };
      const images = await Promise.all([encoder.encode(red, 'left'), encoder.encode(green, 'right'), encoder.encode(blue, 'viewport')]);
      await Promise.all(images.map((blob, index) => verify(blob, index)));
      const pending = encoder.encode(red, 'left').then(() => false, error => error.name === 'AbortError');
      encoder.dispose(); check(await pending, 'Stopping must cancel a pending frame');
      check(await encoder.encode(red, 'left').then(() => false, error => error.name === 'AbortError'), 'Disposed encoder must reject');
      const Worker = window.Worker;
      try {
        window.Worker = undefined;
        const fallback = createScreenJPEGEncoder();
        await verify(await fallback.encode(canvas('#f00'), 'left'), 0); fallback.dispose();
        window.Worker = class { postMessage() { throw new Error('Worker unavailable'); } terminate() {} };
        const broken = createScreenJPEGEncoder();
        await verify(await broken.encode(canvas('#0f0'), 'right'), 1); broken.dispose();
      } finally { window.Worker = Worker; }
      return 'Worker JPEG pixels/dimensions, concurrent channels, cancellation and unsupported/failed worker fallback passed.';
    }''')
    print(result)
    browser.close()
