import { spawn } from 'node:child_process';

const quote = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\r', '\\r').replaceAll('\n', '\\n')}"`;

// Some macOS installations cannot open LAN sockets from the Homebrew Node
// process (EHOSTUNREACH), while the system HTTP client can. Keep credentials on
// stdin, never in shell text, process arguments, temporary files or logs.
export function systemRobotFetch(url, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const config = ['silent', 'show-error', 'include', 'noproxy = "*"', 'proto = "=http,https"',
      'connect-timeout = 2', 'max-time = 3', `url = ${quote(url)}`, `request = ${quote(method)}`,
      ...Object.entries(headers).map(([key, value]) => `header = ${quote(`${key}: ${value}`)}`),
      ...(body ? [`data = ${quote(String(body))}`] : [])].join('\n');
    const child = spawn('/usr/bin/curl', ['--disable', '--config', '-'], { stdio: ['pipe', 'pipe', 'pipe'], signal });
    const chunks = []; let size = 0;
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.stderr.resume();
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024 + 16384) { child.kill(); reject(new Error('robot response too large')); }
      else chunks.push(chunk);
    });
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error('system HTTP client could not reach robot')); return; }
      try {
        const bytes = Buffer.concat(chunks), boundary = bytes.indexOf('\r\n\r\n');
        if (boundary < 0) throw new Error('invalid robot HTTP response');
        const lines = bytes.subarray(0, boundary).toString('utf8').split('\r\n');
        const status = Number(/^HTTP\/\S+ (\d{3})/.exec(lines.shift())?.[1]);
        const responseHeaders = new Headers();
        for (const line of lines) {
          const colon = line.indexOf(':');
          if (colon > 0) responseHeaders.append(line.slice(0, colon), line.slice(colon + 1).trim());
        }
        resolve(new Response(bytes.subarray(boundary + 4), { status, headers: responseHeaders }));
      } catch (error) { reject(error); }
    });
    child.stdin.end(config + '\n');
  });
}

export async function robotFetch(session, path, options) {
  const url = session.address + path;
  if (session.systemTransport) return systemRobotFetch(url, options);
  try { return await fetch(url, options); }
  catch (error) {
    if (process.platform !== 'darwin' || error.cause?.code !== 'EHOSTUNREACH') throw error;
    const response = await systemRobotFetch(url, options);
    session.systemTransport = true;
    return response;
  }
}
