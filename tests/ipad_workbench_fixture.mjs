// Disposable WebKit/browser fixture. Uses the real workbench and service on a
// separate port; never reads or replaces a user's browser workspace.
import { createServer } from 'vite';
import { WebSocketServer } from 'ws';

const port = Number(process.env.IPAD_WORKBENCH_TEST_PORT || 22076);
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{background:#071014;color:#e4edeb;font:20px system-ui;padding:30px}button,input{font:inherit;margin:10px;padding:14px}output{display:block;margin:16px}</style>
<header style="display:flex;align-items:center;gap:20px"><button id="return" aria-label="虚拟示教平台，返回应用">‹ 虚拟示教平台</button><h1>iPad 完整工作台验证</h1></header><output id="capabilities">正在检查浏览器能力</output>
<output id="selection" style="position:fixed;bottom:8px;right:8px;background:#071014">界面误选：0</output>
<div id="gesture" role="group" aria-label="手势验证区" style="padding:20px;background:#19353b;touch-action:none">长按并拖动此处</div><output id="dragged"></output>
<label>验证工程名<input aria-label="验证工程名" id="name" value="iPad 本机工程"></label>
<button id="save">保存验证工程</button><output id="saved"></output>
<button id="confirm">验证确认对话框</button><output id="confirmed"></output>
<button id="download">导出验证工程</button>
<button id="reload">重新加载验证页面</button>
<label>导入验证文件<input aria-label="导入验证文件" type="file" id="file"></label><output id="imported"></output>
<button id="workbench">打开实际示教工程</button>
<button id="library">准备两个离线工程</button>
<script type="module">
import { teachingTransferFixture } from '/tests/teaching_transfer_helpers.mjs';
import * as store from '/src/features/workspace/model/sessionStore.js';
import { returnToIPadApp } from '/src/features/devices/model/ipadWorkbenchLibrary.js';
document.querySelector('#return').onclick=returnToIPadApp;
document.querySelector('#reload').onclick=()=>location.reload();
const field = document.querySelector('#name');
let unintendedSelections = 0;
document.addEventListener('selectionchange', () => {
  if (!document.activeElement.matches('input, textarea, [contenteditable]') && window.getSelection().toString()) {
    document.querySelector('#selection').textContent = '界面误选：' + (++unintendedSelections);
  }
});
let dragStart;
const gesture = document.querySelector('#gesture');
gesture.onpointerdown = event => { dragStart = [event.clientX, event.clientY]; };
gesture.onpointercancel = () => { dragStart = null; };
gesture.onpointerup = event => {
  if (dragStart && Math.hypot(event.clientX - dragStart[0], event.clientY - dragStart[1]) > 30) {
    document.querySelector('#dragged').textContent = '拖动成功';
  }
  dragStart = null;
};
const db = await new Promise((resolve,reject) => {
  const request=indexedDB.open('atlas-ipad-native-fixture',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('projects');
  request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
});
const read=()=>new Promise(resolve=>{
  const request=db.transaction('projects').objectStore('projects').get('name');
  request.onsuccess=()=>resolve(request.result);
});
const saved=await read(); if(saved){field.value=saved;document.querySelector('#saved').textContent='已读取：'+saved;}
document.querySelector('#save').onclick=()=>{
  const transaction=db.transaction('projects','readwrite');transaction.objectStore('projects').put(field.value,'name');
  transaction.oncomplete=()=>document.querySelector('#saved').textContent='已保存：'+field.value;
};
document.querySelector('#confirm').onclick=()=>document.querySelector('#confirmed').textContent=confirm('确认保存验证工程？')?'确认成功':'已取消';
document.querySelector('#download').onclick=()=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify({fixture:'atlas-ipad-workbench',name:field.value})],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='atlas-ipad-fixture.json';document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),0);
};
document.querySelector('#file').onchange=async(event)=>document.querySelector('#imported').textContent=await event.target.files[0].text();
document.querySelector('#workbench').onclick=async()=>{
  const fixture=teachingTransferFixture('map');const {sessionId}=await store.fetchServiceSession();
  await store.saveWorkspaceMap(sessionId,fixture.map.mapId,fixture.map.name,fixture.map,'map');
  await store.saveWorkspaceConfig(sessionId,fixture.map.mapId,fixture.config.config,'map');
  await store.activateWorkspaceMode(sessionId,'map');location.assign('/workbench');
};
document.querySelector('#library').onclick=async()=>{
  const identity=await store.fetchServiceSession();
  const {sessionId}=await store.prepareWorkspaceSession(identity.sessionId, {preserveExisting:true});
  for (const letter of ['A','B']) {
    const fixture=teachingTransferFixture('map');
    fixture.map.mapId='ipad-library-'+letter;fixture.map.name='离线工程'+letter+'.ply';
    fixture.config.mapId=fixture.map.mapId;
    fixture.config.config.project.map.fileName=fixture.map.name;
    fixture.config.config.project.virtualTeaching.tasks[0].name='工程'+letter+'的任务';
    await store.saveWorkspaceMap(sessionId,fixture.map.mapId,fixture.map.name,fixture.map,'map');
    await store.saveWorkspaceConfig(sessionId,fixture.map.mapId,fixture.config.config,'map');
    await store.saveIPadProjectLibrary(sessionId);
  }
  location.assign('/workbench');
};
const workerURL=URL.createObjectURL(new Blob(['onmessage=event=>postMessage(event.data*2)'],{type:'application/javascript'}));
await new Promise((resolve,reject)=>{const worker=new Worker(workerURL);worker.onmessage=event=>{worker.terminate();event.data===42?resolve():reject();};worker.onerror=reject;worker.postMessage(21);});
URL.revokeObjectURL(workerURL);
if(!document.createElement('canvas').getContext('webgl2'))throw new Error('WebGL2 unavailable');
await new Promise((resolve,reject)=>{const socket=new WebSocket(location.origin.replace('http','ws')+'/__fixture__/socket');socket.onopen=()=>socket.send('atlas');socket.onmessage=event=>{socket.close();event.data==='atlas'?resolve():reject();};socket.onerror=reject;});
document.querySelector('#capabilities').textContent='能力检查通过：WebGL / Worker / WebSocket / IndexedDB';
</script></html>`;

const server = await createServer({ server: { host: '0.0.0.0', port, strictPort: true },
  plugins: [{ name: 'ipad-native-workbench-fixture', enforce: 'pre', configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (req.url !== '/') return next();
      try {
        const page = await vite.transformIndexHtml('/', html);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });res.end(page);
      } catch (error) { next(error); }
    });
  } }],
});
const sockets = new WebSocketServer({ noServer: true });
sockets.on('connection', socket => socket.on('message', value => socket.send(value.toString())));
server.httpServer.on('upgrade', (req, socket, head) => {
  if (req.url === '/__fixture__/socket') sockets.handleUpgrade(req, socket, head, client => sockets.emit('connection', client));
});
await server.listen();
console.log(`iPad WebKit fixture ready on port ${port}`);
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => { sockets.close(); await server.close(); process.exit(0); });
