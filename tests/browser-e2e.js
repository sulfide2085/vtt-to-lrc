/**
 * 浏览器端到端测试：用真实 Chrome 驱动真实页面
 *
 *   node tests/browser-e2e.js
 *   node tests/browser-e2e.js https://sulfide2085.github.io/vtt-to-lrc/   # 直接测线上站点
 *
 * 覆盖：
 *   1. 依赖加载与三种模式（直传 VTT / ZIP / 文件夹）的界面状态
 *   2. ZIP 模式：真实点击 → 真实下载 → 解包校验 MP3 帧头与 LRC 内容
 *   3. 文件夹模式：写回原路径、写回前确认清单、剪掉源文件、内容没变跳过、
 *      只读降级打包、平铺配对、webkitdirectory 降级、以及真实 File System Access 句柄
 *   4. 回归项：坏 WAV 不拖垮整包、转换中切标签、RJ 元数据联动、窄屏点击、访问统计
 *
 * 找不到 Chrome 时自动跳过（退出码 0）。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

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

/** 解开浏览器下载下来的 ZIP（JSZip 默认用 deflate，够用了，不支持 ZIP64） */
function readZipEntries(buffer) {
    let eocd = -1;

    for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 65536; i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }

    if (eocd < 0) throw new Error('不是有效的 ZIP（找不到 EOCD）');

    const count = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    const entries = [];

    for (let i = 0; i < count; i++) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) break;

        const method = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const raw = buffer.subarray(dataStart, dataStart + compressedSize);

        entries.push({
            name,
            data: method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw)
        });

        offset += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
}

/** Node 侧的 MP3 帧头解析，和页面里的 readMp3Header 保持一致 */
function readMp3HeaderBuffer(bytes) {
    // 同样先跳过 ID3v2 标签，否则封面 JPEG 里的假帧同步会先被命中
    if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
        const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);

        bytes = bytes.subarray(Math.min(10 + size, bytes.length));
    }

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

function findBrowser() {
    return CHROME_CANDIDATES.find(candidate => {
        try {
            return fs.statSync(candidate).isFile();
        } catch {
            return false;
        }
    });
}

/**
 * 清空下载目录。
 * 注意：Chrome 自己会往"配置的下载目录"里写东西（实测无头模式下会落一个
 * downloads.htm，内容是组件更新的 CRX 包，打开 example.com 也一样出现），
 * 所以测试必须按期望的文件名去找，不能"抓到第一个文件就算数"。
 */
function clearDownloadDir(dir) {
    for (const name of fs.readdirSync(dir)) {
        try {
            fs.rmSync(path.join(dir, name), { force: true });
        } catch {
            // Chrome 可能还占着 .crdownload 句柄，忽略
        }
    }
}

/** 等一个文件名以 expectedSuffix 结尾的下载完成 */
async function waitForDownload(dir, expectedSuffix, attempts = 200) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const matches = fs.readdirSync(dir)
            .filter(name => !name.endsWith('.crdownload') && name.endsWith(expectedSuffix))
            .sort();

        if (matches.length) return path.join(dir, matches[0]);

        await sleep(200);
    }

    return null;
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
/** 跳过 ID3v2 标签：封面 JPEG 里可能出现 0xFF 0xEx 的假帧同步，必须从音频数据开始找 */
function skipId3v2(bytes) {
    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;

    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);

    return Math.min(10 + size, bytes.length);
}

