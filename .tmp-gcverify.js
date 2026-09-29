// 临时脚本：验证统计请求真的发出去了（并检查本地 file:// 会被跳过）
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const LIVE_URL = 'https://sulfide2085.github.io/vtt-to-lrc/';
const LOCAL_URL = 'file:///D:/pyitme/vtt-to-lrc/index.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
    constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.handlers = new Map(); }
    async connect() {
        this.socket = new WebSocket(this.url);
        await new Promise((res, rej) => { this.socket.onopen = res; this.socket.onerror = () => rej(new Error('ws fail')); });
        this.socket.onmessage = e => {
            const m = JSON.parse(e.data);
            if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
            (this.handlers.get(m.method) || []).forEach(h => h(m.params));
        };
    }
    send(method, params = {}) { const id = this.nextId++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); }
    on(m, h) { if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(h); }
    once(m) { return new Promise(res => { const h = p => { this.handlers.set(m, this.handlers.get(m).filter(x => x !== h)); res(p); }; this.on(m, h); }); }
}

async function openAndWatch(cdp, url, label) {
    const requests = [];

    const handler = params => {
        if (params.request && params.request.url.includes('goatcounter')) {
            requests.push(params.request.url);
        }
        if (params.type === 'Image' || (params.request && params.request.url.includes('goatcounter'))) {
            requests.push(`[${params.type}] ${params.request.url}`);
        }
    };

    cdp.handlers.set('Network.requestWillBeSent', [handler]);
    cdp.handlers.set('Network.loadingFinished', []);

    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url });
    await loaded;
    await sleep(4000);

    console.log(`\n=== ${label} ===`);
    console.log(`页面：${url}`);
    const hits = requests.filter(r => r.includes('goatcounter'));
    if (hits.length === 0) {
        console.log('  → 没有向 GoatCounter 发请求（已被跳过）');
    } else {
        hits.forEach(h => console.log('  → ' + h));
    }
    return hits;
}

async function main() {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtt-gc-'));
    const browser = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--allow-file-access-from-files', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: 'ignore' });

    const portFile = path.join(userDataDir, 'DevToolsActivePort');
    let port = null;
    for (let i = 0; i < 150 && !port; i++) { if (fs.existsSync(portFile)) { port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim(); break; } await sleep(100); }

    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const cdp = new Cdp(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    const localHits = await openAndWatch(cdp, LOCAL_URL, '本地 file:// 打开');
    const liveHits = await openAndWatch(cdp, LIVE_URL, '线上 HTTPS 打开');

    console.log('\n=== 结论 ===');
    console.log(`本地 file:// 上报次数：${localHits.length}（期望 0，count.js 自动跳过 localfile）`);
    console.log(`线上 HTTPS 上报次数：${liveHits.length}（期望 ≥1，说明统计已生效）`);

    const countHits = liveHits.filter(h => h.includes('/count'));
    console.log(`其中 /count 采集请求：${countHits.length}`);

    cdp.socket.close();
    browser.kill();
    await sleep(300);
    fs.rmSync(userDataDir, { recursive: true, force: true });
}

main().catch(e => { console.error('出错:', e); process.exit(1); });
