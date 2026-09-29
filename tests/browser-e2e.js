/**
 * 浏览器端到端测试：用真实 Chrome 驱动真实页面
 *
 *   node tests/browser-e2e.js
 *   node tests/browser-e2e.js https://sulfide2085.github.io/vtt-to-lrc/   # 直接测线上站点
 *
 * 覆盖：
 *   1. 页面加载后 WavToMp3 / lamejs / JSZip 是否就绪
 *   2. 「WAV 转 MP3」标签页：选文件 → 点按钮 → 真的下载出一个 MP3，并校验帧头
 *   3. ZIP 模式：包内 WAV 自动转码为 MP3，LRC 与 MP3 同名，重名不覆盖
 *
 * 找不到 Chrome 时自动跳过（退出码 0）。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const LOCAL_URL = `file:///${path.join(PROJECT_ROOT, 'index.html').replace(/\\/g, '/')}`;
const TARGET_URL = process.argv[2] || LOCAL_URL;

const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function findBrowser() {
    return CHROME_CANDIDATES.find(candidate => {
        try {
            return fs.statSync(candidate).isFile();
        } catch {
            return false;
        }
    });
}

/** 极简 CDP 客户端 */
class Cdp {
    constructor(url) {
        this.url = url;
        this.nextId = 1;
        this.pending = new Map();
        this.handlers = new Map();
    }

    async connect() {
        this.socket = new WebSocket(this.url);

        await new Promise((resolve, reject) => {
            this.socket.onopen = resolve;
            this.socket.onerror = () => reject(new Error(`无法连接 CDP：${this.url}`));
        });

        this.socket.onmessage = event => {
            const message = JSON.parse(event.data);

            if (message.id && this.pending.has(message.id)) {
                const { resolve, reject } = this.pending.get(message.id);

                this.pending.delete(message.id);

                if (message.error) reject(new Error(message.error.message));
                else resolve(message.result);

                return;
            }

            const handlers = this.handlers.get(message.method) || [];

            handlers.forEach(handler => handler(message.params));
        };
    }

    send(method, params = {}) {
        const id = this.nextId++;

        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    on(method, handler) {
        if (!this.handlers.has(method)) this.handlers.set(method, []);

        this.handlers.get(method).push(handler);
    }

    once(method) {
        return new Promise(resolve => {
            const handler = params => {
                const list = this.handlers.get(method);

                this.handlers.set(method, list.filter(item => item !== handler));
                resolve(params);
            };

            this.on(method, handler);
        });
    }

    close() {
        try {
            this.socket.close();
        } catch {
            // 忽略
        }
    }
}

async function evaluate(cdp, expression) {
    const result = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
    });

    if (result.exceptionDetails) {
        const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;

        throw new Error(`页面内执行出错：${detail}`);
    }

    return result.result.value;
}

/** 生成一段 PCM WAV 的字节数组（浏览器内用） */
const MAKE_WAV_SOURCE = `
function makeTestWav({ sampleRate = 44100, channels = 2, frames = 44100, freq = 440 }) {
    const dataSize = frames * channels * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeAscii = (offset, text) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };

    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, 'data');
    view.setUint32(40, dataSize, true);

    for (let frame = 0; frame < frames; frame++) {
        const value = Math.round(Math.sin((2 * Math.PI * freq * frame) / sampleRate) * 20000);
        for (let channel = 0; channel < channels; channel++) {
            view.setInt16(44 + (frame * channels + channel) * 2, value, true);
        }
    }

    return new Uint8Array(buffer);
}
`;

const READ_MP3_HEADER_SOURCE = `
function readMp3Header(bytes) {
    for (let i = 0; i + 4 <= bytes.length; i++) {
        if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;

        const versionBits = (bytes[i + 1] >> 3) & 0x03;
        const layerBits = (bytes[i + 1] >> 1) & 0x03;
        const bitrateIndex = (bytes[i + 2] >> 4) & 0x0f;
        const rateIndex = (bytes[i + 2] >> 2) & 0x03;
        const modeBits = (bytes[i + 3] >> 6) & 0x03;
        const rates = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }[versionBits];
        const bitratesV1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
        const bitratesV2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

        if (!rates || layerBits !== 1) continue;

        return {
            mpeg: versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5,
            sampleRate: rates[rateIndex],
            bitrate: (versionBits === 3 ? bitratesV1 : bitratesV2)[bitrateIndex],
            mode: ['stereo', 'joint', 'dual', 'mono'][modeBits]
        };
    }

    return null;
}
`;

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
    if (condition) {
        passed++;
        console.log(`  ✓ ${name}`);
    } else {
        failed++;
        console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
    }
}