function readMp3Header(bytes) {
    for (let i = skipId3v2(bytes); i + 4 <= bytes.length; i++) {
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

/**
 * 页面内的测试工具，用 Runtime.evaluate 装成全局函数（页面每次重载后要重新装）：
 *   1. runEntriesInZip —— 走页面真实的那条"虚拟条目 → ZIP"流水线，
 *      这样校验的是产品代码，而不是测试自己另写的一份实现
 *   2. makeFakeDirectoryTree —— 内存版 FileSystemDirectoryHandle。
 *      自动化工具点不动系统的目录选择器，所以用 window.__vttTestDirectoryProvider
 *      把这个假目录塞进去，就能真的验证"文件被写到了哪个路径、内容对不对"
 */
const PAGE_TEST_HELPERS = `
async function runEntriesInZip(job) {
    const output = new JSZip();
    const entries = await buildVirtualEntries(job);
    const result = await fillZipFromEntries(output, entries, job);

    return { output, result };
}

function makeFakeDirectoryTree(rootName, spec) {
    const encoder = new TextEncoder();
    const logs = [];
    const root = { kind: 'directory', name: rootName, dirs: new Map(), files: new Map() };

    function putNode(relativePath, data) {
        const segments = String(relativePath).split('/').filter(Boolean);
        const fileName = segments.pop();
        let cursor = root;

        for (const segment of segments) {
            if (!cursor.dirs.has(segment)) {
                cursor.dirs.set(segment, { kind: 'directory', name: segment, dirs: new Map(), files: new Map() });
            }

            cursor = cursor.dirs.get(segment);
        }

        cursor.files.set(fileName, {
            name: fileName,
            bytes: data instanceof Uint8Array ? data : encoder.encode(String(data)),
            mime: FolderFs.mimeForPath(fileName),
            lastModified: 1700000000000
        });
    }

    for (const [filePath, data] of Object.entries(spec || {})) putNode(filePath, data);

    function snapshot(node, prefix, out) {
        for (const [name, file] of node.files) {
            out[prefix ? prefix + '/' + name : name] = file;
        }

        for (const [name, dir] of node.dirs) {
            snapshot(dir, prefix ? prefix + '/' + name : name, out);
        }

        return out;
    }

    function wrapFile(node, file, name, prefix) {
        const filePath = prefix ? prefix + '/' + name : name;

        return {
            kind: 'file',
            name,
            async getFile() {
                return new File([file.bytes], name, { type: file.mime, lastModified: file.lastModified });
            },
            async createWritable() {
                let buffer = null;

                return {
                    async write(data) {
                        buffer = FolderFs.toBytes(data);
                    },
                    async close() {
                        file.bytes = buffer || new Uint8Array(0);
                        file.lastModified = 1700000001000;
                        logs.push('write ' + filePath + ' ' + file.bytes.length + 'B');
                    },
                    async abort() {
                        buffer = null;
                    }
                };
            }
        };
    }

    function wrapDirectory(node, prefix) {
        return {
            kind: 'directory',
            name: node.name,
            values: async function* () {
                for (const [name, child] of node.files) {
                    yield wrapFile(node, child, name, prefix);
                }

                for (const [name, dir] of node.dirs) {
                    yield wrapDirectory(dir, prefix ? prefix + '/' + name : name);
                }
            },
            async getDirectoryHandle(name, options = {}) {
                const dir = node.dirs.get(name);

                if (dir) return wrapDirectory(dir, prefix ? prefix + '/' + name : name);

                if (options.create === false) throw new DOMException('文件夹不存在', 'NotFoundError');

                const created = { kind: 'directory', name, dirs: new Map(), files: new Map() };

                node.dirs.set(name, created);
                logs.push('mkdir ' + (prefix ? prefix + '/' + name : name));

                return wrapDirectory(created, prefix ? prefix + '/' + name : name);
            },
            async getFileHandle(name, options = {}) {
                const file = node.files.get(name);

                if (file) return wrapFile(node, file, name, prefix);

                if (options.create === false) throw new DOMException('文件不存在', 'NotFoundError');

                const created = { name, bytes: new Uint8Array(0), mime: FolderFs.mimeForPath(name), lastModified: 0 };

                node.files.set(name, created);

                return wrapFile(node, created, name, prefix);
            },
            async removeEntry(name) {
                if (node.files.delete(name)) {
                    logs.push('delete ' + (prefix ? prefix + '/' + name : name));
                    return;
                }

                if (node.dirs.has(name)) {
                    // 真实 API 删空目录时不需要 recursive；这里跟页面代码保持一致，
                    // 只在目录真的空了才允许删，顺便把"删了非空目录"这种情况暴露成错误
                    if (node.dirs.get(name).files.size > 0 || node.dirs.get(name).dirs.size > 0) {
                        throw new DOMException('目录非空', 'InvalidModificationError');
                    }

                    node.dirs.delete(name);
                    logs.push('rmdir ' + (prefix ? prefix + '/' + name : name));
                    return;
                }

                throw new DOMException('条目不存在', 'NotFoundError');
            }
        };
    }

    const handle = wrapDirectory(root, '');

    handle.logs = logs;
    handle.read = relativePath => {
        const segments = String(relativePath).split('/').filter(Boolean);
        const fileName = segments.pop();
        let cursor = root;

        for (const segment of segments) {
            cursor = cursor.dirs.get(segment);

            if (!cursor) return null;
        }

        const file = cursor.files.get(fileName);

        return file ? file.bytes : null;
    };
    handle.text = relativePath => {
        const bytes = handle.read(relativePath);

        return bytes ? new TextDecoder('utf-8').decode(bytes) : null;
    };
    handle.has = relativePath => handle.read(relativePath) !== null;
    handle.list = () => Object.keys(snapshot(root, '', {}));
    handle.put = (relativePath, data) => putNode(relativePath, data);
    handle.copy = () => Object.fromEntries(Object.entries(snapshot(root, '', {})).map(([key, value]) => [key, value.bytes.slice()]));

    return handle;
}
`;

/** 页面每次重载后都要重新装一遍（函数声明会挂到全局作用域上） */
async function installPageHelpers(cdp) {
    await evaluate(cdp, PAGE_TEST_HELPERS);
}

let passed = 0;
let failed = 0;

/** 只比较集合内容，不依赖排序——Node 的 localeCompare 在中英文混排时不同系统结果不同 */
function sameSet(left, right) {
    return left.length === right.length && [...left].sort().join('\u0000') === [...right].sort().join('\u0000');
}

function check(name, condition, detail) {    if (condition) {
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
        await pageCdp.send('Log.enable');
        pageCdp.on('Log.entryAdded', params => {
            if (params.entry.level === 'error') {
                console.log(`    [页面控制台] ${params.entry.text}`);
            }
        });

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

        for (let reloadAttempt = 0; reloadAttempt < 3 && !ready; reloadAttempt++) {
            console.log(`（依赖未就绪，第 ${reloadAttempt + 1} 次重载页面重试…）`);

            const reloaded = pageCdp.once('Page.loadEventFired');

            await pageCdp.send('Page.reload', { ignoreCache: true });
            await reloaded;
            ready = await waitForDeps(150);
        }

        if (!ready) {
            // 直接中止：否则后面几十项都会因为编码库缺失而失败，看不出真正原因
            throw new Error('CDN 依赖（lamejs / JSZip / Tailwind）加载失败，属网络问题而非页面缺陷，本次测试中止');
        }

        await installPageHelpers(pageCdp);

        console.log('\n[1] 页面与依赖加载');
        check('lamejs / audio.js / JSZip 均已就绪', ready === true, '依赖未加载完成');        check('三个模式标签都在（直传 VTT / ZIP / 文件夹），旧的单页音频标签已移除', await evaluate(pageCdp, `document.querySelectorAll('.tab-btn').length === 3 && document.getElementById('tab-direct') !== null && document.getElementById('tab-zip') !== null && document.getElementById('tab-folder') !== null && document.getElementById('tab-audio') === null`));
        check('folder.js 全局模块已就绪', await evaluate(pageCdp, `typeof FolderFs === 'object' && typeof FolderFs.scanDirectory === 'function' && typeof FolderFs.writeFile === 'function' && typeof FolderFs.handleFromFiles === 'function'`));
        check('界面不再提供码率选择', await evaluate(pageCdp, 'document.getElementById("mp3-bitrate") === null'));
        check('页脚有 GitHub 仓库链接', await evaluate(pageCdp, `(() => {
            const link = document.querySelector('footer a[href*="github.com"]');

            return !!link &&
                link.getAttribute('href') === 'https://github.com/sulfide2085/vtt-to-lrc' &&
                link.getAttribute('target') === '_blank' &&
                link.textContent.includes('vtt-to-lrc');
        })()`));
        // 版本号双职责：既是发布标记，也是本地资源的缓存破坏参数。
        // GitHub Pages 发 Cache-Control: max-age=600，如果 ?v= 没跟着版本走，
        // 用户改了代码后仍会跑到缓存里的旧 JS（真实踩过：修好的删除逻辑被旧脚本复现成"18 项失败"）。
        const versionInfo = await evaluate(pageCdp, `(() => {
            const version = (document.querySelector('footer').textContent.match(/v(\\d+\\.\\d+\\.\\d+)/) || [])[1] || null;
            const assets = [
                document.querySelector('link[rel="stylesheet"][href^="styles.css"]'),
                document.querySelector('script[src^="audio.js"]'),
                document.querySelector('script[src^="folder.js"]'),
                document.querySelector('script[src^="app.js"]')
            ].filter(Boolean).map(el => el.getAttribute('href') || el.getAttribute('src'));

            return {
                version,
                assets,
                counts: document.querySelectorAll('link[rel="stylesheet"][href^="styles.css"], script[src^="audio.js"], script[src^="folder.js"], script[src^="app.js"]').length
            };
        })()`);

        check(`页脚版本号是合法版本（读到 ${versionInfo.version}）`, /^\d+\.\d+\.\d+$/.test(String(versionInfo.version)), JSON.stringify(versionInfo));
        check(
            `本地资源都带上了匹配的缓存破坏参数（?v=${versionInfo.version}）`,
            versionInfo.counts === 4 && versionInfo.assets.every(url => url.includes(`?v=${versionInfo.version}`)),
            JSON.stringify(versionInfo.assets)
        );

        // --- 2. ZIP 模式：真实点击 + 真实下载，并把下载到的压缩包拆开检查 ---
        console.log('\n[2] ZIP 模式（真实点击 + 真实下载，解包校验内容）');

        clearDownloadDir(downloadDir);

        await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}

            const source = new JSZip();
            source.file('作品/歌曲.wav', makeTestWav({ frames: 22050 }));
            source.file('作品/歌曲.wav.vtt', 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n测试歌词\\n');

            const blob = await source.generateAsync({ type: 'blob' });

            switchTab('zip');
            document.getElementById('transcode-wav-checkbox').checked = true;
            await handleZipFile(new File([blob], '下载测试.zip', { type: 'application/zip' }));
            document.getElementById('convert-btn').click();

            return true;
        })()`);

        const downloadedZip = await waitForDownload(downloadDir, '下载测试_after.zip');

        check('点击按钮后浏览器真的下载了文件', !!downloadedZip);

        if (downloadedZip) {
            const zipBytes = fs.readFileSync(downloadedZip);
            const entries = readZipEntries(zipBytes);
            const names = entries.map(entry => entry.name).sort();
            const mp3Entry = entries.find(entry => entry.name.endsWith('.mp3'));
            const lrcEntry = entries.find(entry => entry.name.endsWith('.lrc'));

            check(`下载的是「${path.basename(downloadedZip)}」`, path.basename(downloadedZip) === '下载测试_after.zip', `实际 ${path.basename(downloadedZip)}`);
            check('下载内容是可解析的 ZIP', entries.length > 0, JSON.stringify(names));
            check('压缩包里是 MP3 + LRC', !!mp3Entry && !!lrcEntry, JSON.stringify(names));
            check('MP3 与 LRC 同名', mp3Entry && lrcEntry && mp3Entry.name.replace(/\.mp3$/, '') === lrcEntry.name.replace(/\.lrc$/, ''), `${mp3Entry?.name} / ${lrcEntry?.name}`);
            check('LRC 内容正确', lrcEntry && lrcEntry.data.toString('utf8') === '[00:00.00]测试歌词\n', JSON.stringify(lrcEntry?.data.toString('utf8')));

            const header = mp3Entry ? readMp3HeaderBuffer(mp3Entry.data) : null;

            check('MP3 是 MPEG-1 Layer III', header && header.mpeg === 1, JSON.stringify(header));
            check('码率 320 kbps', header && header.bitrate === 320, JSON.stringify(header));
            check('采样率 44100 Hz', header && header.sampleRate === 44100, JSON.stringify(header));
            check('立体声', header && header.mode !== 'mono', JSON.stringify(header));

            const ratio = mp3Entry ? mp3Entry.data.length / (320 * 1000 / 8) : 0;

            check(`MP3 时长约 0.5 秒（实际 ${ratio.toFixed(2)} 秒等效）`, ratio > 0.4 && ratio < 0.7, `字节数 ${mp3Entry?.data.length}`);
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

            const { output } = await runEntriesInZip(createJob());
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
            const { output } = await runEntriesInZip(createJob());

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

            const { output } = await runEntriesInZip(createJob());

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

            const { output, result } = await runEntriesInZip(createJob());

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

            const { output } = await runEntriesInZip(createJob());
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

        // --- 8. 转码出来的 MP3 也要能写入封面（封面选的是包内图片）---
        console.log('\n[8] 转码后的 MP3 写入 ID3v2 封面');

        const coverResult = await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}

            const indexOfBytes = (haystack, needle) => {
                outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
                    for (let j = 0; j < needle.length; j++) {
                        if (haystack[i + j] !== needle[j]) continue outer;
                    }
                    return i;
                }
                return -1;
            };
            const ascii = text => Array.from(text).map(char => char.charCodeAt(0));

            // 造一张真 JPEG 当封面
            const canvas = document.createElement('canvas');
            canvas.width = 400;
            canvas.height = 400;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ff0000';
            ctx.fillRect(0, 0, 400, 400);

            const jpegBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
            const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());

            const source = new JSZip();
            source.file('包/曲目.wav', makeTestWav({ frames: 22050 }));
            source.file('包/封面.jpg', jpegBytes);

            const blob = await source.generateAsync({ type: 'blob' });

            switchTab('zip');
            document.getElementById('transcode-wav-checkbox').checked = true;
            await handleZipFile(new File([blob], '带封面.zip', { type: 'application/zip' }));

            // 点第一张封面缩略图选中封面
            const wrapper = document.querySelector('#image-preview-grid .image-thumb-wrapper');
            if (wrapper) wrapper.click();

            const coverSelected = !!selectedCoverImage;

            const { output } = await runEntriesInZip(createJob());
            const mp3Name = Object.keys(output.files).find(name => name.endsWith('.mp3'));
            const bytes = mp3Name ? await output.file(mp3Name).async('uint8array') : new Uint8Array(0);

            return {
                coverSelected,
                mp3Name,
                hasId3: bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33,
                hasApic: indexOfBytes(bytes, ascii('APIC')) >= 0,
                hasTit2: indexOfBytes(bytes, ascii('TIT2')) >= 0,
                jpegIndex: indexOfBytes(bytes, [0xff, 0xd8, 0xff]),
                totalLength: bytes.length
            };
        })()`);

        check('包内图片可以被选为封面', coverResult.coverSelected === true);
        check('生成了 MP3', !!coverResult.mp3Name, String(coverResult.mp3Name));
        check('MP3 以 ID3v2 标签开头', coverResult.hasId3 === true, `标签起始=${coverResult.hasId3}`);
        check('包含 APIC 封面帧', coverResult.hasApic === true);
        check('包含 TIT2 标题帧', coverResult.hasTit2 === true);
        check('封面是 JPEG 数据', coverResult.jpegIndex > 0 && coverResult.jpegIndex < 200000, `JPEG 起始位置 ${coverResult.jpegIndex}`);
        check('ID3 标签长度合理', coverResult.totalLength > 20000, `总长度 ${coverResult.totalLength}`);

        // --- 9. Windows 压缩包的反斜杠条目名 ---
        // 资源管理器 / Compress-Archive 打出来的 zip，条目名是 "作品集\第一話\01.wav"，
        // 反斜杠在 zip 规范里不是分隔符，不修正会输出带反斜杠的怪文件名。
        console.log('\n[9] Windows 反斜杠条目名的压缩包');

        const backslashResult = await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}
            ${READ_MP3_HEADER_SOURCE}

            const source = new JSZip();
            source.file('作品集\\\\第一話\\\\01.wav', makeTestWav({ frames: 11025 }));
            source.file('作品集\\\\第一話\\\\01.wav.vtt', 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n第一句\\n');
            source.file('作品集\\\\第二話\\\\02.wav', makeTestWav({ frames: 11025, freq: 660 }));
            source.file('作品集\\\\第二話\\\\02.wav.vtt', 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n第二句\\n');

            const blob = await source.generateAsync({ type: 'blob' });

            switchTab('zip');
            document.getElementById('transcode-wav-checkbox').checked = true;
            await handleZipFile(new File([blob], '反斜杠包.zip', { type: 'application/zip' }));

            const { output } = await runEntriesInZip(createJob());
            const names = Object.keys(output.files).filter(name => !output.files[name].dir).sort();
            const mp3Bytes = names.filter(n => n.endsWith('.mp3')).length
                ? await output.file(names.find(n => n.endsWith('.mp3'))).async('uint8array')
                : null;

            return {
                names,
                anyBackslash: names.some(name => name.includes('\\\\')),
                header: mp3Bytes ? readMp3Header(mp3Bytes) : null,
                lrcStems: names.filter(n => n.endsWith('.lrc')).map(n => n.replace(/\\.lrc$/, '')),
                mp3Stems: names.filter(n => n.endsWith('.mp3')).map(n => n.replace(/\\.mp3$/, ''))
            };
        })()`);

        check('输出文件名里没有反斜杠', backslashResult.anyBackslash === false, JSON.stringify(backslashResult.names));
        check('生成了 2 个 MP3', backslashResult.mp3Stems.length === 2, JSON.stringify(backslashResult.names));
        check(
            'LRC 与 MP3 依然同名配对',
            backslashResult.lrcStems.length === 2 && backslashResult.lrcStems.every(stem => backslashResult.mp3Stems.includes(stem)),
            `LRC=${JSON.stringify(backslashResult.lrcStems)} MP3=${JSON.stringify(backslashResult.mp3Stems)}`
        );
        check('反斜杠包转出来的 MP3 帧头正确', backslashResult.header && backslashResult.header.bitrate === 320, JSON.stringify(backslashResult.header));

        // --- 10. 转换过程中切标签 / 清空，不能把正在跑的任务搞坏 ---
        // 线上真实事故：音声包转码中途切标签，clearFiles() 把封面快照清掉，
        // 结果最后一个音频没有封面，下载名也退化成 converted_lrc_时间戳.zip。
        console.log('\n[10] 转换中切标签 / 清空不应破坏正在进行的任务');

        clearDownloadDir(downloadDir);

        const midRunResult = await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}

            const indexOfBytes = (haystack, needle) => {
                outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
                    for (let j = 0; j < needle.length; j++) {
                        if (haystack[i + j] !== needle[j]) continue outer;
                    }
                    return i;
                }
                return -1;
            };
            const ascii = text => Array.from(text).map(char => char.charCodeAt(0));

            const canvas = document.createElement('canvas');
            canvas.width = 300;
            canvas.height = 300;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#00ff00';
            ctx.fillRect(0, 0, 300, 300);
            const jpegBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
            const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());

            // 3 个音频 + 1 张封面，足够长以便在转换中途动手
            const source = new JSZip();
            source.file('音声/1.wav', makeTestWav({ frames: 44100 * 3, freq: 440 }));
            source.file('音声/2.wav', makeTestWav({ frames: 44100 * 3, freq: 550 }));
            source.file('音声/3.wav', makeTestWav({ frames: 44100 * 3, freq: 660 }));
            source.file('音声/封面.jpg', jpegBytes);

            const blob = await source.generateAsync({ type: 'blob' });

            switchTab('zip');
            document.getElementById('transcode-wav-checkbox').checked = true;
            await handleZipFile(new File([blob], '中途切标签.zip', { type: 'application/zip' }));

            const wrapper = document.querySelector('#image-preview-grid .image-thumb-wrapper');
            if (wrapper) wrapper.click();

            // 开始转换（不 await），随后立刻模拟用户切标签 + 清空
            const running = convertAndDownload();

            await new Promise(resolve => setTimeout(resolve, 120));

            const tabBefore = currentTab;
            switchTab('direct');

            const refusedTabSwitch = currentTab === tabBefore;
            const tabButtonsDisabled = [...document.querySelectorAll('.tab-btn')].every(tab => tab.disabled);
            const clearDisabled = document.getElementById('clear-btn').disabled;

            // 再强行调用 clearFiles()：模拟其它路径把界面状态清掉。
            // 任务用的是自己的快照，理论上不受影响。
            clearFiles();

            await running;

            return { refusedTabSwitch, tabButtonsDisabled, clearDisabled };
        })()`);

        check('转换中切标签被拒绝', midRunResult.refusedTabSwitch === true);
        check('转换中标签按钮被禁用', midRunResult.tabButtonsDisabled === true);
        check('转换中「清空」按钮被禁用', midRunResult.clearDisabled === true);

        // 等下载落地（按期望文件名匹配，避开 Chrome 自己写进去的 downloads.htm）
        const midRunFile = await waitForDownload(downloadDir, '中途切标签_after.zip');

        check('转换完成后仍然正常下载', !!midRunFile, '没有等到下载文件');

        if (midRunFile) {
            const zipBytes = fs.readFileSync(midRunFile);
            const entries = readZipEntries(zipBytes);
            const mp3Entries = entries.filter(entry => entry.name.endsWith('.mp3'));
            const diagnostic = `文件名=${path.basename(midRunFile)} 大小=${zipBytes.length}B 头=${zipBytes.subarray(0, 4).toString('hex')} 条目=${JSON.stringify(entries.map(entry => entry.name))} 目录=${JSON.stringify(fs.readdirSync(downloadDir))}`;

            check('下载名没有被退化成 converted_lrc_时间戳（状态快照生效）', path.basename(midRunFile) === '中途切标签_after.zip', diagnostic);
            check('3 个音频都转码出来了', mp3Entries.length === 3, diagnostic);

            const withoutCover = mp3Entries.filter(entry => {
                const bytes = entry.data;

                return !(bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
                    !bytes.includes(Buffer.from('APIC'));
            });

            check(
                `每个 MP3 都带封面（缺封面的：${withoutCover.length} 个）`,
                withoutCover.length === 0,
                JSON.stringify(withoutCover.map(entry => entry.name))
            );
        }

        // --- 11. RJ 号 → 作品标题 / 封面 自动联动（用 mock 服务，不需要真部署 Worker）---
        console.log('\n[11] RJ 号自动查标题与封面');

        const rjResult = await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}

            const indexOfBytes = (haystack, needle) => {
                outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
                    for (let j = 0; j < needle.length; j++) {
                        if (haystack[i + j] !== needle[j]) continue outer;
                    }
                    return i;
                }
                return -1;
            };
            const ascii = text => Array.from(text).map(char => char.charCodeAt(0));

            // 造一张真 JPEG 当 DLsite 封面，挂成 blob URL 供 mock fetch 返回
            const canvas = document.createElement('canvas');
            canvas.width = 560;
            canvas.height = 420;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#123456';
            ctx.fillRect(0, 0, 560, 420);
            const coverBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
            const coverBlobUrl = URL.createObjectURL(coverBlob);

            const originalFetch = window.fetch;
            const fetched = [];

            window.fetch = (input, init) => {
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                fetched.push(url);

                if (url.includes('mock-rj.test')) {
                    return Promise.resolve(new Response(JSON.stringify({
                        ok: true,
                        rj: 'RJ344794',
                        title: '絶対にテスト用の作品タイトル',
                        circle: 'テストサークル',
                        voiceBy: ['分倍河原シホ'],
                        genres: ['音声', 'ASMR'],
                        workType: 'ボイス・ASMR',
                        releaseDate: '2022-05-13',
                        coverUrl: coverBlobUrl,
                        pageUrl: 'https://www.dlsite.com/maniax/work/=/product_id/RJ344794.html'
                    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                }

                return originalFetch(input, init);
            };

            RJ_METADATA_ENDPOINT = 'https://mock-rj.test';

            const source = new JSZip();
            source.file('RJ344794 测试作品/1.トラック.wav', makeTestWav({ frames: 22050 }));
            source.file('RJ344794 测试作品/1.トラック.wav.vtt', 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n台词\\n');

            const blob = await source.generateAsync({ type: 'blob' });

            switchTab('zip');
            document.getElementById('transcode-wav-checkbox').checked = true;

            // 压缩包文件名带 RJ 号，handleZipFile 内部会自动查询
            await handleZipFile(new File([blob], 'RJ344794 口淫担当女仆.zip', { type: 'application/zip' }));

            const uiState = {
                infoVisible: !document.getElementById('work-info').classList.contains('hidden'),
                title: document.getElementById('work-title').textContent,
                meta: document.getElementById('work-meta').textContent,
                link: document.getElementById('work-link').getAttribute('href'),
                coverVisible: !document.getElementById('work-cover').classList.contains('hidden'),
                coverSelected: !!selectedCoverImage,
                coverIsDlsite: !!(selectedCoverImage && selectedCoverImage.name.includes('RJ344794')),
                thumbCount: document.querySelectorAll('#image-preview-grid .image-thumb-wrapper').length,
                lookupCalled: fetched.some(url => url.includes('mock-rj.test'))
            };

            const { output } = await runEntriesInZip(createJob());
            const mp3Name = Object.keys(output.files).find(name => name.endsWith('.mp3'));
            const bytes = mp3Name ? await output.file(mp3Name).async('uint8array') : new Uint8Array(0);
            const headerText = new TextDecoder('utf-8').decode(bytes.slice(0, 3000));

            URL.revokeObjectURL(coverBlobUrl);
            window.fetch = originalFetch;

            return Object.assign(uiState, {
                mp3Name,
                hasApic: indexOfBytes(bytes, ascii('APIC')) >= 0,
                hasTalb: indexOfBytes(bytes, ascii('TALB')) >= 0,
                hasTpe1: indexOfBytes(bytes, ascii('TPE1')) >= 0,
                hasTit2: indexOfBytes(bytes, ascii('TIT2')) >= 0,
                headerText
            });
        })()`);

        check('压缩包文件名里的 RJ 号被识别并发起查询', rjResult.lookupCalled === true);
        check('作品信息面板显示出来', rjResult.infoVisible === true);
        check('标题取自 DLsite 元数据', rjResult.title === '絶対にテスト用の作品タイトル', rjResult.title);
        check('元信息含社团与声优', rjResult.meta.includes('テストサークル') && rjResult.meta.includes('分倍河原シホ'), rjResult.meta);
        check('DLsite 链接正确', (rjResult.link || '').includes('RJ344794'), String(rjResult.link));
        check('封面缩略图已加入预览并自动选中', rjResult.thumbCount >= 1 && rjResult.coverSelected === true && rjResult.coverIsDlsite === true);
        check('MP3 里有 APIC 封面帧', rjResult.hasApic === true);
        check('MP3 里有专辑帧 TALB（作品名）', rjResult.hasTalb === true && rjResult.headerText.includes('絶対にテスト用の作品タイトル'), '未找到 TALB 或标题');
        check('MP3 里有艺术家帧 TPE1（声优）', rjResult.hasTpe1 === true && rjResult.headerText.includes('分倍河原シホ'), '未找到 TPE1 或声优名');
        check('MP3 里保留曲名帧 TIT2', rjResult.hasTit2 === true && rjResult.headerText.includes('1.トラック'), '未找到 TIT2');

        // --- 12. 元数据服务不可用时不能拖垮流程 ---
        console.log('\n[12] RJ 查询失败时仍能正常转换');

        const rjFailResult = await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}

            const originalFetch = window.fetch;

            window.fetch = (input, init) => {
                const url = typeof input === 'string' ? input : (input && input.url) || '';

                if (url.includes('mock-fail.test')) {
                    return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'DLsite 返回 HTTP 429（可能是限流，稍后再试）' }), {
                        status: 502,
                        headers: { 'Content-Type': 'application/json' }
                    }));
                }

                return originalFetch(input, init);
            };

            RJ_METADATA_ENDPOINT = 'https://mock-fail.test';

            const source = new JSZip();
            source.file('RJ999999 无服务/1.曲.wav', makeTestWav({ frames: 11025 }));

            const blob = await source.generateAsync({ type: 'blob' });

            switchTab('zip');
            document.getElementById('transcode-wav-checkbox').checked = true;
            await handleZipFile(new File([blob], 'RJ999999 测试.zip', { type: 'application/zip' }));

            const status = document.getElementById('work-status').textContent;
            const { output, result } = await runEntriesInZip(createJob());

            window.fetch = originalFetch;

            return {
                status,
                names: Object.keys(output.files).filter(name => !output.files[name].dir),
                warnings: result.warnings
            };
        })()`);

        check('界面给出查询失败提示', rjFailResult.status.includes('查询') && rjFailResult.status.includes('失败'), rjFailResult.status);
        check('提示里带上服务返回的错误', rjFailResult.status.includes('429'), rjFailResult.status);
        check('查询失败不影响转码出 MP3', rjFailResult.names.some(name => name.endsWith('.mp3')), JSON.stringify(rjFailResult.names));

        // --- 13. 窄屏下标签都要能被真实鼠标点到 ---
        // 只点 element.click() 会掩盖"被 overflow-hidden 裁掉"这类问题，
        // 所以这里缩到 320px 宽并用 CDP 派发真实鼠标事件。
        console.log('\n[13] 窄屏 320px 下用真实鼠标点击标签页');

        await pageCdp.send('Emulation.setDeviceMetricsOverride', {
            width: 320,
            height: 800,
            deviceScaleFactor: 2,
            mobile: true
        });

        const reloadedForNarrow = pageCdp.once('Page.loadEventFired');

        await pageCdp.send('Page.reload', { ignoreCache: true });
        await reloadedForNarrow;
        await waitForDeps(100);
        await installPageHelpers(pageCdp);
        check('页面重载后测试工具仍可用', await evaluate(pageCdp, `typeof makeFakeDirectoryTree === 'function' && typeof runEntriesInZip === 'function'`));

        for (const [tabId, expectedTab] of [['tab-direct', 'direct'], ['tab-zip', 'zip'], ['tab-folder', 'folder']]) {
            const hit = await evaluate(pageCdp, `(() => {
                const tab = document.getElementById('${tabId}');
                const rect = tab.getBoundingClientRect();
                const nav = tab.parentElement;
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;

                return {
                    x: cx,
                    y: cy,
                    visible: rect.width > 0 && rect.left >= 0 && rect.right <= window.innerWidth,
                    hitTarget: document.elementFromPoint(cx, cy) === tab,
                    navOverflow: nav.scrollWidth > nav.clientWidth
                };
            })()`);

            await pageCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', clickCount: 1 });
            await pageCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', clickCount: 1 });
            await sleep(200);

            const state = await evaluate(pageCdp, 'currentTab');

            check(
                `${tabId} 在 320px 下可见、不被遮挡、点击后切到 ${expectedTab}`,
                hit.visible && hit.hitTarget && !hit.navOverflow && state === expectedTab,
                `可见=${hit.visible} 命中=${hit.hitTarget} 标签栏溢出=${hit.navOverflow} currentTab=${state}`
            );
        }

        check(
            '切到 ZIP 标签后 ZIP 选项区真的显示出来',
            await evaluate(pageCdp, `(() => {
                document.getElementById('tab-zip').click();

                return !document.getElementById('zip-options').classList.contains('hidden') &&
                    document.getElementById('folder-options').classList.contains('hidden');
            })()`)
        );

        check(
            '切到文件夹标签后文件夹选项区真的显示出来',
            await evaluate(pageCdp, `(() => {
                document.getElementById('tab-folder').click();

                return !document.getElementById('folder-options').classList.contains('hidden') &&
                    document.getElementById('zip-options').classList.contains('hidden');
            })()`)
        );

        // 恢复桌面宽度：后面几节要跑完整的文件夹流程
        await pageCdp.send('Emulation.clearDeviceMetricsOverride');

        // --- 14. 文件夹模式：写回原路径（核心新功能）---
        // 自动化工具点不动系统目录选择器，所以通过 window.__vttTestDirectoryProvider
        // 注入一个内存目录树，页面走的仍然是真实的那条写回流程。
        console.log('\n[14] 文件夹模式：扫描 → 确认清单 → 写回原路径');

        const folderResult = await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}
            ${READ_MP3_HEADER_SOURCE}

            const jpegCanvas = document.createElement('canvas');
            jpegCanvas.width = 300;
            jpegCanvas.height = 300;
            const ctx = jpegCanvas.getContext('2d');
            ctx.fillStyle = '#2244ff';
            ctx.fillRect(0, 0, 300, 300);
            const coverBytes = new Uint8Array(await (await new Promise(r => jpegCanvas.toBlob(r, 'image/jpeg', 0.9))).arrayBuffer());

            const handle = makeFakeDirectoryTree('RJ123456 测试作品', {
                '第一話/01.wav': makeTestWav({ frames: 22050, freq: 440 }),
                // 字幕按 01.vtt 命名，转出来就是 01.lrc，和 01.mp3 成对
                '第一話/01.vtt': 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n第一句台词\\n',
                '第一話/02.wav': makeTestWav({ frames: 22050, freq: 660 }),
                '第一話/02.vtt': 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n第二句台词\\n',
                '第一話/readme.txt': '这是原始文件，转换后不该被动过',
                '封面.jpg': coverBytes
            });

            handle.put('第一話/03_原有.mp3', new Uint8Array([0xff, 0xfb, 0x90, 0x00]));

            window.__vttTestDirectoryProvider = async () => handle;

            try {
                switchTab('folder');
                document.getElementById('folder-transcode-wav-checkbox').checked = true;

                await pickSourceFolder();

                const folderState = {
                    listText: document.getElementById('file-list').textContent,
                    note: document.getElementById('folder-note').textContent,
                    title: document.getElementById('file-list-title').textContent,
                    imageNames: [...document.querySelectorAll('#image-preview-grid .image-thumb-wrapper')].map(el => el.dataset.name),
                    vttCount: filesToProcess.length,
                    vttNames: filesToProcess.map(file => file.name),
                    scannedAll: folderFileCache.map(file => file.relPath).sort(),
                    supportText: document.getElementById('folder-status').textContent
                };

                // 点封面缩略图，验证文件夹里的图片能当封面用
                const coverThumb = [...document.querySelectorAll('#image-preview-grid .image-thumb-wrapper')]
                    .find(el => el.dataset.name === '封面.jpg');
                if (coverThumb) coverThumb.click();

                const before = handle.copy();
                const running = convertAndDownload();

                // 等确认弹窗出现（写回前必须先让用户过目）
                let modalVisible = false;
                for (let i = 0; i < 200 && !modalVisible; i++) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                    modalVisible = !document.getElementById('writeback-modal').classList.contains('hidden');
                }

                const modal = {
                    visible: modalVisible,
                    title: document.getElementById('writeback-title').textContent,
                    target: document.getElementById('writeback-target').textContent,
                    newFiles: [...document.querySelectorAll('#writeback-summary .writeback-heading.is-new + .writeback-list li')].map(el => el.textContent),
                    overwrites: [...document.querySelectorAll('#writeback-summary .writeback-heading.is-overwrite + .writeback-list li')].map(el => el.textContent)
                };

                // 先点一次取消：原文件夹必须一动不动
                document.getElementById('writeback-cancel').click();
                await running;

                const afterCancel = handle.copy();
                const cancelUntouched = JSON.stringify(Object.keys(before).sort()) === JSON.stringify(Object.keys(afterCancel).sort()) &&
                    handle.text('第一話/01.vtt').includes('第一句台词') &&
                    !handle.has('第一話/01.lrc') &&
                    !handle.has('第一話/01.mp3');

                const cancelStatus = document.getElementById('status-message').textContent;

                // 再来一次，这次确认写回
                const secondRun = convertAndDownload();

                for (let i = 0; i < 200 && document.getElementById('writeback-modal').classList.contains('hidden'); i++) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }

                document.getElementById('writeback-confirm').click();
                await secondRun;

                const mp3Bytes = handle.read('第一話/01.mp3');
                const lrcBytes = handle.read('第一話/01.lrc');
                const existingMp3Bytes = handle.read('第一話/03_原有.mp3');

                return {
                    folderState,
                    modal,
                    cancelUntouched,
                    cancelStatus,
                    list: handle.list().sort(),
                    logs: handle.logs.slice(),
                    status: document.getElementById('status-message').textContent,
                    lrc: lrcBytes ? new TextDecoder('utf-8').decode(lrcBytes) : null,
                    mp3Header: mp3Bytes ? readMp3Header(mp3Bytes) : null,
                    coverEmbedded: !!mp3Bytes && mp3Bytes.some((byte, index) => byte === 0x41 && mp3Bytes[index + 1] === 0x50 && mp3Bytes[index + 2] === 0x49 && mp3Bytes[index + 3] === 0x43),
                    existingMp3HasApic: !!existingMp3Bytes && existingMp3Bytes.some((byte, index) => byte === 0x41 && existingMp3Bytes[index + 1] === 0x50 && existingMp3Bytes[index + 2] === 0x49 && existingMp3Bytes[index + 3] === 0x43),
                    wavStillThere: handle.has('第一話/01.wav'),
                    txtUntouched: handle.text('第一話/readme.txt')
                };
            } finally {
                delete window.__vttTestDirectoryProvider;
            }
        })()`);

        const expectedFolderFiles = ['第一話/01.lrc', '第一話/01.mp3', '第一話/01.vtt', '第一話/01.wav', '第一話/02.lrc', '第一話/02.mp3', '第一話/02.vtt', '第一話/02.wav', '第一話/03_原有.mp3', '第一話/readme.txt', '封面.jpg'];
        const writeLogs = folderResult.logs.filter(line => line.startsWith('write') || line.startsWith('delete'));

        check('文件夹扫描到 VTT 文件', folderResult.folderState.vttCount === 2, `识别到 ${folderResult.folderState.vttCount} 个`);
        check('文件列表标题提示「写回原路径」', (folderResult.folderState.title || '').includes('写回原路径'), folderResult.folderState.title);
        check('文件夹选项区说明 WAV 会转码写回', (folderResult.folderState.note || '').includes('写回原路径'), folderResult.folderState.note);
        check('文件列表提示 WAV 将写回原路径', (folderResult.folderState.listText || '').includes('写回原路径'), folderResult.folderState.listText);
        check('文件夹里的图片进入封面候选', (folderResult.folderState.imageNames || []).includes('封面.jpg'), JSON.stringify(folderResult.folderState.imageNames));
        check('写回前弹出确认清单', folderResult.modal.visible === true, '没等到确认弹窗');
        check('清单里列出目标文件夹与写入数量', (folderResult.modal.target || '').includes('RJ123456 测试作品') && folderResult.modal.target.includes('5 个文件'), folderResult.modal.target);
        check(
            '清单里新增文件与覆盖文件分开列',
            sameSet(folderResult.modal.newFiles, ['第一話/01.mp3', '第一話/01.lrc', '第一話/02.mp3', '第一話/02.lrc']) &&
                sameSet(folderResult.modal.overwrites, ['第一話/03_原有.mp3']),
            JSON.stringify({ newFiles: folderResult.modal.newFiles, overwrites: folderResult.modal.overwrites })
        );
        check('取消后原文件夹没有任何改动', folderResult.cancelUntouched === true, JSON.stringify(folderResult.list));
        check('取消时给出明确提示', (folderResult.cancelStatus || '').includes('已取消写回'), folderResult.cancelStatus);
        check('转码结果写回原目录', sameSet(folderResult.list, expectedFolderFiles), JSON.stringify(folderResult.list));
        check('原 WAV 默认保留（没勾删除）', folderResult.wavStillThere === true, JSON.stringify(folderResult.list));
        check('LRC 内容正确', folderResult.lrc === '[00:00.00]第一句台词\n', JSON.stringify(folderResult.lrc));
        check('写回的 MP3 是 320 kbps / 44.1 kHz', folderResult.mp3Header && folderResult.mp3Header.bitrate === 320 && folderResult.mp3Header.sampleRate === 44100, JSON.stringify(folderResult.mp3Header));
        check('封面被写进转码出来的 MP3（APIC）', folderResult.coverEmbedded === true);
        check('已有的 MP3 也补上了封面', folderResult.existingMp3HasApic === true);
        check('无关文件（readme.txt）原样保留', folderResult.txtUntouched === '这是原始文件，转换后不该被动过', String(folderResult.txtUntouched));
        check('4 个转码/字幕结果 + 1 个封面写入，且不删任何文件', writeLogs.length === 5 && !folderResult.logs.some(line => line.startsWith('delete')), JSON.stringify(folderResult.logs));
        check('完成后汇报写入结果', (folderResult.status || '').includes('已写入 5 个文件'), folderResult.status);

        // --- 15. 文件夹模式：剪掉源文件 ---
        console.log('\n[15] 文件夹模式：勾选「剪掉源文件」后删除原 WAV / VTT');

        const cutResult = await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}

            const handle = makeFakeDirectoryTree('剪源测试', {
                '01.wav': makeTestWav({ frames: 11025 }),
                '01.wav.vtt': 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n台词\\n'
            });

            window.__vttTestDirectoryProvider = async () => handle;

            try {
                switchTab('folder');
                document.getElementById('folder-transcode-wav-checkbox').checked = true;
                document.getElementById('folder-delete-source-checkbox').checked = true;

                await pickSourceFolder();

                const running = convertAndDownload();

                for (let i = 0; i < 200 && document.getElementById('writeback-modal').classList.contains('hidden'); i++) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }

                const deletes = [...document.querySelectorAll('#writeback-summary .writeback-heading.is-delete + .writeback-list li')].map(el => el.textContent);
                const irreversibleWarning = document.getElementById('writeback-summary').textContent.includes('不可撤销');

                document.getElementById('writeback-confirm').click();
                await running;

                return {
                    deletes,
                    irreversibleWarning,
                    list: handle.list().sort(),
                    status: document.getElementById('status-message').textContent,
                    hasLrc: handle.has('01.lrc'),
                    hasMp3: handle.has('01.mp3')
                };
            } finally {
                delete window.__vttTestDirectoryProvider;
                document.getElementById('folder-delete-source-checkbox').checked = false;
            }
        })()`);

        check('清单里预告要删除的源文件', JSON.stringify(cutResult.deletes) === JSON.stringify(['01.wav', '01.wav.vtt']), JSON.stringify(cutResult.deletes));
        check('清单里写明删除不可撤销', cutResult.irreversibleWarning === true);
        check('原 WAV 与 VTT 已删除，只剩结果', JSON.stringify(cutResult.list) === JSON.stringify(['01.lrc', '01.mp3']), JSON.stringify(cutResult.list));
        check('转码结果都留下了', cutResult.hasMp3 === true && cutResult.hasLrc === true);
        check('完成后汇报删除数量', (cutResult.status || '').includes('删除了 2 个源文件'), cutResult.status);

        // --- 16. 文件夹模式：内容没变就不重复写 ---
        console.log('\n[16] 文件夹模式：内容没变时跳过重复写入');

        const idempotentResult = await evaluate(pageCdp, `(async () => {
            const handle = makeFakeDirectoryTree('重复写测试', {
                '01.wav.vtt': 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n台词\\n'
            });

            window.__vttTestDirectoryProvider = async () => handle;

            async function runOnce() {
                await pickSourceFolder();

                const running = convertAndDownload();

                for (let i = 0; i < 200 && document.getElementById('writeback-modal').classList.contains('hidden'); i++) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }

                const overwrites = [...document.querySelectorAll('#writeback-summary .writeback-heading.is-overwrite + .writeback-list li')].map(el => el.textContent);
                const newFiles = [...document.querySelectorAll('#writeback-summary .writeback-heading.is-new + .writeback-list li')].map(el => el.textContent);

                document.getElementById('writeback-confirm').click();
                await running;

                return { overwrites, newFiles, status: document.getElementById('status-message').textContent };
            }

            try {
                switchTab('folder');

                const first = await runOnce();
                const writesAfterFirst = handle.logs.filter(line => line.startsWith('write')).length;
                const second = await runOnce();
                const writesAfterSecond = handle.logs.filter(line => line.startsWith('write')).length;

                return {
                    lrc: handle.text('01.lrc'),
                    first,
                    second,
                    writesAfterFirst,
                    writesAfterSecond
                };
            } finally {
                delete window.__vttTestDirectoryProvider;
            }
        })()`);

        check('第一次写回了 LRC', idempotentResult.lrc === '[00:00.00]台词\n', JSON.stringify(idempotentResult.lrc));
        check('第一次清单里是「新增文件」', JSON.stringify(idempotentResult.first.newFiles) === JSON.stringify(['01.lrc']), JSON.stringify(idempotentResult.first));
        check('第二次清单里标为「覆盖原文件」', JSON.stringify(idempotentResult.second.overwrites) === JSON.stringify(['01.lrc']), JSON.stringify(idempotentResult.second));
        check('内容一致时不再重复写盘', idempotentResult.writesAfterSecond === idempotentResult.writesAfterFirst, `写盘次数 ${idempotentResult.writesAfterFirst} → ${idempotentResult.writesAfterSecond}`);
        check('状态里说明跳过了多少个', (idempotentResult.second.status || '').includes('内容相同已跳过'), idempotentResult.second.status);

        // --- 17. 文件夹模式：只读句柄降级为打包下载 ---
        console.log('\n[17] 文件夹模式：只读文件夹降级为打包下载');

        const readOnlyResult = await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}

            const writable = makeFakeDirectoryTree('只读测试', {
                '作品A/歌曲.wav': makeTestWav({ frames: 11025 }),
                '作品A/歌曲.wav.vtt': 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n只读的歌词\\n'
            });

            // 只读句柄：没有 removeEntry（拖拽进来的目录在旧浏览器上就是这个形态）
            const readOnly = {
                name: writable.name,
                kind: 'directory',
                values: writable.values,
                getDirectoryHandle: writable.getDirectoryHandle,
                getFileHandle: writable.getFileHandle
            };

            window.__vttTestDirectoryProvider = async () => readOnly;

            try {
                switchTab('folder');
                document.getElementById('folder-transcode-wav-checkbox').checked = true;

                await pickSourceFolder();

                const job = createJob();
                const writeBackPathUsed = job.sourceKind === 'folder' && job.directoryWritable;
                const { output } = await runEntriesInZip(job);

                return {
                    directoryWritable: job.directoryWritable,
                    writeBackPathUsed,
                    names: Object.keys(output.files).filter(name => !output.files[name].dir).sort(),
                    downloadName: getDownloadName(job),
                    untouched: writable.list().sort()
                };
            } finally {
                delete window.__vttTestDirectoryProvider;
            }
        })()`);

        check('只读句柄不进入写回分支', readOnlyResult.writeBackPathUsed === false && readOnlyResult.directoryWritable === false);
        check('只读时输出 MP3 + LRC 供打包下载', readOnlyResult.names.some(name => name.endsWith('歌曲.mp3')) && readOnlyResult.names.some(name => name.endsWith('歌曲.lrc')), JSON.stringify(readOnlyResult.names));
        check('只读时下载名基于文件夹名', readOnlyResult.downloadName === '只读测试_after.zip', readOnlyResult.downloadName);
        check('只读文件夹没有被改动', JSON.stringify(readOnlyResult.untouched) === JSON.stringify(['作品A/歌曲.wav', '作品A/歌曲.wav.vtt']), JSON.stringify(readOnlyResult.untouched));

        // --- 18. 文件夹模式：平铺 ---
        // 平铺时路径会被压平，重名靠"加路径前缀"解决；这里验证压平后
        // LRC 仍然和 MP3 同名配对，且源文件一个都不会被删。
        console.log('\n[18] 文件夹模式：平铺后仍然同名配对');

        const flattenResult = await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}

            const handle = makeFakeDirectoryTree('平铺测试', {
                '作品A/歌曲.wav': makeTestWav({ frames: 11025, freq: 440 }),
                '作品A/歌曲.wav.vtt': 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\nA 歌词\\n',
                '作品B/歌曲.wav': makeTestWav({ frames: 11025, freq: 660 }),
                '作品B/歌曲.wav.vtt': 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\nB 歌词\\n'
            });

            window.__vttTestDirectoryProvider = async () => handle;

            try {
                switchTab('folder');
                document.getElementById('folder-transcode-wav-checkbox').checked = true;
                document.getElementById('folder-flatten-checkbox').checked = true;

                await pickSourceFolder();

                const running = convertAndDownload();

                for (let i = 0; i < 200 && document.getElementById('writeback-modal').classList.contains('hidden'); i++) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }

                const summaryText = document.getElementById('writeback-summary').textContent;
                const skipped = [...document.querySelectorAll('#writeback-summary .writeback-heading.is-skip + .writeback-list li')].map(el => el.textContent);
                const modalTarget = document.getElementById('writeback-target').textContent;

                document.getElementById('writeback-confirm').click();
                await running;

                const listAfter = handle.list().sort();
                const lrcStems = listAfter.filter(name => name.endsWith('.lrc')).map(name => name.replace(/\\.lrc$/, ''));
                const mp3Stems = listAfter.filter(name => name.endsWith('.mp3')).map(name => name.replace(/\\.mp3$/, ''));
                // 平铺是"搬"而不是"复制"：源文件应当已经不在子目录里了
                const sourcesMoved = ['作品A/歌曲.wav', '作品B/歌曲.wav', '作品A/歌曲.wav.vtt', '作品B/歌曲.wav.vtt']
                    .every(relPath => !handle.has(relPath));

                return {
                    flattenWarning: summaryText.includes('平铺'),
                    skipped,
                    modalTarget,
                    listAfter,
                    lrcStems,
                    mp3Stems,
                    paired: lrcStems.length === 2 && lrcStems.every(stem => mp3Stems.includes(stem)),
                    sourcesMoved,
                    status: document.getElementById('status-message').textContent
                };
            } finally {
                delete window.__vttTestDirectoryProvider;
                document.getElementById('folder-flatten-checkbox').checked = false;
            }
        })()`);

        check('平铺时弹窗里给出重名风险提示', flattenResult.flattenWarning === true, JSON.stringify(flattenResult.modalTarget));
        check('两个作品都平铺到根目录', flattenResult.listAfter.filter(name => !name.includes('/')).length === 4, JSON.stringify(flattenResult.listAfter));
        check(
            `平铺后 LRC 与 MP3 依然同名配对（LRC: ${flattenResult.lrcStems.join(', ')} / MP3: ${flattenResult.mp3Stems.join(', ')}）`,
            flattenResult.paired === true,
            JSON.stringify(flattenResult.listAfter)
        );
        check('本次没有真重名，跳过列表为空', flattenResult.skipped.length === 0, JSON.stringify(flattenResult.skipped));
        check('平铺后源文件已从子目录搬走（不是复制一份）', flattenResult.sourcesMoved === true, JSON.stringify(flattenResult.listAfter));

        // --- 19. 文件夹模式：平铺后被搬空的子目录要一起收掉 ---
        // 用户真实反馈：平铺后 MP3 跑到根目录了，原来的子文件夹还留在原地，
        // 和压缩包模式的平铺不一致。这里要求"清空后变空"的子目录一起删掉。
        console.log('\n[19] 文件夹模式：平铺后清理被搬空的子目录');

        const flattenCleanupResult = await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}

            const handle = makeFakeDirectoryTree('RJ324692_测试作品', {
                '第一話/01.wav': makeTestWav({ frames: 11025, freq: 440 }),
                '第一話/01.wav.vtt': 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n第一话台词\\n',
                '第二話/02.wav': makeTestWav({ frames: 11025, freq: 660 }),
                '第二話/02.wav.vtt': 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n第二话台词\\n',
                // 非处理对象（不会被转码/转换），平铺时也应该被搬到根目录
                '第一話/info.txt': '第一话的说明',
                '第二話/info.txt': '第二话的说明',
                '第一話/插图.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
                '封面.jpg': new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])
            });

            window.__vttTestDirectoryProvider = async () => handle;

            try {
                switchTab('folder');
                document.getElementById('folder-transcode-wav-checkbox').checked = true;
                document.getElementById('folder-flatten-checkbox').checked = true;

                await pickSourceFolder();

                const running = convertAndDownload();

                for (let i = 0; i < 200 && document.getElementById('writeback-modal').classList.contains('hidden'); i++) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }

                const cleanupListed = [...document.querySelectorAll('#writeback-summary .writeback-heading.is-rmdir + .writeback-list li')].map(el => el.textContent);
                const summaryText = document.getElementById('writeback-summary').textContent;

                document.getElementById('writeback-confirm').click();
                await running;

                return {
                    cleanupListed,
                    mentionsEmptyDirs: summaryText.includes('清理空目录') && summaryText.includes('删除前会再确认一次'),
                    listAfter: handle.list().sort(),
                    // 两个 info.txt 谁拿到原名取决于扫描顺序（中文排序里 第二話 在 第一話 前面），
                    // 所以这里只收集内容，不绑定具体是哪一个
                    infoTexts: handle.list()
                        .filter(name => name.endsWith('info.txt'))
                        .map(name => handle.text(name))
                        .sort(),
                    rmdirLogs: handle.logs.filter(line => line.startsWith('rmdir')),
                    status: document.getElementById('status-message').textContent
                };
            } finally {
                delete window.__vttTestDirectoryProvider;
                document.getElementById('folder-flatten-checkbox').checked = false;
            }
        })()`);

        check('确认清单里预告会清理空目录', sameSet(flattenCleanupResult.cleanupListed, ['第一話', '第二話']) && flattenCleanupResult.mentionsEmptyDirs === true, JSON.stringify(flattenCleanupResult.cleanupListed));
        check(
            '平铺后整个目录树都被展开，子目录里的文件全在根目录',
            sameSet(flattenCleanupResult.listAfter, ['01.lrc', '01.mp3', '02.lrc', '02.mp3', 'info.txt', '第一話_info.txt', '插图.png', '封面.jpg']),
            JSON.stringify(flattenCleanupResult.listAfter)
        );
        check('非处理对象（info.txt / 插图.png）也被搬到根目录', flattenCleanupResult.listAfter.includes('info.txt') && flattenCleanupResult.listAfter.includes('插图.png'), JSON.stringify(flattenCleanupResult.listAfter));
        check('两个子目录里的同名 info.txt 都还在，内容各自保留', sameSet(flattenCleanupResult.infoTexts, ['第一话的说明', '第二话的说明']), JSON.stringify(flattenCleanupResult.infoTexts));
        check('删除的是目录而不是文件', sameSet(flattenCleanupResult.rmdirLogs, ['rmdir 第一話', 'rmdir 第二話']), JSON.stringify(flattenCleanupResult.rmdirLogs));
        check('汇报里带上清理数量与搬动数量', (flattenCleanupResult.status || '').includes('清理了 2 个空目录') && (flattenCleanupResult.status || '').includes('搬动 3 个原样保留的文件'), flattenCleanupResult.status);
        // 回归：搬动过的源文件曾被删两次，第二次必然 NotFound，于是同一条路径既算"已删除"
        // 又算"失败"，报告自相矛盾。搬动成功就该是干净的"0 失败"。
        check('删源文件不会重复删除导致虚报失败', !(flattenCleanupResult.status || '').includes('失败'), flattenCleanupResult.status);
        // 4 个转码/字幕源文件 + 3 个搬动文件 = 7 个原位置被清掉，且不该出现重复删除
        check('删除数量与实际相符', (flattenCleanupResult.status || '').includes('删除了 7 个源文件'), flattenCleanupResult.status);

        // --- 20. 文件夹模式：清理空目录前必须重新确认真空 ---
        // 规划只看得到"扫描进来的文件"，而扫描会刻意跳过 node_modules 这类目录。
        // 于是规划以为 第一話 会被搬空，但它其实还压着 node_modules——删之前
        // 必须重新列一次目录，否则会把还有内容的目录整个删掉。
        console.log('\n[20] 文件夹模式：清理空目录前重新确认真空');

        const flattenKeepResult = await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}

            const handle = makeFakeDirectoryTree('保留测试', {
                '第一話/01.wav': makeTestWav({ frames: 11025 }),
                '第一話/01.wav.vtt': 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n台词\\n',
                // 扫描阶段会被跳过的目录：它没进清单，所以规划以为父目录会空
                '第一話/node_modules/dep/index.js': 'module.exports = 1;'
            });

            window.__vttTestDirectoryProvider = async () => handle;

            try {
                switchTab('folder');
                document.getElementById('folder-transcode-wav-checkbox').checked = true;
                document.getElementById('folder-flatten-checkbox').checked = true;

                await pickSourceFolder();

                const running = convertAndDownload();

                for (let i = 0; i < 200 && document.getElementById('writeback-modal').classList.contains('hidden'); i++) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }

                const cleanupListed = [...document.querySelectorAll('#writeback-summary .writeback-heading.is-rmdir + .writeback-list li')].map(el => el.textContent);

                document.getElementById('writeback-confirm').click();
                await running;

                return {
                    cleanupListed,
                    listAfter: handle.list().sort(),
                    depText: handle.text('第一話/node_modules/dep/index.js'),
                    rmdirLogs: handle.logs.filter(line => line.startsWith('rmdir')),
                    status: document.getElementById('status-message').textContent
                };
            } finally {
                delete window.__vttTestDirectoryProvider;
                document.getElementById('folder-flatten-checkbox').checked = false;
            }
        })()`);

        check('该子目录被列为清理候选', sameSet(flattenKeepResult.cleanupListed, ['第一話']), JSON.stringify(flattenKeepResult.cleanupListed));
        check('删之前重新确认发现它还有内容，于是没有删', flattenKeepResult.rmdirLogs.length === 0, JSON.stringify(flattenKeepResult.rmdirLogs));
        check('被跳过的子目录与里面的文件都完好', flattenKeepResult.depText === 'module.exports = 1;' && flattenKeepResult.listAfter.includes('第一話/node_modules/dep/index.js'), JSON.stringify(flattenKeepResult.listAfter));
        check('平铺的音频结果仍然落在根目录', flattenKeepResult.listAfter.includes('01.mp3') && flattenKeepResult.listAfter.includes('01.lrc'), JSON.stringify(flattenKeepResult.listAfter));
        check('汇报里不会虚报清理数量', !(flattenKeepResult.status || '').includes('清理了'), flattenKeepResult.status);

        // --- 21. 文件夹模式：Firefox / Safari 的降级入口 ---
        // 这两个浏览器没有 showDirectoryPicker，点按钮应该直接走 <input webkitdirectory>，
        // 并且在页面上说明"只能读、结果打包下载"，而不是报错或没反应。
        console.log('\n[21] 文件夹模式：不支持写入时的降级入口');

        const degradeEntryResult = await evaluate(pageCdp, `(async () => {
            const originalIsSupported = FolderFs.isSupported;
            const input = document.getElementById('file-input-folder');
            const originalClick = input.click;
            let clickCount = 0;

            input.click = () => { clickCount++; };

            const makeFile = (relativePath, text) => {
                const file = new File([text], relativePath.split('/').pop(), { type: 'text/vtt' });

                Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });

                return file;
            };

            try {
                // 模拟"浏览器没有 File System Access API"
                FolderFs.isSupported = options => (options && typeof options.supported === 'boolean' ? options.supported : false);
                updateFolderSupport();

                switchTab('folder');

                const hintBefore = document.getElementById('folder-status').textContent;
                const hintIsWarning = document.getElementById('folder-status').className.includes('amber');

                await pickSourceFolder();

                const clickedInput = clickCount === 1;
                const clickedWithNoHandleApi = !document.getElementById('writeback-modal') ||
                    document.getElementById('writeback-modal').classList.contains('hidden');

                // 用户在系统选择器里挑完文件夹 → change 事件走的是同一个降级入口
                const transfer = new DataTransfer();

                transfer.items.add(makeFile('作品/第一話.vtt', 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n降级第一句\\n'));
                transfer.items.add(makeFile('作品/第二話.vtt', 'WEBVTT\\n\\n00:02.000 --> 00:04.000\\n降级第二句\\n'));

                input.files = transfer.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));

                // change 处理器是异步的（要扫目录），必须等它把 filesToProcess 填好
                for (let i = 0; i < 100 && filesToProcess.length === 0; i++) {
                    await new Promise(resolve => setTimeout(resolve, 20));
                }

                const job = createJob();
                const entriesDirect = await buildVirtualEntries(job);
                const output = new JSZip();
                const fillResult = await fillZipFromEntries(output, entriesDirect, job);

                return {
                    hintBefore,
                    hintIsWarning,
                    clickedInput,
                    clickedWithNoHandleApi,
                    sourceKind: job.sourceKind,
                    writable: job.directoryWritable,
                    rootName: job.folderRootName,
                    count: filesToProcess.length,
                    vttNames: filesToProcess.map(file => file.name),
                    scanned: folderFileCache ? folderFileCache.map(file => file.relPath).sort() : null,
                    warnings: fillResult.warnings,
                    names: Object.keys(output.files).filter(name => !output.files[name].dir).sort(),
                    downloadName: getDownloadName(job)
                };
            } finally {
                FolderFs.isSupported = originalIsSupported;
                input.click = originalClick;
                updateFolderSupport();
            }
        })()`);

        check('不支持时页面明确提示会降级为打包下载', (degradeEntryResult.hintBefore || '').includes('打包成 ZIP') && degradeEntryResult.hintIsWarning === true, degradeEntryResult.hintBefore);
        check('点按钮直接改走 <input webkitdirectory>', degradeEntryResult.clickedInput === true);
        check('降级入口不会弹出写回清单', degradeEntryResult.clickedWithNoHandleApi === true);
        check('降级后仍能正常读入并转换', degradeEntryResult.count === 2 && degradeEntryResult.sourceKind === 'folder', JSON.stringify(degradeEntryResult));        check('降级路径不可写', degradeEntryResult.writable === false);
        check('降级输出为 LRC 打包下载', sameSet(degradeEntryResult.names, ['第一話.lrc', '第二話.lrc']) && degradeEntryResult.downloadName === '作品_after.zip', JSON.stringify(degradeEntryResult));

        // --- 22. 文件夹模式：目录选择器失败时必须自动降级 ---
        // 线上真实反馈"点了没反应"：showDirectoryPicker() 在缺少用户激活 / 权限被拒 /
        // 系统不支持时会抛错，旧代码只弹一行报错就结束，用户看到的就是点了没动静。
        console.log('\n[22] 文件夹模式：目录选择器失败后自动降级');

        const pickerFailResult = await evaluate(pageCdp, `(async () => {
            const makeFile = (relativePath, text) => {
                const file = new File([text], relativePath.split('/').pop(), { type: 'text/vtt' });

                Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });

                return file;
            };

            const originalPicker = window.showDirectoryPicker;
            const input = document.getElementById('file-input-folder');
            const originalClick = input.click;

            // 模拟 picker 抛错；同时接管 input.click()：真实浏览器里这会打开系统目录选择器，
            // 自动化环境里则直接替用户"选好"一个文件夹
            window.showDirectoryPicker = async () => {
                throw new DOMException('需要用户激活', 'SecurityError');
            };

            input.click = () => {
                const transfer = new DataTransfer();

                transfer.items.add(makeFile('作品/第一話.vtt', 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n降级第一句\\n'));
                transfer.items.add(makeFile('作品/第二話.vtt', 'WEBVTT\\n\\n00:02.000 --> 00:04.000\\n降级第二句\\n'));

                input.files = transfer.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
            };

            try {
                switchTab('folder');
                await pickSourceFolder();

                // change 处理器是异步的，等它把清单填好
                for (let i = 0; i < 100 && filesToProcess.length === 0; i++) {
                    await new Promise(resolve => setTimeout(resolve, 20));
                }

                const job = createJob();
                const { output } = await runEntriesInZip(job);
                const names = Object.keys(output.files).filter(name => !output.files[name].dir).sort();

                return {
                    status: document.getElementById('status-message').textContent,
                    folderStatus: document.getElementById('folder-status').textContent,
                    hintIsWarning: document.getElementById('folder-status').className.includes('amber'),
                    buttonLabel: document.getElementById('btn-text').textContent,
                    count: filesToProcess.length,
                    writable: job.directoryWritable,
                    names
                };
            } finally {
                window.showDirectoryPicker = originalPicker;
                input.click = originalClick;
            }
        })()`);

        check('目录选择器失败后自动降级为只读读入', pickerFailResult.count === 2, JSON.stringify(pickerFailResult));
        check('并且说明了失败原因与降级结果', (pickerFailResult.folderStatus || '').includes('SecurityError') && (pickerFailResult.folderStatus || '').includes('打包成 ZIP 下载') && pickerFailResult.hintIsWarning === true, pickerFailResult.folderStatus);
        check('降级后按钮文案变成打包下载', pickerFailResult.buttonLabel === '转换并下载 ZIP', pickerFailResult.buttonLabel);
        check('降级后仍能正常转换', sameSet(pickerFailResult.names, ['第一話.lrc', '第二話.lrc']), JSON.stringify(pickerFailResult.names));

        // --- 23. 文件夹模式：<input webkitdirectory> 的路径还原 ---
        console.log('\n[23] 文件夹模式：webkitdirectory 的目录层级还原');

        const degradeResult = await evaluate(pageCdp, `(async () => {
            const makeFile = (relativePath, text) => {
                const file = new File([text], relativePath.split('/').pop(), { type: 'text/vtt' });

                Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });

                return file;
            };

            const files = [
                makeFile('作品/第一話.vtt', 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n降级路径\\n'),
                makeFile('作品/第二話.vtt', 'WEBVTT\\n\\n00:02.000 --> 00:04.000\\n第二句\\n'),
                new File([new Uint8Array([1, 2, 3])], 'ignore.bin', { type: 'application/octet-stream' })
            ];

            switchTab('folder');
            await handleFolderInputFiles(files);

            const job = createJob();
            const { output } = await runEntriesInZip(job);
            const names = Object.keys(output.files).filter(name => !output.files[name].dir).sort();
            const contents = [];

            for (const name of names) contents.push([name, await output.file(name).async('string')]);

            return {
                sourceKind: job.sourceKind,
                writable: job.directoryWritable,
                rootName: job.folderRootName,
                count: filesToProcess.length,
                names,
                contents,
                downloadName: getDownloadName(job)
            };
        })()`);

        check('webkitdirectory 降级路径能读入文件夹', degradeResult.count === 2 && degradeResult.sourceKind === 'folder', JSON.stringify(degradeResult));
        check('降级路径不可写（只打包下载）', degradeResult.writable === false);
        check('降级路径的下载名基于根目录名', degradeResult.downloadName === '作品_after.zip', degradeResult.downloadName);
        check(
            '保留目录结构输出 LRC，非处理文件原样进包',
            sameSet(degradeResult.names, ['第一話.lrc', '第二話.lrc', 'ignore.bin']),
            JSON.stringify(degradeResult.names)
        );
        check('降级路径的 LRC 内容正确', JSON.stringify(degradeResult.contents.filter(([name]) => name.endsWith('.lrc'))) === JSON.stringify([['第一話.lrc', '[00:00.00]降级路径\n'], ['第二話.lrc', '[00:02.00]第二句\n']]), JSON.stringify(degradeResult.contents));

        // --- 24. 文件夹模式：把文件夹拖进来 ---
        // 真实拖拽事件 CDP 没法伪造出 FileSystemDirectoryEntry，所以这里只伪造
        // DataTransfer 的形状（items[0].webkitGetAsEntry() → 目录 entry → entry.handle），
        // 页面里的 handleFolderDrop 逻辑是原封不动跑的。
        console.log('\n[24] 文件夹模式：拖拽文件夹进入');

        const dropResult = await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}

            const handle = makeFakeDirectoryTree('拖入的作品', {
                '第一話/01.wav': makeTestWav({ frames: 11025 }),
                '第一話/01.vtt': 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n拖进来的台词\\n'
            });

            const makeDataTransfer = entries => ({
                items: entries.map(entry => ({
                    kind: 'file',
                    webkitGetAsEntry: () => entry
                })),
                files: []
            });

            switchTab('folder');

            // 1) 拖进来的不是文件夹：要给出明确提示，而不是静默失败
            await handleFolderDrop(makeDataTransfer([{ isDirectory: false }]));

            const notFolderStatus = document.getElementById('status-message').textContent;
            const notFolderCleared = filesToProcess.length === 0 && !folderStore;

            // 2) 真的拖进来一个文件夹
            await handleFolderDrop(makeDataTransfer([{ isDirectory: true, handle: Promise.resolve(handle) }]));

            const job = createJob();
            const { output } = await runEntriesInZip(job);

            return {
                notFolderStatus,
                notFolderCleared,
                rootName: job.folderRootName,
                writable: job.directoryWritable,
                count: filesToProcess.length,
                listText: document.getElementById('file-list').textContent,
                names: Object.keys(output.files).filter(name => !output.files[name].dir).sort()
            };
        })()`);

        check('拖进非文件夹时给出提示', (dropResult.notFolderStatus || '').includes('文件夹'), dropResult.notFolderStatus);
        check('拖进非文件夹不会污染已有状态', dropResult.notFolderCleared === true);
        check('拖入文件夹后能识别目录名', dropResult.rootName === '拖入的作品', String(dropResult.rootName));
        check('拖入的目录同样是可写的', dropResult.writable === true);
        check('拖入的目录被扫描出 VTT', dropResult.count === 1, `识别到 ${dropResult.count} 个`);
        check('拖入的目录能正常转换', sameSet(dropResult.names, ['第一話/01.lrc', '第一話/01.mp3']), JSON.stringify(dropResult.names));

        // --- 25. 文件夹模式：用真实 File System Access 句柄跑一遍 ---
        // 前面的用例用的是内存假目录；这一节改用 OPFS（源私有文件系统）拿到的
        // 真 FileSystemDirectoryHandle / FileSystemWritableFileStream，
        // 检验真实浏览器 API 的调用方式（values() 递归、createWritable、removeEntry）没问题。
        console.log('\n[25] 文件夹模式：真实 File System Access 句柄（OPFS）');

        const opfsResult = await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}
            ${READ_MP3_HEADER_SOURCE}

            if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
                return { skipped: '这个浏览器没有 OPFS' };
            }

            let root;

            try {
                root = await navigator.storage.getDirectory();
            } catch (error) {
                return { skipped: error.message };
            }

            const dirName = 'vtt-real-fs-test-' + Date.now();
            const handle = await root.getDirectoryHandle(dirName, { create: true });
            const sub = await handle.getDirectoryHandle('第一話', { create: true });

            const writeReal = async (dirHandle, name, data) => {
                const fileHandle = await dirHandle.getFileHandle(name, { create: true });
                const writable = await fileHandle.createWritable();

                await writable.write(data);
                await writable.close();
            };

            await writeReal(sub, '01.wav', makeTestWav({ frames: 22050 }));
            await writeReal(sub, '01.wav.vtt', 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n真句柄台词\\n');
            // 非音频/字幕文件的读取路径用的是原生的 File.text()，和假目录树不一样，所以也造一个
            await writeReal(sub, 'note.txt', '真实目录里的普通文件');

            window.__vttTestDirectoryProvider = async () => handle;

            try {
                switchTab('folder');
                document.getElementById('folder-transcode-wav-checkbox').checked = true;

                await pickSourceFolder();

                const scanned = folderFileCache.map(file => file.relPath).sort();
                const isRealHandle = typeof handle.removeEntry === 'function' &&
                    typeof handle.getDirectoryHandle === 'function' &&
                    typeof (await (await sub.getFileHandle('01.wav')).createWritable) === 'function';

                const running = convertAndDownload();

                for (let i = 0; i < 200 && document.getElementById('writeback-modal').classList.contains('hidden'); i++) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }

                const modalVisible = !document.getElementById('writeback-modal').classList.contains('hidden');

                document.getElementById('writeback-confirm').click();
                await running;

                const listAfter = [];

                for await (const child of handle.values()) listAfter.push(child.name);

                const subAfter = [];

                for await (const child of (await handle.getDirectoryHandle('第一話')).values()) subAfter.push(child.name);

                const readReal = async name => {
                    const fileHandle = await (await handle.getDirectoryHandle('第一話')).getFileHandle(name);
                    const bytes = new Uint8Array(await (await fileHandle.getFile()).arrayBuffer());

                    return { bytes, text: new TextDecoder('utf-8').decode(bytes) };
                };

                const lrc = await readReal('01.lrc');
                const mp3 = await readReal('01.mp3');
                const note = await readReal('note.txt');

                await root.removeEntry(dirName, { recursive: true });

                return {
                    skipped: null,
                    isRealHandle,
                    scanned,
                    modalVisible,
                    listAfter: listAfter.sort(),
                    subAfter: subAfter.sort(),
                    lrcText: lrc.text,
                    mp3Header: readMp3Header(mp3.bytes),
                    mp3Size: mp3.bytes.length,
                    noteText: note.text,
                    status: document.getElementById('status-message').textContent
                };
            } finally {
                delete window.__vttTestDirectoryProvider;
            }
        })()`);

        if (opfsResult.skipped) {
            console.log(`  （跳过：${opfsResult.skipped}）`);
        } else {
            check('拿到的是真实 FileSystemDirectoryHandle', opfsResult.isRealHandle === true);
            check('真实目录递归扫描正确（含非处理文件）', sameSet(opfsResult.scanned, ['第一話/01.wav', '第一話/01.wav.vtt', '第一話/note.txt']), JSON.stringify(opfsResult.scanned));
            check('真实目录也走写回确认流程', opfsResult.modalVisible === true);
            check('真实目录里生成了 01.mp3 / 01.lrc', sameSet(opfsResult.subAfter, ['01.lrc', '01.mp3', '01.wav', '01.wav.vtt', 'note.txt']), JSON.stringify(opfsResult.subAfter));
            check('真实写入的 LRC 内容正确', opfsResult.lrcText === '[00:00.00]真句柄台词\n', JSON.stringify(opfsResult.lrcText));
            check('真实写入的 MP3 帧头正确', opfsResult.mp3Header && opfsResult.mp3Header.bitrate === 320 && opfsResult.mp3Header.mpeg === 1, JSON.stringify(opfsResult.mp3Header));
            check('普通文件在真实目录里未被改动', opfsResult.noteText === '真实目录里的普通文件', opfsResult.noteText);
        }

        // --- 26. 文件夹模式：平铺 + 清理空目录，跑在真实句柄上 ---
        // 平铺涉及"复制到根目录 → 删原文件 → 删空目录"这一串真实写操作，
        // 用 OPFS 的真句柄再验一遍，确认不是内存假树特有的行为。
        console.log('\n[26] 文件夹模式：真实句柄上的平铺与清理');

        const opfsFlatten = await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}

            if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
                return { skipped: '这个浏览器没有 OPFS' };
            }

            let root;

            try {
                root = await navigator.storage.getDirectory();
            } catch (error) {
                return { skipped: error.message };
            }

            const dirName = 'vtt-flatten-test-' + Date.now();
            const handle = await root.getDirectoryHandle(dirName, { create: true });
            const sub = await handle.getDirectoryHandle('第一話', { create: true });

            const writeReal = async (dirHandle, name, data) => {
                const fileHandle = await dirHandle.getFileHandle(name, { create: true });
                const writable = await fileHandle.createWritable();

                await writable.write(data);
                await writable.close();
            };

            await writeReal(sub, '01.wav', makeTestWav({ frames: 11025 }));
            await writeReal(sub, '01.vtt', 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n平铺台词\\n');
            await writeReal(sub, 'note.txt', '子目录里的说明');

            window.__vttTestDirectoryProvider = async () => handle;

            try {
                switchTab('folder');
                document.getElementById('folder-transcode-wav-checkbox').checked = true;
                document.getElementById('folder-flatten-checkbox').checked = true;

                await pickSourceFolder();

                const running = convertAndDownload();

                for (let i = 0; i < 200 && document.getElementById('writeback-modal').classList.contains('hidden'); i++) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }

                document.getElementById('writeback-confirm').click();
                await running;

                const listAfter = [];

                for await (const child of handle.values()) listAfter.push(child.name);

                const readReal = async name => {
                    const fileHandle = await handle.getFileHandle(name);
                    const bytes = new Uint8Array(await (await fileHandle.getFile()).arrayBuffer());

                    return new TextDecoder('utf-8').decode(bytes);
                };

                return {
                    skipped: null,
                    listAfter: listAfter.sort(),
                    lrcText: await readReal('01.lrc'),
                    noteText: await readReal('note.txt'),
                    status: document.getElementById('status-message').textContent
                };
            } finally {
                delete window.__vttTestDirectoryProvider;

                try {
                    await root.removeEntry(dirName, { recursive: true });
                } catch {}
            }
        })()`);

        if (opfsFlatten.skipped) {
            console.log(`  （跳过：${opfsFlatten.skipped}）`);
        } else {
            check('真实句柄上平铺后只剩根目录文件', sameSet(opfsFlatten.listAfter, ['01.lrc', '01.mp3', 'note.txt']), JSON.stringify(opfsFlatten.listAfter));
            check('真实句柄上子目录也被删掉了', !opfsFlatten.listAfter.includes('第一話'), JSON.stringify(opfsFlatten.listAfter));
            check('真实句柄上 LRC 内容正确', opfsFlatten.lrcText === '[00:00.00]平铺台词\n', JSON.stringify(opfsFlatten.lrcText));
            check('真实句柄上普通文件被搬到根目录且内容不变', opfsFlatten.noteText === '子目录里的说明', String(opfsFlatten.noteText));
            check('真实句柄上如实汇报清理与搬动数量', (opfsFlatten.status || '').includes('清理了 1 个空目录') && (opfsFlatten.status || '').includes('搬动 1 个原样保留的文件'), opfsFlatten.status);
            check('真实句柄上搬动不产生虚假失败', !(opfsFlatten.status || '').includes('失败'), opfsFlatten.status);
        }

        // --- 27. 封面裁切：非 1:1 的图可以自己框选区域 ---
        // 用"左半红、右半蓝"的 2:1 图当封面：居中裁切必然红蓝各半，
        // 把框拖到最左边则应该整块都是红的——这样能证明用户框的区域真的写进了 MP3。
        console.log('\n[27] 封面裁切：非方图自己框选区域');

        const cropResult = await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}

            async function sampleApic(mp3Bytes) {
                const apic = findApicImageBytes(mp3Bytes);

                if (!apic) return null;

                const bitmap = await createImageBitmap(new Blob([apic], { type: 'image/jpeg' }));
                const canvas = document.createElement('canvas');

                canvas.width = bitmap.width;
                canvas.height = bitmap.height;

                const ctx = canvas.getContext('2d');

                ctx.drawImage(bitmap, 0, 0);

                const at = (fx, fy) => {
                    const data = ctx.getImageData(Math.round(bitmap.width * fx), Math.round(bitmap.height * fy), 1, 1).data;

                    return [data[0], data[1], data[2]];
                };

                return { width: bitmap.width, height: bitmap.height, left: at(0.15, 0.5), right: at(0.85, 0.5) };
            }

            // 2:1 封面（1600×800，左半纯红、右半纯蓝）：既验证"超 800 会被缩到 800"，
            // 也验证框选区域生效——居中裁切红蓝各半，框到最左则整块都是红的
            const cover = document.createElement('canvas');
            cover.width = 1600;
            cover.height = 800;

            const coverCtx = cover.getContext('2d');
            coverCtx.fillStyle = '#ff0000';
            coverCtx.fillRect(0, 0, 800, 800);
            coverCtx.fillStyle = '#0000ff';
            coverCtx.fillRect(800, 0, 800, 800);

            const coverBytes = new Uint8Array(await (await new Promise(r => cover.toBlob(r, 'image/jpeg', 0.95))).arrayBuffer());

            const source = new JSZip();
            source.file('包/曲目.wav', makeTestWav({ frames: 22050 }));
            source.file('包/封面.jpg', coverBytes);

            const blob = await source.generateAsync({ type: 'blob' });

            switchTab('zip');
            document.getElementById('transcode-wav-checkbox').checked = true;
            await handleZipFile(new File([blob], '裁切测试.zip', { type: 'application/zip' }));

            // 选中封面（网格里只有这一张图）
            document.querySelector('#image-preview-grid .image-thumb-wrapper').click();

            // 等缩略图 load 事件把原始尺寸记下来
            for (let i = 0; i < 50 && !document.getElementById('crop-hint').textContent; i++) {
                await new Promise(r => setTimeout(r, 20));
            }

            const affordance = {
                hintVisible: !document.getElementById('crop-hint').classList.contains('hidden'),
                hintText: document.getElementById('crop-hint').textContent,
                buttonVisible: !document.getElementById('crop-open-btn').classList.contains('hidden'),
                buttonText: document.getElementById('crop-open-btn').textContent
            };

            // 对照组：没调裁切时是居中裁切，红蓝各半
            const centerRun = await runEntriesInZip(createJob());
            const centerMp3 = Object.keys(centerRun.output.files).find(name => name.endsWith('.mp3'));
            const centerSample = await sampleApic(await centerRun.output.file(centerMp3).async('uint8array'));

            // 打开裁切器
            document.getElementById('crop-open-btn').click();

            for (let i = 0; i < 100 && document.getElementById('crop-modal').classList.contains('hidden'); i++) {
                await new Promise(r => setTimeout(r, 20));
            }

            await new Promise(r => setTimeout(r, 150));

            const viewport = document.getElementById('crop-viewport');
            const viewportRect = viewport.getBoundingClientRect();
            const centerX = viewportRect.left + viewportRect.width / 2;
            const centerY = viewportRect.top + viewportRect.height / 2;

            const opened = {
                modalVisible: !document.getElementById('crop-modal').classList.contains('hidden'),
                sizeLabel: document.getElementById('crop-size-label').textContent,
                zoomValue: document.getElementById('crop-zoom').value,
                imageWidth: document.getElementById('crop-image').getBoundingClientRect().width
            };

            // 拖动：把图片使劲往右拖 → 方框落到原图最左边那块
            viewport.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, clientX: centerX, clientY: centerY, bubbles: true }));
            viewport.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientX: centerX + 600, clientY: centerY, bubbles: true }));
            viewport.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, clientX: centerX + 600, clientY: centerY, bubbles: true }));

            const afterDragLabel = document.getElementById('crop-size-label').textContent;

            // 缩放：滑到 200%
            const zoom = document.getElementById('crop-zoom');
            zoom.value = '200';
            zoom.dispatchEvent(new Event('input', { bubbles: true }));

            const afterZoomLabel = document.getElementById('crop-size-label').textContent;

            // 复位：回到居中
            document.getElementById('crop-reset').click();
            const afterResetLabel = document.getElementById('crop-size-label').textContent;

            // 再拖到最左并确认
            viewport.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 8, clientX: centerX, clientY: centerY, bubbles: true }));
            viewport.dispatchEvent(new PointerEvent('pointermove', { pointerId: 8, clientX: centerX + 600, clientY: centerY, bubbles: true }));
            viewport.dispatchEvent(new PointerEvent('pointerup', { pointerId: 8, clientX: centerX + 600, clientY: centerY, bubbles: true }));

            document.getElementById('crop-confirm').click();

            const storedCrop = selectedCoverImage.crop;
            const hintAfter = document.getElementById('crop-hint').textContent;
            const buttonAfter = document.getElementById('crop-open-btn').textContent;

            // 再用同一个 job 转一次，检查写进去的封面
            const cropRun = await runEntriesInZip(createJob());
            const cropMp3 = Object.keys(cropRun.output.files).find(name => name.endsWith('.mp3'));
            const cropSample = await sampleApic(await cropRun.output.file(cropMp3).async('uint8array'));

            // 重开裁切器：应该还原成刚才框的位置（尺寸不变）
            document.getElementById('crop-open-btn').click();

            for (let i = 0; i < 100 && document.getElementById('crop-modal').classList.contains('hidden'); i++) {
                await new Promise(r => setTimeout(r, 20));
            }

            await new Promise(r => setTimeout(r, 150));

            const reopenedLabel = document.getElementById('crop-size-label').textContent;
            const reopenedZoom = document.getElementById('crop-zoom').value;

            // Esc 取消不该改动已保存的裁切
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

            return {
                affordance,
                centerSample,
                opened,
                afterDragLabel,
                afterZoomLabel,
                afterResetLabel,
                storedCrop,
                hintAfter,
                buttonAfter,
                cropSample,
                reopenedLabel,
                reopenedZoom,
                modalClosedByEsc: document.getElementById('crop-modal').classList.contains('hidden'),
                cropStillThere: JSON.stringify(selectedCoverImage.crop) === JSON.stringify(storedCrop)
            };
        })()`);

        const isReddish = rgb => rgb && rgb[0] > 150 && rgb[1] < 90 && rgb[2] < 90;
        const isBluish = rgb => rgb && rgb[2] > 150 && rgb[0] < 90 && rgb[1] < 90;

        check('非方图会提示可以自己框选', cropResult.affordance.hintVisible === true && cropResult.affordance.hintText.includes('1600×800'), JSON.stringify(cropResult.affordance));
        check('出现「调整封面裁切…」入口', cropResult.affordance.buttonVisible === true && cropResult.affordance.buttonText.includes('调整封面裁切'), JSON.stringify(cropResult.affordance));
        check('裁切器能打开并显示尺寸信息', cropResult.opened.modalVisible === true && /裁切 800×800/.test(cropResult.opened.sizeLabel) && /写入封面 800×800/.test(cropResult.opened.sizeLabel), JSON.stringify(cropResult.opened));
        check('默认居中的封面红蓝各占一半（对照组）', isReddish(cropResult.centerSample.left) && isBluish(cropResult.centerSample.right), JSON.stringify(cropResult.centerSample));
        check('超 800 的封面会被缩到 800×800 的正方形', cropResult.centerSample.width === 800 && cropResult.centerSample.height === 800, JSON.stringify(cropResult.centerSample));
        check('拖动后裁切区域贴着原图左边缘', /裁切 800×800/.test(cropResult.afterDragLabel), cropResult.afterDragLabel);
        check('缩放 200% 后裁切区域缩小到 400×400', /裁切 400×400/.test(cropResult.afterZoomLabel), cropResult.afterZoomLabel);
        check('「复位居中」恢复到 800×800', /裁切 800×800/.test(cropResult.afterResetLabel), cropResult.afterResetLabel);
        check(
            '确认后保存的裁切区域在原图范围内且贴左',
            cropResult.storedCrop && cropResult.storedCrop.x === 0 && cropResult.storedCrop.y === 0 &&
                cropResult.storedCrop.size === 800 &&
                cropResult.storedCrop.x + cropResult.storedCrop.size <= 1600 &&
                cropResult.storedCrop.y + cropResult.storedCrop.size <= 800,
            JSON.stringify(cropResult.storedCrop)
        );
        check('选过裁切后提示改成"已自定义"', cropResult.hintAfter.includes('已自定义裁切区域'), cropResult.hintAfter);
        check('入口改成「重新调整裁切…」', cropResult.buttonAfter.includes('重新调整'), cropResult.buttonAfter);
        check(
            'MP3 里的封面用的是用户框的左半边（整块都是红的）',
            isReddish(cropResult.cropSample.left) && isReddish(cropResult.cropSample.right),
            JSON.stringify(cropResult.cropSample)
        );
        check('裁切后的封面同样是 800×800', cropResult.cropSample.width === 800 && cropResult.cropSample.height === 800, JSON.stringify(cropResult.cropSample));
        check('重开裁切器还原到已保存的区域', /裁切 800×800/.test(cropResult.reopenedLabel) && cropResult.reopenedZoom === '100', `${cropResult.reopenedLabel} / ${cropResult.reopenedZoom}`);
        check('Esc 关闭裁切器且不改动已保存的裁切', cropResult.modalClosedByEsc === true && cropResult.cropStillThere === true, JSON.stringify({ closed: cropResult.modalClosedByEsc, kept: cropResult.cropStillThere }));

        // --- 28. 批量：多个文件夹 = 多个独立任务 ---
        // 选一个父文件夹，把它下面每个子文件夹当一个任务：各查各的 RJ、各写各的封面、
        // 各写回自己的目录。这里用 mock RJ 服务给两个作品不同的封面颜色与标题，
        // 借此证明任务之间没有串味。
        console.log('\n[28] 批量模式：多个文件夹各自成任务');

        const batchResult = await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}

            const makeCover = async color => {
                const canvas = document.createElement('canvas');

                canvas.width = 400;
                canvas.height = 400;

                const ctx = canvas.getContext('2d');

                ctx.fillStyle = color;
                ctx.fillRect(0, 0, 400, 400);

                const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));

                return { blob, url: URL.createObjectURL(blob) };
            };

            const coverA = await makeCover('#ff0000');
            const coverB = await makeCover('#0000ff');

            const originalFetch = window.fetch;
            const fetchedRj = [];

            window.fetch = (input, init) => {
                const url = typeof input === 'string' ? input : (input && input.url) || '';

                if (url.includes('mock-batch.test')) {
                    const rj = new URL(url).searchParams.get('rj');

                    fetchedRj.push(rj);

                    const table = {
                        RJ111111: { title: '作品甲的标题', cover: coverA.url },
                        RJ222222: { title: '作品乙的标题', cover: coverB.url }
                    };

                    const info = table[rj] || {};

                    return Promise.resolve(new Response(JSON.stringify({
                        ok: true,
                        rj,
                        title: info.title || '',
                        circle: '测试社团',
                        voiceBy: ['声优甲'],
                        genres: ['音声'],
                        workType: 'ボイス',
                        releaseDate: '2024-03-01',
                        coverUrl: info.cover || '',
                        pageUrl: 'https://example.test/' + rj
                    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                }

                return originalFetch(input, init);
            };

            RJ_METADATA_ENDPOINT = 'https://mock-batch.test';

            const handle = makeFakeDirectoryTree('音声测试', {
                'RJ111111 作品甲/01.wav': makeTestWav({ frames: 11025, freq: 440 }),
                'RJ111111 作品甲/01.vtt': 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n甲的第一句\\n',
                'RJ111111 作品甲/第一話/02.wav': makeTestWav({ frames: 11025, freq: 550 }),
                'RJ111111 作品甲/第一話/02.vtt': 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n甲的第二句\\n',
                'RJ222222 作品乙/01.wav': makeTestWav({ frames: 11025, freq: 660 }),
                'RJ222222 作品乙/01.vtt': 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n乙的第一句\\n'
            });

            window.__vttTestDirectoryProvider = async () => handle;

            const sampleApic = async bytes => {
                const apic = findApicImageBytes(bytes);

                if (!apic) return null;

                const bitmap = await createImageBitmap(new Blob([apic], { type: 'image/jpeg' }));
                const canvas = document.createElement('canvas');

                canvas.width = bitmap.width;
                canvas.height = bitmap.height;

                const ctx = canvas.getContext('2d');

                ctx.drawImage(bitmap, 0, 0);

                const data = ctx.getImageData(Math.round(bitmap.width * 0.5), Math.round(bitmap.height * 0.5), 1, 1).data;

                return { size: bitmap.width, center: [data[0], data[1], data[2]] };
            };

            const readFolder = folder => {
                const prefix = folder + '/';

                return handle.list().filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length)).sort();
            };

            const readMp3 = async relPath => {
                const bytes = handle.read(relPath);

                if (!bytes) return null;

                return {
                    headerText: new TextDecoder('utf-8').decode(bytes.slice(0, 4000)),
                    apic: await sampleApic(bytes)
                };
            };

            try {
                switchTab('folder');
                document.getElementById('folder-transcode-wav-checkbox').checked = true;
                document.getElementById('folder-flatten-checkbox').checked = true;
                document.getElementById('folder-delete-source-checkbox').checked = true;
                document.getElementById('folder-batch-checkbox').checked = true;

                await pickSourceFolder();

                const taskList = {
                    hidden: document.getElementById('file-list-container').classList.contains('hidden'),
                    title: document.getElementById('file-list-title').textContent,
                    names: [...document.querySelectorAll('#file-list li')].map(li => li.querySelector('div > div').textContent.trim()),
                    buttonLabel: document.getElementById('btn-text').textContent
                };

                // 先取消一次：不该有任何改动
                let running = convertAndDownload();

                for (let i = 0; i < 300 && document.getElementById('writeback-modal').classList.contains('hidden'); i++) {
                    await new Promise(r => setTimeout(r, 50));
                }

                const modal = {
                    visible: !document.getElementById('writeback-modal').classList.contains('hidden'),
                    title: document.getElementById('writeback-title').textContent,
                    target: document.getElementById('writeback-target').textContent,
                    text: document.getElementById('writeback-summary').textContent
                };

                document.getElementById('writeback-cancel').click();
                await running;

                const untouched = handle.list().length === 6;

                // 再来一次，这次确认
                running = convertAndDownload();

                for (let i = 0; i < 300 && document.getElementById('writeback-modal').classList.contains('hidden'); i++) {
                    await new Promise(r => setTimeout(r, 50));
                }

                document.getElementById('writeback-confirm').click();
                await running;

                const finalA = readFolder('RJ111111 作品甲');
                const finalB = readFolder('RJ222222 作品乙');
                const mp3A = await readMp3('RJ111111 作品甲/01.mp3');
                const mp3B = await readMp3('RJ222222 作品乙/01.mp3');

                return {
                    taskList,
                    modal,
                    untouched,
                    fetchedRj,
                    finalA,
                    finalB,
                    rootFiles: handle.list().filter(name => !name.includes('/')).sort(),
                    mp3A,
                    mp3B,
                    listAfter: handle.list().sort(),
                    status: document.getElementById('status-message').textContent
                };
            } finally {
                delete window.__vttTestDirectoryProvider;
                window.fetch = originalFetch;
                RJ_METADATA_ENDPOINT = '';
                document.getElementById('folder-batch-checkbox').checked = false;
                document.getElementById('folder-flatten-checkbox').checked = false;
                document.getElementById('folder-delete-source-checkbox').checked = false;
            }
        })()`);

        check('批量任务列表列出每个子文件夹', batchResult.taskList.hidden === false && batchResult.taskList.names.length === 2, JSON.stringify(batchResult.taskList));
        check('任务名就是文件夹名', sameSet(batchResult.taskList.names, ['RJ111111 作品甲', 'RJ222222 作品乙']), JSON.stringify(batchResult.taskList.names));
        check('按钮文案变成批量写回', /转换并写回 2 个文件夹/.test(batchResult.taskList.buttonLabel), batchResult.taskList.buttonLabel);
        check('弹出一次批量确认（不是每个文件夹弹一次）', batchResult.modal.visible === true && /批量写回/.test(batchResult.modal.title), JSON.stringify(batchResult.modal));
        check('确认清单里逐个列出任务与各自封面', batchResult.modal.text.includes('RJ111111 作品甲') && batchResult.modal.text.includes('RJ222222 作品乙') && /封面：/.test(batchResult.modal.text), batchResult.modal.text.slice(0, 400));
        check('取消批量后一个文件都没动', batchResult.untouched === true, JSON.stringify(batchResult.listAfter));
        check('两个作品的 RJ 号都被查询', sameSet(batchResult.fetchedRj, ['RJ111111', 'RJ222222']), JSON.stringify(batchResult.fetchedRj));
        check('作品甲只写回自己的文件夹（含平铺展开 + 剪掉源文件）', sameSet(batchResult.finalA, ['01.lrc', '01.mp3', '02.lrc', '02.mp3']), JSON.stringify(batchResult.finalA));
        check('作品乙只写回自己的文件夹', sameSet(batchResult.finalB, ['01.lrc', '01.mp3']), JSON.stringify(batchResult.finalB));
        check('父文件夹本身没有被写入任何文件', batchResult.rootFiles.length === 0, JSON.stringify(batchResult.rootFiles));
        check('作品甲的封面用的是它自己的（红色）', batchResult.mp3A.apic.center[0] > 150 && batchResult.mp3A.apic.center[2] < 90, JSON.stringify(batchResult.mp3A.apic));
        check('作品乙的封面用的是它自己的（蓝色）', batchResult.mp3B.apic.center[2] > 150 && batchResult.mp3B.apic.center[0] < 90, JSON.stringify(batchResult.mp3B.apic));
        check('两个 MP3 各写各的专辑标签', batchResult.mp3A.headerText.includes('作品甲的标题') && batchResult.mp3B.headerText.includes('作品乙的标题'), JSON.stringify([batchResult.mp3A.headerText.slice(0, 120), batchResult.mp3B.headerText.slice(0, 120)]));
        check('批量结束后汇报任务数与各项数量', /完成 2 个任务/.test(batchResult.status) && /写入 6/.test(batchResult.status), batchResult.status);

        // --- 29. 批量：没配 RJ 服务时用各文件夹自己的图片当封面 ---
        // 线上默认没配 RJ 元数据服务，这时批量要靠"每个文件夹里的第一张图片"才能有封面。
        console.log('\n[29] 批量模式：用各文件夹自己的图片当封面');

        const batchCoverResult = await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}

            const makeCover = async color => {
                const canvas = document.createElement('canvas');

                canvas.width = 300;
                canvas.height = 300;

                const ctx = canvas.getContext('2d');

                ctx.fillStyle = color;
                ctx.fillRect(0, 0, 300, 300);

                const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));

                return new Uint8Array(await blob.arrayBuffer());
            };

            const handle = makeFakeDirectoryTree('无服务批量', {
                '作品一/01.wav': makeTestWav({ frames: 11025 }),
                '作品一/01.vtt': 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n一\\n',
                '作品一/封面.jpg': await makeCover('#00ff00'),
                '作品二/01.wav': makeTestWav({ frames: 11025, freq: 700 }),
                '作品二/01.vtt': 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n二\\n',
                '作品二/封面.jpg': await makeCover('#ffff00')
            });

            window.__vttTestDirectoryProvider = async () => handle;

            const sampleApic = async bytes => {
                const apic = findApicImageBytes(bytes);

                if (!apic) return null;

                const bitmap = await createImageBitmap(new Blob([apic], { type: 'image/jpeg' }));
                const canvas = document.createElement('canvas');

                canvas.width = bitmap.width;
                canvas.height = bitmap.height;

                const ctx = canvas.getContext('2d');

                ctx.drawImage(bitmap, 0, 0);

                const data = ctx.getImageData(Math.round(bitmap.width / 2), Math.round(bitmap.height / 2), 1, 1).data;

                return [data[0], data[1], data[2]];
            };

            try {
                switchTab('folder');
                document.getElementById('folder-transcode-wav-checkbox').checked = true;
                document.getElementById('folder-batch-checkbox').checked = true;
                document.getElementById('folder-batch-cover-checkbox').checked = true;

                await pickSourceFolder();

                const running = convertAndDownload();

                for (let i = 0; i < 300 && document.getElementById('writeback-modal').classList.contains('hidden'); i++) {
                    await new Promise(r => setTimeout(r, 50));
                }

                const modalText = document.getElementById('writeback-summary').textContent;

                document.getElementById('writeback-confirm').click();
                await running;

                const colorOne = await sampleApic(handle.read('作品一/01.mp3'));
                const colorTwo = await sampleApic(handle.read('作品二/01.mp3'));

                return {
                    modalText,
                    colorOne,
                    colorTwo,
                    status: document.getElementById('status-message').textContent
                };
            } finally {
                delete window.__vttTestDirectoryProvider;
                document.getElementById('folder-batch-checkbox').checked = false;
                document.getElementById('folder-batch-cover-checkbox').checked = false;
            }
        })()`);

        check('清单里写明各任务用的封面文件', /封面：封面\.jpg/.test(batchCoverResult.modalText) && (batchCoverResult.modalText.match(/封面：封面\.jpg/g) || []).length === 2, batchCoverResult.modalText.slice(0, 300));
        check('作品一嵌的是自己文件夹里的绿封面', batchCoverResult.colorOne && batchCoverResult.colorOne[1] > 150 && batchCoverResult.colorOne[0] < 120, JSON.stringify(batchCoverResult.colorOne));
        check('作品二嵌的是自己文件夹里的黄封面', batchCoverResult.colorTwo && batchCoverResult.colorTwo[0] > 150 && batchCoverResult.colorTwo[1] > 150 && batchCoverResult.colorTwo[2] < 120, JSON.stringify(batchCoverResult.colorTwo));

        // --- 30. 批量：每个任务自己选封面（手动优先于自动挑选） ---
        // 自动挑"第一张图片"经常挑到特典插图，所以每个任务都能手动指定；
        // 手动选过的封面必须压过自动挑选，选「不用封面」也必须算数。
        console.log('\n[30] 批量模式：逐个任务手动选封面');

        const taskPickResult = await evaluate(pageCdp, `(async () => {
            ${MAKE_WAV_SOURCE}

            const makeImage = async (color, type) => {
                const canvas = document.createElement('canvas');

                canvas.width = 400;
                canvas.height = 400;

                const ctx = canvas.getContext('2d');

                ctx.fillStyle = color;
                ctx.fillRect(0, 0, 400, 400);

                const blob = await new Promise(r => canvas.toBlob(r, type === 'png' ? 'image/png' : 'image/jpeg', 0.92));

                return new Uint8Array(await blob.arrayBuffer());
            };

            // 每个作品两张图：01 是红的（会被自动挑中），02 是蓝的（我们手动选它）
            const handle = makeFakeDirectoryTree('手动封面', {
                '作品甲/01_封面.jpg': await makeImage('#ff0000', 'jpeg'),
                '作品甲/02_特典.png': await makeImage('#0000ff', 'png'),
                '作品甲/01.wav': makeTestWav({ frames: 11025 }),
                '作品甲/01.vtt': 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n甲\\n',
                '作品乙/01_封面.jpg': await makeImage('#ff0000', 'jpeg'),
                '作品乙/02_特典.png': await makeImage('#0000ff', 'png'),
                '作品乙/01.wav': makeTestWav({ frames: 11025, freq: 700 }),
                '作品乙/01.vtt': 'WEBVTT\\n\\n00:00.000 --> 00:02.000\\n乙\\n'
            });

            window.__vttTestDirectoryProvider = async () => handle;

            const sampleApic = async bytes => {
                const apic = findApicImageBytes(bytes);

                if (!apic) return null;

                const bitmap = await createImageBitmap(new Blob([apic], { type: 'image/jpeg' }));
                const canvas = document.createElement('canvas');

                canvas.width = bitmap.width;
                canvas.height = bitmap.height;

                const ctx = canvas.getContext('2d');

                ctx.drawImage(bitmap, 0, 0);

                const data = ctx.getImageData(Math.round(bitmap.width / 2), Math.round(bitmap.height / 2), 1, 1).data;

                return [data[0], data[1], data[2]];
            };

            const waitFor = async (test, label) => {
                for (let i = 0; i < 300; i++) {
                    if (test()) return true;

                    await new Promise(r => setTimeout(r, 50));
                }

                throw new Error('等待超时：' + label);
            };

            try {
                switchTab('folder');
                document.getElementById('folder-transcode-wav-checkbox').checked = true;
                document.getElementById('folder-batch-checkbox').checked = true;
                document.getElementById('folder-batch-cover-checkbox').checked = false;

                await pickSourceFolder();

                // 第一个任务：打开选封面，挑第 2 张（蓝色的特典图）
                document.querySelector('[data-task-cover="0"]').click();
                await waitFor(() => document.querySelectorAll('#task-cover-grid .image-thumb-wrapper').length === 2, '封面候选网格');

                const pickerUi = {
                    modalVisible: !document.getElementById('task-cover-modal').classList.contains('hidden'),
                    title: document.getElementById('task-cover-title').textContent,
                    note: document.getElementById('task-cover-note').textContent,
                    count: document.querySelectorAll('#task-cover-grid .image-thumb-wrapper').length
                };

                document.querySelectorAll('#task-cover-grid .image-thumb-wrapper')[1].click();
                pickerUi.statusAfterPick = document.getElementById('task-cover-status').textContent;

                // 候选图也能调裁切（复用同一个裁切器）
                document.getElementById('task-cover-crop').click();
                await waitFor(() => !document.getElementById('crop-modal').classList.contains('hidden'), '裁切器打开');
                pickerUi.cropOpened = true;
                document.getElementById('crop-cancel').click();

                document.getElementById('task-cover-confirm').click();

                const firstCover = folderTasks[0].cover ? folderTasks[0].cover.name : null;

                // 第二个任务：明确选「不用封面」
                document.querySelector('[data-task-cover="1"]').click();
                await waitFor(() => document.querySelectorAll('#task-cover-grid .image-thumb-wrapper').length === 2, '第二个任务的候选网格');
                document.getElementById('task-cover-none').click();

                const secondCover = folderTasks[1].cover;

                // 即使勾上"用第一张图片"，手动选择也必须优先
                document.getElementById('folder-batch-cover-checkbox').checked = true;

                const rowCoverThumbs = document.querySelectorAll('#file-list .task-cover-thumb').length;
                const emptyBadges = document.querySelectorAll('#file-list .task-cover-empty').length;

                const running = convertAndDownload();

                await waitFor(() => !document.getElementById('writeback-modal').classList.contains('hidden'), '批量确认弹窗');

                const modalText = document.getElementById('writeback-summary').textContent;

                document.getElementById('writeback-confirm').click();
                await running;

                return {
                    pickerUi,
                    firstCover,
                    secondCover,
                    rowCoverThumbs,
                    emptyBadges,
                    modalText: modalText.slice(0, 300),
                    colorA: await sampleApic(handle.read('作品甲/01.mp3')),
                    colorB: await sampleApic(handle.read('作品乙/01.mp3')),
                    status: document.getElementById('status-message').textContent
                };
            } finally {
                delete window.__vttTestDirectoryProvider;
                document.getElementById('folder-batch-checkbox').checked = false;
                document.getElementById('folder-batch-cover-checkbox').checked = false;
            }
        })()`);

        check('任务行里有「选封面」入口', taskPickResult.rowCoverThumbs + taskPickResult.emptyBadges === 2, JSON.stringify(taskPickResult));
        check('弹窗列出该任务文件夹里的图片', taskPickResult.pickerUi.modalVisible === true && taskPickResult.pickerUi.count === 2 && taskPickResult.pickerUi.title.includes('作品甲'), JSON.stringify(taskPickResult.pickerUi));
        check('提示里说明找到了几张图片', /2 张图片/.test(taskPickResult.pickerUi.note), taskPickResult.pickerUi.note);
        check('点选后显示已选文件名', taskPickResult.pickerUi.statusAfterPick.includes('已选：02_特典.png'), taskPickResult.pickerUi.statusAfterPick);
        check('候选图也能打开裁切器', taskPickResult.pickerUi.cropOpened === true, JSON.stringify(taskPickResult.pickerUi));
        check('手动选的封面记在任务上（第 2 张，不是自动会挑的第 1 张）', taskPickResult.firstCover === '02_特典.png', String(taskPickResult.firstCover));
        check('可以给任务选「不用封面」', taskPickResult.secondCover === null, JSON.stringify(taskPickResult.secondCover));
        check('确认清单里体现各自封面', taskPickResult.modalText.includes('02_特典.png') && /无封面/.test(taskPickResult.modalText), taskPickResult.modalText);
        check(
            '手动选的封面压过了"用第一张图片"（作品甲嵌的是蓝色特典图）',
            taskPickResult.colorA && taskPickResult.colorA[2] > 150 && taskPickResult.colorA[0] < 90,
            JSON.stringify(taskPickResult.colorA)
        );
        check('选了「不用封面」的任务确实没有封面', taskPickResult.colorB === null, JSON.stringify(taskPickResult.colorB));

        // --- 31. 手机平台的提示文案 ---
        // 安卓 Chrome 132+ 才支持写回（MDN 兼容数据：showDirectoryPicker chrome_android=132，
        // 而 createWritable 等句柄方法 chrome_android=109）；iOS 上所有浏览器都不支持。
        // 以前的文案一律说"需要 Chrome / Edge"，安卓用户看了会以为是自己没装 Chrome。
        console.log('\n[31] 手机平台提示：安卓要 132+，iOS 一律不支持写回');

        const platformResult = await evaluate(pageCdp, `(() => {
            const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
            const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1';
            const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15';
            const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

            const platforms = {
                android: detectPlatform(ANDROID_UA, 5),
                iphone: detectPlatform(IPHONE_UA, 5),
                ipadDesktopMode: detectPlatform(IPAD_UA, 5),
                realMac: detectPlatform(IPAD_UA, 0),
                desktop: detectPlatform(DESKTOP_UA, 0)
            };

            const messages = {};
            const dropHint = {};

            // 前面的用例可能在状态行上留了"选择器失败"的常驻提示，它会盖住平台文案
            const savedNotice = folderModeNotice;

            // isSupported({supported:false}) 是纯函数、不留状态，所以要像降级用例那样替换掉它
            const originalIsSupported = FolderFs.isSupported;

            const snapshot = (key, supported, platform) => {
                folderModeNotice = '';
                FolderFs.isSupported = options => (options && typeof options.supported === 'boolean' ? options.supported : supported);
                platformOverride = platform;

                updateFolderSupport();
                updateDropHint();

                messages[key] = document.getElementById('folder-status').textContent;
                dropHint[key] = !document.getElementById('folder-drop-hint').classList.contains('hidden');
            };

            try {
                snapshot('androidUnsupported', false, 'android');
                snapshot('iosUnsupported', false, 'ios');
                snapshot('desktopUnsupported', false, 'desktop');
                snapshot('androidSupported', true, 'android');
                snapshot('desktopSupported', true, 'desktop');
            } finally {
                // 还原测试开关，别影响后面的用例
                FolderFs.isSupported = originalIsSupported;
                platformOverride = null;
                folderModeNotice = savedNotice;
                updateFolderSupport();
                updateDropHint();
            }

            return {
                platforms,
                messages,
                dropHint,
                restored: document.getElementById('folder-status').textContent,
                dropHintRestored: !document.getElementById('folder-drop-hint').classList.contains('hidden')
            };
        })()`);

        check('能认出安卓 UA', platformResult.platforms.android === 'android', JSON.stringify(platformResult.platforms));
        check('能认出 iPhone UA', platformResult.platforms.iphone === 'ios', JSON.stringify(platformResult.platforms));
        check(
            'iPad 的"桌面版网站"模式靠触摸点认出，真 Mac 不误判',
            platformResult.platforms.ipadDesktopMode === 'ios' && platformResult.platforms.realMac === 'desktop',
            JSON.stringify(platformResult.platforms)
        );
        check('桌面 Chrome 不会被误判', platformResult.platforms.desktop === 'desktop', JSON.stringify(platformResult.platforms));
        check(
            '安卓不支持时提示要 132+，不再说"需要 Chrome"',
            /132/.test(platformResult.messages.androidUnsupported) && !/需要 Chrome \/ Edge/.test(platformResult.messages.androidUnsupported),
            platformResult.messages.androidUnsupported
        );
        check(
            'iOS 不支持时说明是系统限制并给出 ZIP 出路',
            /iPhone \/ iPad/.test(platformResult.messages.iosUnsupported) && /ZIP/.test(platformResult.messages.iosUnsupported),
            platformResult.messages.iosUnsupported
        );
        check(
            '桌面非 Chromium 仍提示需要 Chrome / Edge',
            /Chrome \/ Edge/.test(platformResult.messages.desktopUnsupported),
            platformResult.messages.desktopUnsupported
        );
        check(
            '安卓 132+ 支持时提示可直接写回并提醒性能',
            /132 及以上支持/.test(platformResult.messages.androidSupported) && /电脑/.test(platformResult.messages.androidSupported),
            platformResult.messages.androidSupported
        );
        check(
            '桌面支持时保持原来的提示',
            platformResult.messages.desktopSupported.includes('可直接写回原文件夹'),
            platformResult.messages.desktopSupported
        );
        check(
            '手机上才显示"没有拖拽"的引导',
            platformResult.dropHint.androidUnsupported === true && platformResult.dropHint.iosUnsupported === true &&
                platformResult.dropHint.desktopUnsupported === false && platformResult.dropHintRestored === false,
            JSON.stringify(platformResult.dropHint)
        );
        check('测完还原成真实检测结果', !/132|iPhone/.test(platformResult.restored), platformResult.restored);

        // --- 32. 访问统计（GoatCounter）只在线上真的生效 ---
        // 线上必须发出 /count 请求，否则统计数据会静默丢失；
        // 本地 file:// 则必须不发，避免开发时污染线上数据。
        console.log('\n[32] 访问统计（GoatCounter）');

        await pageCdp.send('Network.enable');

        const analyticsRequests = [];

        pageCdp.on('Network.requestWillBeSent', params => {
            if (params.request && params.request.url.includes('goatcounter.com/count')) {
                analyticsRequests.push(params.request.url);
            }
        });

        const reloadedForAnalytics = pageCdp.once('Page.loadEventFired');

        await pageCdp.send('Page.reload', { ignoreCache: true });
        await reloadedForAnalytics;
        await sleep(4000);

        if (TARGET_URL.startsWith('http')) {
            check('线上页面会向 GoatCounter 上报访问', analyticsRequests.length >= 1, JSON.stringify(analyticsRequests));
            check(
                '上报到 vtt-to-lrc 这个账号',
                analyticsRequests.length > 0 && analyticsRequests.every(url => url.startsWith('https://vtt-to-lrc.goatcounter.com/count')),
                JSON.stringify(analyticsRequests)
            );
        } else {
            check('本地 file:// 打开不会上报（不污染线上数据）', analyticsRequests.length === 0, JSON.stringify(analyticsRequests));
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