async function main() {
    const browserPath = findBrowser();

    if (!browserPath) {
        console.log('⚠ 未找到 Chrome/Edge，跳过浏览器端到端测试。');
        return;
    }

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtt-lrc-e2e-'));
    const downloadDir = path.join(userDataDir, 'downloads');

    fs.mkdirSync(downloadDir, { recursive: true });

    const browser = spawn(browserPath, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--allow-file-access-from-files',
        '--remote-debugging-port=0',
        `--user-data-dir=${userDataDir}`,
        'about:blank'
    ], {
        stdio: 'ignore'
    });

    let browserCdp = null;
    let pageCdp = null;

    try {
        const portFile = path.join(userDataDir, 'DevToolsActivePort');
        let port = null;

        for (let attempt = 0; attempt < 150 && !port; attempt++) {
            if (fs.existsSync(portFile)) {
                port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
                break;
            }

            await sleep(100);
        }

        if (!port) throw new Error('Chrome 没有在预期时间内启动。');

        const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();

        browserCdp = new Cdp(version.webSocketDebuggerUrl);
        await browserCdp.connect();
        await browserCdp.send('Browser.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: downloadDir,
            eventsEnabled: true
        });

        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = targets.find(target => target.type === 'page');

        if (!page) throw new Error('没有可用的页面目标。');

        pageCdp = new Cdp(page.webSocketDebuggerUrl);
        await pageCdp.connect();
        await pageCdp.send('Page.enable');
        await pageCdp.send('Runtime.enable');

        const loaded = pageCdp.once('Page.loadEventFired');

        await pageCdp.send('Page.navigate', { url: TARGET_URL });
        await loaded;

        // 等 CDN 脚本（Tailwind / JSZip / lamejs）就绪；CDN 偶发抖动时重载一次
        const waitForDeps = async attempts => {
            for (let attempt = 0; attempt < attempts; attempt++) {
                const ready = await evaluate(pageCdp, 'typeof JSZip === "function" && typeof WavToMp3 !== "undefined" && WavToMp3.isLamejsReady()');

                if (ready) return true;

                await sleep(200);
            }

            return false;
        };

        let ready = await waitForDeps(100);

        if (!ready) {
            console.log('（依赖未就绪，重新加载页面再试一次…）');

            const reloaded = pageCdp.once('Page.loadEventFired');

            await pageCdp.send('Page.reload', { ignoreCache: true });
            await reloaded;
            ready = await waitForDeps(150);
        }

        console.log('\n[1] 页面与依赖加载');
        check('lamejs / audio.js / JSZip 均已就绪', ready === true, '依赖未加载完成');
        check('界面不再提供码率选择', await evaluate(pageCdp, 'document.getElementById("mp3-bitrate") === null'));

        // --- 2. WAV 转 MP3 标签页：真实点击 + 真实下载 ---
        console.log('\n[2] WAV 转 MP3 标签页（真实点击 + 真实下载）');

        await evaluate(pageCdp, `(() => {
            ${MAKE_WAV_SOURCE}
            const wav = makeTestWav({ frames: 44100 });
            const file = new File([wav], '测试歌曲.wav', { type: 'audio/wav' });
            const transfer = new DataTransfer();
            transfer.items.add(file);
            document.getElementById('tab-audio').click();
            const input = document.getElementById('file-input-audio');
            input.files = transfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        })()`);

        check('选择 WAV 后显示待转码列表', await evaluate(pageCdp, '!document.getElementById("file-list-container").classList.contains("hidden")'));
        check('按钮文案切换为「转码并下载 MP3」', (await evaluate(pageCdp, 'document.getElementById("btn-text").textContent')).includes('转码并下载 MP3'));
        check('选项区显示且隐藏了 ZIP 专用开关', await evaluate(pageCdp, `!document.getElementById('audio-options').classList.contains('hidden') && document.getElementById('transcode-option').classList.contains('hidden')`));

        await evaluate(pageCdp, 'document.getElementById("convert-btn").click()');

        // 等下载完成
        let downloaded = null;

        for (let attempt = 0; attempt < 150; attempt++) {
            const entries = fs.readdirSync(downloadDir).filter(name => !name.endsWith('.crdownload'));

            if (entries.length) {
                downloaded = path.join(downloadDir, entries[0]);
                break;
            }

            await sleep(200);
        }

        check('点击按钮后浏览器真的下载了文件', !!downloaded);

        if (downloaded) {
            const bytes = fs.readFileSync(downloaded);
            const header = await evaluate(pageCdp, `(() => {
                ${READ_MP3_HEADER_SOURCE}
                return readMp3Header(new Uint8Array([${Array.from(bytes.slice(0, 4096)).join(',')}]));
            })()`);

            check(`下载文件名是「${path.basename(downloaded)}」`, path.basename(downloaded) === '测试歌曲.mp3', `实际 ${path.basename(downloaded)}`);
            check('输出是 MPEG-1 Layer III', header && header.mpeg === 1, JSON.stringify(header));
            check('码率 320 kbps', header && header.bitrate === 320, JSON.stringify(header));
            check('采样率 44100 Hz', header && header.sampleRate === 44100, JSON.stringify(header));
            check('立体声', header && header.mode !== 'mono', JSON.stringify(header));

            const expected = 320 * 1000 / 8;
            const ratio = bytes.length / expected;

            check(`时长约 1 秒（实际 ${(ratio).toFixed(2)} 秒等效）`, ratio > 0.9 && ratio < 1.2, `字节数 ${bytes.length}`);
        }

        // --- 3. ZIP 模式：包内 WAV 转码 ---
        console.log('\n[3] ZIP 模式：包内 WAV 自动转码');

        const zipResult = await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}
            ${READ_MP3_HEADER_SOURCE}

            const source = new JSZip();
            source.file('作品A/歌曲一.wav', makeTestWav({ frames: 22050 }));
            source.file('作品A/歌曲一.wav.vtt', 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n第一句歌词\\n');
            source.file('作品A/歌曲二.wav', makeTestWav({ frames: 22050, freq: 660 }));
            source.file('作品A/封面.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]));

            const blob = await source.generateAsync({ type: 'blob' });
            const file = new File([blob], '测试包.zip', { type: 'application/zip' });

            switchTab('zip');
            await handleZipFile(file);

            const listText = document.getElementById('file-list').textContent;
            const buttonLabel = document.getElementById('btn-text').textContent;

            const output = new JSZip();
            await processZipMode(output);

            const names = Object.keys(output.files).filter(name => !output.files[name].dir).sort();
            const mp3Entry = names.find(name => name.endsWith('歌曲一.mp3'));
            const mp3Bytes = mp3Entry ? await output.file(mp3Entry).async('uint8array') : null;
            const lrcEntry = names.find(name => name.endsWith('.lrc'));

            return {
                listText,
                buttonLabel,
                names,
                header: mp3Bytes ? readMp3Header(mp3Bytes) : null,
                mp3Size: mp3Bytes ? mp3Bytes.length : 0,
                lrcName: lrcEntry || null,
                lrcContent: lrcEntry ? await output.file(lrcEntry).async('string') : null
            };
        })()`);

        check('文件列表提示包内 WAV 将转码', zipResult.listText.includes('2 个 WAV 文件将转码为 320 kbps'), zipResult.listText);
        check('输出包含转码后的 歌曲一.mp3', zipResult.names.some(name => name.endsWith('歌曲一.mp3')), JSON.stringify(zipResult.names));
        check('输出包含转码后的 歌曲二.mp3', zipResult.names.some(name => name.endsWith('歌曲二.mp3')), JSON.stringify(zipResult.names));
        check('原始 WAV 不再出现在输出中', !zipResult.names.some(name => name.endsWith('.wav')), JSON.stringify(zipResult.names));
        check('LRC 与 MP3 同名（歌曲一.lrc）', zipResult.lrcName !== null && zipResult.lrcName.endsWith('歌曲一.lrc'), String(zipResult.lrcName));
        check('LRC 内容正确', zipResult.lrcContent === '[00:00.00]第一句歌词\n', JSON.stringify(zipResult.lrcContent));
        check('包内图片被保留', zipResult.names.some(name => name.endsWith('封面.jpg')), JSON.stringify(zipResult.names));
        check('转码出的 MP3 帧头正确（320 kbps）', zipResult.header && zipResult.header.bitrate === 320 && zipResult.header.sampleRate === 44100, JSON.stringify(zipResult.header));

        // --- 4. 关掉转码开关后应原样保留 WAV ---
        console.log('\n[4] 关闭「转码包内 WAV」后原样保留');

        const keepResult = await evaluate(pageCdp, `(async () => {
            const checkbox = document.getElementById('transcode-wav-checkbox');
            checkbox.checked = false;
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));

            const note = document.getElementById('zip-wav-note');
            const output = new JSZip();
            await processZipMode(output);

            return {
                note: note ? note.textContent : null,
                names: Object.keys(output.files).filter(name => !output.files[name].dir).sort()
            };
        })()`);

        check('提示改为「原样保留」', (keepResult.note || '').includes('原样保留'), String(keepResult.note));
        check('WAV 原样保留在输出中', keepResult.names.some(name => name.endsWith('.wav')), JSON.stringify(keepResult.names));
        check('没有生成 MP3', !keepResult.names.some(name => name.endsWith('.mp3')), JSON.stringify(keepResult.names));

        // --- 5. 回归：直接上传 VTT（曾经因为 FileList 被清空而完全失效）---
        console.log('\n[5] 回归：直接上传多个 VTT 文件');

        const directResult = await evaluate(pageCdp, `(async () => {
            document.getElementById('tab-direct').click();

            const transfer = new DataTransfer();
            transfer.items.add(new File(['WEBVTT\\n\\n00:00.000 --> 00:02.000\\n第一句\\n'], '甲.vtt', { type: 'text/vtt' }));
            transfer.items.add(new File(['WEBVTT\\n\\n00:02.000 --> 00:04.000\\n第二句\\n'], '乙.vtt', { type: 'text/vtt' }));

            const input = document.getElementById('file-input-direct');
            input.files = transfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));

            const output = new JSZip();
            await processDirectVttMode(output);

            return {
                status: document.getElementById('status-message').textContent,
                listHidden: document.getElementById('file-list-container').classList.contains('hidden'),
                count: filesToProcess.length,
                names: Object.keys(output.files).sort(),
                content: await output.file('甲.lrc').async('string')
            };
        })()`);

        check('两个 VTT 都被识别', directResult.count === 2, `识别到 ${directResult.count} 个`);
        check('不再提示「请选择 .vtt 文件」', directResult.status !== '请选择 .vtt 文件。', directResult.status);
        check('文件列表可见', directResult.listHidden === false);
        check('输出 甲.lrc / 乙.lrc', JSON.stringify(directResult.names) === JSON.stringify(['乙.lrc', '甲.lrc']), JSON.stringify(directResult.names));
        check('LRC 内容正确', directResult.content === '[00:00.00]第一句\n', JSON.stringify(directResult.content));

        // --- 6. 坏 WAV 不应该拖垮整包 ---
        console.log('\n[6] 损坏的 WAV 不会中断整包处理');

        const badResult = await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}

            const source = new JSZip();
            source.file('包/好文件.wav', makeTestWav({ frames: 11025 }));
            source.file('包/坏文件.wav', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));

            const blob = await source.generateAsync({ type: 'blob' });

            switchTab('zip');
            await handleZipFile(new File([blob], '混合包.zip', { type: 'application/zip' }));

            const checkbox = document.getElementById('transcode-wav-checkbox');
            checkbox.checked = true;
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));

            const output = new JSZip();
            const result = await processZipMode(output);

            return {
                warnings: result.warnings,
                names: Object.keys(output.files).filter(name => !output.files[name].dir).sort()
            };
        })()`);

        check('好文件仍被转码为 MP3', badResult.names.some(name => name.endsWith('好文件.mp3')), JSON.stringify(badResult.names));
        check('坏文件原样保留', badResult.names.some(name => name.endsWith('坏文件.wav')), JSON.stringify(badResult.names));
        check('返回了 1 条警告', badResult.warnings.length === 1, JSON.stringify(badResult.warnings));
        check('警告里带文件名', (badResult.warnings[0] || '').includes('坏文件.wav'), JSON.stringify(badResult.warnings));

        // --- 7. 平铺重名时，LRC 必须和转码出来的 MP3 同名 ---
        console.log('\n[7] 平铺重名：LRC 与 MP3 保持同名');

        const collisionResult = await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}

            const source = new JSZip();
            source.file('专辑包/作品A/歌曲.wav', makeTestWav({ frames: 11025, freq: 440 }));
            source.file('专辑包/作品A/歌曲.wav.vtt', 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\nA 的歌词\\n');
            source.file('专辑包/作品B/歌曲.wav', makeTestWav({ frames: 11025, freq: 660 }));
            source.file('专辑包/作品B/歌曲.wav.vtt', 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\nB 的歌词\\n');

            const blob = await source.generateAsync({ type: 'blob' });

            switchTab('zip');
            document.getElementById('flatten-checkbox').checked = true;
            document.getElementById('transcode-wav-checkbox').checked = true;
            await handleZipFile(new File([blob], '专辑包.zip', { type: 'application/zip' }));

            const output = new JSZip();
            await processZipMode(output);

            const names = Object.keys(output.files).filter(name => !output.files[name].dir).sort();
            const lrcStems = names.filter(n => n.endsWith('.lrc')).map(n => n.replace(/\\.lrc$/, ''));
            const mp3Stems = names.filter(n => n.endsWith('.mp3')).map(n => n.replace(/\\.mp3$/, ''));

            return {
                names,
                lrcUnique: lrcStems.length === 2 && new Set(lrcStems).size === 2,
                mp3Unique: mp3Stems.length === 2 && new Set(mp3Stems).size === 2,
                lrcStems,
                mp3Stems,
                paired: lrcStems.length === 2 && lrcStems.every(stem => mp3Stems.includes(stem))
            };
        })()`);

        check('两个 LRC 文件名互不重复', collisionResult.lrcUnique, JSON.stringify(collisionResult.names));
        check('两个 MP3 文件名互不重复', collisionResult.mp3Unique, JSON.stringify(collisionResult.names));
        check(
            `LRC 与 MP3 同名配对（LRC: ${collisionResult.lrcStems.join(', ')} / MP3: ${collisionResult.mp3Stems.join(', ')}）`,
            collisionResult.paired,
            JSON.stringify(collisionResult.names)
        );

        // --- 8. 转码出来的 MP3 也要能写入封面 ---
        console.log('\n[8] 转码后的 MP3 写入 ID3v2 封面');

        fs.readdirSync(downloadDir).forEach(name => fs.rmSync(path.join(downloadDir, name), { force: true }));

        await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}

            document.getElementById('tab-audio').click();

            const transfer = new DataTransfer();
            transfer.items.add(new File([makeTestWav({ frames: 22050 })], '带封面.wav', { type: 'audio/wav' }));

            const input = document.getElementById('file-input-audio');
            input.files = transfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));

            // 造一张真 JPEG 当封面
            const canvas = document.createElement('canvas');
            canvas.width = 400;
            canvas.height = 400;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ff0000';
            ctx.fillRect(0, 0, 400, 400);

            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
            const coverInput = document.getElementById('file-input-cover');
            const coverTransfer = new DataTransfer();

            coverTransfer.items.add(new File([blob], '封面.jpg', { type: 'image/jpeg' }));
            coverInput.files = coverTransfer.files;
            coverInput.dispatchEvent(new Event('change', { bubbles: true }));

            await new Promise(resolve => setTimeout(resolve, 300));
            document.getElementById('convert-btn').click();

            return true;
        })()`);

        let coverFile = null;

        for (let attempt = 0; attempt < 150; attempt++) {
            const entries = fs.readdirSync(downloadDir).filter(name => !name.endsWith('.crdownload'));

            if (entries.length) {
                coverFile = path.join(downloadDir, entries[0]);
                break;
            }

            await sleep(200);
        }

        check('带封面的 MP3 下载成功', !!coverFile, '没有等到下载文件');

        if (coverFile) {
            const bytes = fs.readFileSync(coverFile);
            const hasId3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
            const hasApic = bytes.includes(Buffer.from('APIC'));
            const hasTit2 = bytes.includes(Buffer.from('TIT2'));
            const jpegIndex = bytes.indexOf(Buffer.from([0xff, 0xd8, 0xff]));

            check('文件以 ID3v2 标签开头', hasId3, `首字节 ${bytes.slice(0, 4).toString('hex')}`);
            check('包含 APIC 封面帧', hasApic);
            check('包含 TIT2 标题帧', hasTit2);
            check('封面是 JPEG 数据', jpegIndex > 0 && jpegIndex < 200000, `JPEG 起始位置 ${jpegIndex}`);
            check('ID3 标签长度合理', bytes.length > 20000, `总长度 ${bytes.length}`);
        }
    } finally {
        pageCdp?.close();
        browserCdp?.close();
        browser.kill();

        await sleep(300);

        try {
            fs.rmSync(userDataDir, { recursive: true, force: true });
        } catch {
            // 忽略清理失败
        }
    }
}

main()
    .then(() => {
        console.log(`\n通过 ${passed}，失败 ${failed}`);
        process.exit(failed === 0 ? 0 : 1);
    })
    .catch(error => {
        console.error(`\n运行出错：${error.message}`);
        process.exit(1);
    });
