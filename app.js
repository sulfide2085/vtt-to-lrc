// DOM 元素
const tabDirect = document.getElementById('tab-direct');
const tabZip = document.getElementById('tab-zip');
const tabFolder = document.getElementById('tab-folder');
const panelDirect = document.getElementById('panel-direct');
const panelZip = document.getElementById('panel-zip');
const panelFolder = document.getElementById('panel-folder');
const dropZones = document.querySelectorAll('.drop-zone');
const folderDropZone = document.getElementById('folder-drop-zone');
const folderStatusText = document.getElementById('folder-status');
const fileInputDirect = document.getElementById('file-input-direct');
const fileInputZip = document.getElementById('file-input-zip');
const fileInputFolder = document.getElementById('file-input-folder');
const fileListContainer = document.getElementById('file-list-container');
const fileListTitle = document.getElementById('file-list-title');
const fileList = document.getElementById('file-list');
const actionButtons = document.getElementById('action-buttons');
const convertBtn = document.getElementById('convert-btn');
const clearBtn = document.getElementById('clear-btn');
const btnText = document.getElementById('btn-text');
const spinner = document.getElementById('spinner');
const statusMessage = document.getElementById('status-message');
const zipOptions = document.getElementById('zip-options');
const flattenCheckbox = document.getElementById('flatten-checkbox');
const imagePreviewContainer = document.getElementById('image-preview-container');
const imagePreviewGrid = document.getElementById('image-preview-grid');
const imagePreviewTitle = document.getElementById('image-preview-title');
const transcodeWavCheckbox = document.getElementById('transcode-wav-checkbox');
const lameStatus = document.getElementById('lame-status');
const progressContainer = document.getElementById('progress-container');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const workInfo = document.getElementById('work-info');
const workCover = document.getElementById('work-cover');
const workTitle = document.getElementById('work-title');
const workMeta = document.getElementById('work-meta');
const workLink = document.getElementById('work-link');
const workStatus = document.getElementById('work-status');
const folderOptions = document.getElementById('folder-options');
const folderTranscodeCheckbox = document.getElementById('folder-transcode-wav-checkbox');
const folderFlattenCheckbox = document.getElementById('folder-flatten-checkbox');
const folderDeleteSourceCheckbox = document.getElementById('folder-delete-source-checkbox');
const folderNote = document.getElementById('folder-note');
const writebackModal = document.getElementById('writeback-modal');
const writebackTitle = document.getElementById('writeback-title');
const writebackTarget = document.getElementById('writeback-target');
const writebackSummary = document.getElementById('writeback-summary');
const writebackConfirm = document.getElementById('writeback-confirm');
const writebackCancel = document.getElementById('writeback-cancel');

// 状态
let filesToProcess = []; // 统一存储待处理 VTT 条目 { name, getContent }
let loadedZip = null; // 存储上传的 ZIP 对象
let originalInputName = null; // 存储原始输入名（ZIP 名 / 首个文件名 / 文件夹名）
let zipImages = []; // { name, mime, base64 }
let selectedCoverImage = null; // { mime, base64 } 或 null
let currentTab = 'direct'; // direct | zip | folder
let zipHasMp3 = false; // 包内是否有 MP3（用于文件列表提示）
let zipWavCount = 0; // 包内 WAV 数量
let isProcessing = false; // 正在转换中：禁止切标签/清空/换文件，避免打断正在跑的任务
let currentWork = null; // 按 RJ 号查到的作品信息
let folderStore = null; // { handle, canWrite, rootName } 文件夹模式的写回目标
let folderScan = null; // { vttCount, wavCount, mp3Count, imageCount, otherCount, skippedDirs, truncated }
let modalResolver = null; // 当前等待用户回答的弹窗
let folderModeNotice = ''; // 目录选择器失败之类的重要提示，挂在文件夹状态行上常驻显示

/**
 * RJ 元数据服务地址（Cloudflare Worker，部署方法见 worker/README.md）。
 * 留空则不做自动查询，封面照旧手动选。
 * 之所以要中转：DLsite 的 product.json 接口不带 CORS 头，浏览器直连必被拦；
 * 而封面 CDN（img.dlsite.jp）返回 Access-Control-Allow-Origin: *，图片可以直接抓。
 */
let RJ_METADATA_ENDPOINT = '';

const RJ_LOOKUP_TIMEOUT = 20000;

// 固定 320 kbps：WAV 是无损 PCM，等效码率（CD 音质约 1411 kbps）远高于 320，
// 没有"源码率"可继承，所以一律按 320 kbps 编码；只有采样率过低时
// （16~24 kHz 上限 160 kbps，≤12 kHz 上限 64 kbps）才会自动降到上限。
const MP3_BITRATE = 320;

/** 文件夹扫描的文件数上限：比这更多就别一次全塞进浏览器了 */
const FOLDER_FILE_LIMIT = 8000;

const TAB_ELEMENTS = {
    direct: { tab: tabDirect, panel: panelDirect },
    zip: { tab: tabZip, panel: panelZip },
    folder: { tab: tabFolder, panel: panelFolder }
};

// --- 事件监听 ---

tabDirect.addEventListener('click', () => switchTab('direct'));
tabZip.addEventListener('click', () => switchTab('zip'));
tabFolder.addEventListener('click', () => switchTab('folder'));

dropZones.forEach(zone => {
    zone.addEventListener('dragover', e => {
        e.preventDefault();
        zone.classList.add('dragover');
    });

    zone.addEventListener('dragleave', () => {
        zone.classList.remove('dragover');
    });

    zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('dragover');

        const files = e.dataTransfer.files;
        const panel = zone.closest('.tab-content');

        if (panel && panel.id === 'panel-zip') {
            if (files.length) handleZipFile(files[0]);
        } else if (panel && panel.id === 'panel-folder') {
            handleFolderDrop(e.dataTransfer);
        } else {
            handleDirectFiles(files);
        }
    });
});

fileInputDirect.addEventListener('change', e => {
    handleDirectFiles(e.target.files);
});

fileInputZip.addEventListener('change', e => {
    if (e.target.files.length) handleZipFile(e.target.files[0]);
});

fileInputFolder.addEventListener('change', e => {
    if (e.target.files.length) handleFolderInputFiles(e.target.files);
});

folderDropZone.addEventListener('click', () => {
    pickSourceFolder();
});

folderDropZone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pickSourceFolder();
    }
});

transcodeWavCheckbox.addEventListener('change', refreshZipFileList);
folderTranscodeCheckbox.addEventListener('change', refreshFolderFileList);

convertBtn.addEventListener('click', convertAndDownload);
clearBtn.addEventListener('click', clearFiles);

writebackConfirm.addEventListener('click', () => resolveWritebackConfirm(true));
writebackCancel.addEventListener('click', () => resolveWritebackConfirm(false));

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !writebackModal.classList.contains('hidden')) {
        resolveWritebackConfirm(false);
    }
});

updateLameStatus();
updateFolderSupport();

// --- 基础工具函数 ---

function countZipWavFiles(zip) {
    let count = 0;

    for (const filename in zip.files) {
        if (!zip.files[filename].dir && isWavFile(filename)) {
            count++;
        }
    }

    return count;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function showStatusMessage(message, isError = true) {
    statusMessage.textContent = message;
    statusMessage.className = `text-center mt-4 font-medium ${isError ? 'text-red-500' : 'text-green-600'}`;
}

function joinZipPath(folder, name) {
    const cleanFolder = String(folder || '').replace(/^\/+|\/+$/g, '');
    const cleanName = String(name || '').replace(/^\/+/g, '');

    if (!cleanFolder) return cleanName;
    if (!cleanName) return cleanFolder;

    return `${cleanFolder}/${cleanName}`;
}

function getBaseName(path) {
    return String(path).split('/').pop();
}

function isVttFile(filename) {
    return /\.vtt$/i.test(filename);
}

function isMp3File(filename) {
    return /\.mp3$/i.test(filename);
}

function isWavFile(filename) {
    return /\.wav$/i.test(filename);
}

function toMp3Filename(filename) {
    return String(filename).replace(/\.wav$/i, '.mp3');
}

function isZipFile(file) {
    if (!file) return false;
    return file.type.includes('zip') || /\.zip$/i.test(file.name);
}

function formatBytes(bytes) {
    if (typeof WavToMp3 !== 'undefined' && WavToMp3.formatBytes) {
        return WavToMp3.formatBytes(bytes);
    }

    const value = Number(bytes) || 0;

    return value >= 1024 * 1024
        ? `${(value / 1024 / 1024).toFixed(1)} MB`
        : `${Math.max(1, Math.round(value / 1024))} KB`;
}

/** FNV-1a 32 位：用来判断"写回去的内容和现有文件是不是一模一样" */
function computeDigest(bytes) {
    let hash = 0x811C9DC5;

    for (let i = 0; i < bytes.length; i++) {
        hash ^= bytes[i];
        hash = Math.imul(hash, 0x01000193);
    }

    return (hash >>> 0).toString(16);
}

/**
 * 把 ZIP 条目名里的反斜杠统一成斜杠。
 *
 * Windows 资源管理器 / Compress-Archive 打包时用反斜杠存路径
 * （音声压缩包基本都是这么来的），而反斜杠在 zip 规范里并不是分隔符，
 * 不处理的话输出包会出现 "作品集\第一话\01.mp3" 这种带反斜杠的怪文件名，
 * 解压时要么报错要么变成一个名字里带 \ 的文件。
 */
function normalizeZipEntryNames(zip) {
    const rawNames = Object.keys(zip.files);
    let fixedCount = 0;

    rawNames.forEach(rawName => {
        if (rawName.indexOf('\\') === -1) return;

        const entry = zip.files[rawName];
        let fixedName = rawName.replace(/\\+/g, '/').replace(/\/{2,}/g, '/');

        // 极少数情况下 zip 里同时存在 a\b 和 a/b，避免互相覆盖
        if (zip.files[fixedName] && zip.files[fixedName] !== entry) {
            const dotIndex = fixedName.lastIndexOf('.');
            const base = dotIndex > 0 ? fixedName.slice(0, dotIndex) : fixedName;
            const ext = dotIndex > 0 ? fixedName.slice(dotIndex) : '';
            let counter = 2;

            while (zip.files[`${base}_${counter}${ext}`]) counter++;

            fixedName = `${base}_${counter}${ext}`;
        }

        delete zip.files[rawName];

        entry.name = fixedName;
        zip.files[fixedName] = entry;
        fixedCount++;
    });

    if (fixedCount > 0) {
        console.info(`已修正 ${fixedCount} 个 ZIP 条目名的路径分隔符（反斜杠 → 斜杠）`);
    }

    return fixedCount;
}

// --- 进度显示 ---

function setProgress(ratio, text) {
    const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));

    progressContainer.classList.remove('hidden');
    progressBar.style.width = `${percent}%`;

    if (text !== undefined) {
        progressText.textContent = text;
    }
}

function hideProgress() {
    progressContainer.classList.add('hidden');
    progressBar.style.width = '0%';
    progressText.textContent = '';
}

// --- 编码库 / 浏览器能力状态 ---

function updateLameStatus() {
    if (typeof WavToMp3 === 'undefined') {
        lameStatus.textContent = '⚠ 转码模块 audio.js 未加载，无法转码 WAV。';
        lameStatus.className = 'text-xs text-red-500 mt-2';
        return;
    }

    if (WavToMp3.isLamejsReady()) {
        lameStatus.textContent = 'MP3 编码由 lamejs（LAME 3.x 移植）在本地完成，320 kbps CBR；源采样率过低时会自动降到该采样率的上限。文件不会上传到任何服务器。';
        lameStatus.className = 'text-xs text-gray-400 mt-2';
    } else {
        lameStatus.textContent = '⚠ MP3 编码库 lamejs 未加载（可能是网络问题），请刷新页面后重试。';
        lameStatus.className = 'text-xs text-red-500 mt-2';
    }
}

function updateFolderSupport() {
    if (typeof FolderFs === 'undefined') {
        folderStatusText.textContent = '⚠ 文件夹模块 folder.js 未加载，无法使用文件夹模式。';
        folderStatusText.className = 'text-xs text-red-500 mt-2 text-center';
        return;
    }

    // 目录选择器失败留下的提示优先显示：这条要说清"为什么没打开"以及"现在会怎么处理"
    if (folderModeNotice) {
        folderStatusText.textContent = folderModeNotice;
        folderStatusText.className = 'text-xs text-amber-600 mt-2 text-center';
        return;
    }

    if (FolderFs.isSupported()) {
        folderStatusText.textContent = '可直接写回原文件夹：转换结果覆盖原路径的同名文件，动手前会先列出清单让你确认。';
        folderStatusText.className = 'text-xs text-gray-400 mt-2 text-center';
    } else {
        folderStatusText.textContent = '⚠ 当前浏览器不支持直接写回文件夹（需要 Chrome / Edge 的 File System Access API）。仍然可以选文件夹读取并转换，结果会打包成 ZIP 下载。';
        folderStatusText.className = 'text-xs text-amber-600 mt-2 text-center';
    }
}

// --- 页面状态 ---

function switchTab(tabName) {
    if (isProcessing) {
        showStatusMessage('正在转换中，请等当前任务完成后再切换标签。');
        return;
    }

    currentTab = tabName;

    Object.keys(TAB_ELEMENTS).forEach(name => {
        const isActive = name === tabName;
        const elements = TAB_ELEMENTS[name];

        elements.tab.classList.toggle('active', isActive);
        elements.tab.classList.toggle('text-gray-500', !isActive);
        elements.tab.classList.toggle('hover:text-gray-700', !isActive);
        elements.panel.classList.toggle('active', isActive);
    });

    zipOptions.classList.toggle('hidden', tabName !== 'zip');
    folderOptions.classList.toggle('hidden', tabName !== 'folder');

    clearFiles();
}

function clearFiles() {
    filesToProcess = [];
    loadedZip = null;
    originalInputName = null;
    zipImages = [];
    selectedCoverImage = null;
    zipHasMp3 = false;
    zipWavCount = 0;
    currentWork = null;
    folderStore = null;
    folderScan = null;

    hideWorkInfo();
    closeWritebackModal();

    imagePreviewGrid.innerHTML = '';
    imagePreviewTitle.textContent = '图片预览 (点击选择封面)';
    imagePreviewContainer.classList.add('hidden');

    fileInputDirect.value = '';
    fileInputZip.value = '';
    fileInputFolder.value = '';

    fileList.innerHTML = '';
    fileListTitle.textContent = '待处理 VTT 文件';
    fileListContainer.classList.add('hidden');
    actionButtons.classList.add('hidden');

    hideProgress();
    showStatusMessage('');
    setButtonLoading(false);
    updateActionButtonLabel();
}

function setButtonLoading(isLoading) {
    if (isLoading) {
        convertBtn.disabled = true;
        btnText.classList.add('hidden');
        spinner.classList.remove('hidden');
    } else {
        convertBtn.disabled = false;
        btnText.classList.remove('hidden');
        spinner.classList.add('hidden');
    }
}

/**
 * 按钮文案要说清接下来会发生什么：文件夹模式下可能是"写回原路径"，
 * 也可能是"打包下载"（只读降级）。以前文件夹模式也写着"转换并下载 ZIP"，
 * 点下去却弹出写回清单，容易让人以为点错了。
 */
function updateActionButtonLabel() {
    const isFolderMode = !!folderStore;

    btnText.textContent = isFolderMode && folderStore.canWrite
        ? '转换并写回原文件夹'
        : '转换并下载 ZIP';
}

/**
 * 转换期间锁住会重置状态的入口（切标签 / 清空 / 重新选文件）。
 * 以前切标签会触发 clearFiles()，把正在跑的任务依赖的封面、包对象一起清掉，
 * 结果就是"后面的文件没封面"、下载名退化成 converted_lrc_时间戳.zip。
 */
function setProcessing(processing) {
    isProcessing = processing;

    convertBtn.disabled = processing;
    clearBtn.disabled = processing;

    Object.keys(TAB_ELEMENTS).forEach(name => {
        const tab = TAB_ELEMENTS[name].tab;

        tab.disabled = processing;
        tab.classList.toggle('opacity-50', processing);
        tab.classList.toggle('cursor-not-allowed', processing);
    });
}

// --- 文件处理 ---

function handleDirectFiles(inputFileList) {
    if (isProcessing) {
        showStatusMessage('正在转换中，请等当前任务完成后再选择文件。');
        return;
    }

    // 必须先快照：clearFiles() 会把 input.value 置空，
    // 而 Chrome 返回的 FileList 是"实时"的同一个对象，置空后它也会变空
    const selectedFiles = Array.from(inputFileList);

    clearFiles();

    const vttFiles = selectedFiles.filter(file => isVttFile(file.name));

    if (vttFiles.length === 0) {
        showStatusMessage('请选择 .vtt 文件。');
        return;
    }

    originalInputName = vttFiles[0].name;

    filesToProcess = vttFiles.map(file => ({
        name: file.name,
        getContent: () => file.text()
    }));

    // 直传模式没有音频，把上一轮遗留的 WAV 计数清掉，免得列表里挂着过期的提示
    zipWavCount = 0;
    zipHasMp3 = false;

    updateFileListUI(false, 0);
}

async function handleZipFile(zipFile) {
    if (isProcessing) {
        showStatusMessage('正在转换中，请等当前任务完成后再选择文件。');
        return;
    }

    if (!isZipFile(zipFile)) {
        showStatusMessage('请上传一个 ZIP 格式的压缩包。');
        return;
    }

    clearFiles();
    originalInputName = zipFile.name;

    try {
        loadedZip = await JSZip.loadAsync(zipFile);
        normalizeZipEntryNames(loadedZip);

        const vttZipEntries = [];
        let hasMp3 = false;
        let wavCount = 0;

        for (const filename in loadedZip.files) {
            const entry = loadedZip.files[filename];
            if (entry.dir) continue;

            if (isVttFile(filename)) {
                vttZipEntries.push(entry);
            }

            if (isMp3File(filename)) {
                hasMp3 = true;
            }

            if (isWavFile(filename)) {
                wavCount++;
            }
        }

        filesToProcess = vttZipEntries.map(entry => ({
            name: entry.name,
            getContent: () => entry.async('string')
        }));

        updateFileListUI(hasMp3, wavCount);
        await extractAndDisplayImages();
        await lookupWorkByRj();
    } catch (error) {
        console.error('解压文件时出错:', error);
        showStatusMessage('无法读取此 ZIP 文件，可能已损坏。');
        loadedZip = null;
    }
}

// --- 文件夹模式：选择与扫描 ---

/** 点「选择文件夹」：优先走可写句柄，拿不到就降级为只读读入 + 打包下载（一定有反应） */
async function pickSourceFolder() {
    if (isProcessing) {
        showStatusMessage('正在转换中，请等当前任务完成后再选择文件夹。');
        return;
    }

    if (typeof FolderFs === 'undefined') {
        showStatusMessage('文件夹模块 folder.js 未加载，请刷新页面后重试。');
        return;
    }

    // 浏览器没有目录句柄 API（Firefox / Safari）：用 webkitdirectory 只读读入
    if (!FolderFs.isSupported()) {
        openReadOnlyFolderPicker();
        return;
    }

    clearFiles();
    showStatusMessage('请在系统弹窗里选择要处理的文件夹…', false);

    let picked;

    try {
        picked = await FolderFs.pickDirectory();
    } catch (error) {
        if (FolderFs.isAbortError(error)) {
            showStatusMessage('');
            return;
        }

        // 目录句柄 API 失败（权限被拒、没有用户激活、系统不支持…）不能就此结束：
        // 以前这里只弹一行报错，用户看到的就是"点了没反应"。改为退回只读读入，
        // 至少还能转换并打包下载。
        console.error('目录句柄选择器失败，改为只读读入文件夹:', error);
        openReadOnlyFolderPicker(`无法直接写回原文件夹（${error.name || '错误'}：${error.message || '浏览器未允许访问'}）。已改为只读读入，转换结果会打包成 ZIP 下载。`);
        return;
    }

    if (picked.canceled) {
        showStatusMessage('');
        return;
    }

    if (!picked.supported) {
        openReadOnlyFolderPicker();
        return;
    }

    await scanFolderHandle(picked.handle, picked.canWrite);
}

/** 降级入口：用 <input webkitdirectory> 只读读入文件夹（结果打包下载） */
function openReadOnlyFolderPicker(notice) {
    if (notice) {
        // 失败原因挂在文件夹状态行上常驻显示；底部状态栏留着上一句
        // "请在系统弹窗里选择…"会自相矛盾，所以清掉
        folderModeNotice = notice;
        showStatusMessage('');
        updateFolderSupport();
    }

    // 真实浏览器里这会同步弹出目录选择器；随后的扫描会把底部状态栏清空，
    // 所以提示挂在状态行上，不会被清掉
    fileInputFolder.click();
}

/** 降级路径：<input webkitdirectory> 或只读的拖拽目录 */
async function handleFolderInputFiles(inputFileList) {
    if (isProcessing) {
        showStatusMessage('正在转换中，请等当前任务完成后再选择文件夹。');
        return;
    }

    // 同样先快照：clearFiles() 会清空 input.value
    const selectedFiles = Array.from(inputFileList);

    clearFiles();

    if (selectedFiles.length === 0) {
        showStatusMessage('这个文件夹里没有可处理的文件。');
        return;
    }

    const rootName = getFolderNameFromFiles(selectedFiles);
    const handle = FolderFs.handleFromFiles(selectedFiles, rootName);

    await scanFolderHandle(handle, false);
}

function getFolderNameFromFiles(files) {
    for (const file of files) {
        const relative = String(file.webkitRelativePath || '').split(/[\\/]/).filter(Boolean);

        if (relative.length > 1) return relative[0];
    }

    return '所选文件夹';
}

/**
 * 拖进来的东西里可能夹着目录。
 * webkitGetAsEntry() 必须在事件处理期间同步调用（DataTransferItem 随后会失效），
 * 所以这里先把 entry 抓完再 await。
 */
async function handleFolderDrop(dataTransfer) {
    if (isProcessing) {
        showStatusMessage('正在转换中，请等当前任务完成后再选择文件夹。');
        return;
    }

    const items = dataTransfer && dataTransfer.items ? Array.from(dataTransfer.items) : [];
    let directoryEntry = null;

    for (const item of items) {
        if (item.kind !== 'file') continue;

        const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;

        if (entry && entry.isDirectory) {
            directoryEntry = entry;
            break;
        }
    }

    if (!directoryEntry) {
        const fileCount = dataTransfer && dataTransfer.files ? dataTransfer.files.length : 0;

        showStatusMessage(fileCount
            ? '拖进来的不是文件夹。想直接传 VTT 请用「上传多个 VTT 文件」标签页，或改点上面的选择框挑文件夹。'
            : '没有识别到文件夹，请重试或改用点击选择。');

        return;
    }

    let handle;

    try {
        // 拿到的是 FileSystemDirectoryHandle，是否可写要等写的时候才知道
        handle = await directoryEntry.handle;
    } catch (error) {
        console.error('读取拖入的文件夹失败:', error);
        showStatusMessage('读取拖入的文件夹失败，改用点击选择试试。');
        return;
    }

    clearFiles();
    await scanFolderHandle(handle, FolderFs.canWriteDirectory(handle));
}

/** 扫描目录 → 填充文件列表 / 图片预览 / RJ 联动 */
async function scanFolderHandle(handle, canWrite) {
    clearFiles();

    const rootName = String(handle.name || '所选文件夹');

    folderStore = {
        handle,
        canWrite: !!canWrite,
        rootName
    };

    originalInputName = rootName;

    setProgress(0.02, `正在扫描文件夹「${rootName}」…`);

    try {
        const scan = await FolderFs.scanDirectory(handle, {
            maxDepth: FolderFs.MAX_DEPTH,
            onProgress: message => setProgress(0.02, message)
        });

        let vttCount = 0;
        let wavCount = 0;
        let mp3Count = 0;
        let imageCount = 0;
        let otherCount = 0;

        for (const file of scan.files) {
            if (isVttFile(file.relPath)) vttCount++;
            else if (isWavFile(file.relPath)) wavCount++;
            else if (isMp3File(file.relPath)) mp3Count++;
            else if (FolderFs.IMAGE_EXTENSIONS.test(file.relPath)) imageCount++;
            else otherCount++;
        }

        folderScan = {
            vttCount,
            wavCount,
            mp3Count,
            imageCount,
            otherCount,
            skippedDirs: scan.skippedDirs,
            truncated: scan.truncated
        };

        folderFileCache = scan.files;

        const vttFiles = scan.files.filter(file => isVttFile(file.relPath));

        filesToProcess = vttFiles.slice(0, FOLDER_FILE_LIMIT).map(file => ({
            name: file.relPath,
            getContent: async () => (await file.handle.getFile()).text()
        }));

        updateFileListUI(mp3Count > 0, wavCount);
        await loadFolderImages(scan.files);
        await lookupWorkByRj();
    } catch (error) {
        console.error('扫描文件夹失败:', error);
        showStatusMessage(`扫描文件夹失败：${error.message || '请检查权限后重试'}。`);
        folderStore = null;
        folderScan = null;
    } finally {
        hideProgress();
    }
}

/** 文件夹里的图片直接当封面候选（只在内存里读一次，不写回） */
async function loadFolderImages(files) {
    zipImages = [];
    selectedCoverImage = null;

    const imageFiles = files.filter(file => FolderFs.IMAGE_EXTENSIONS.test(file.relPath));

    for (const file of imageFiles.slice(0, 60)) {
        try {
            const blob = await file.handle.getFile();

            zipImages.push({
                name: file.relPath,
                mime: FolderFs.mimeForPath(file.relPath),
                base64: await blobToBase64(blob)
            });
        } catch (error) {
            console.warn(`读取图片失败：${file.relPath}`, error);
        }
    }

    renderImageGrid();
}

function refreshFolderFileList() {
    if (!folderStore || !folderScan) return;

    updateFileListUI(folderScan.mp3Count > 0, folderScan.wavCount);
}

// --- 作品信息（RJ 号自动查询）---

/** 从任意字符串里找出 RJ 号，形如 RJ344794 或 RJ01014447 */
function findRjCodeIn(text) {
    const match = String(text || '').match(/RJ\s*(\d{6,8})/i);

    return match ? `RJ${match[1]}` : null;
}

/** 先在压缩包名 / 文件夹名里找 RJ 号，再退回到包内路径里找 */
function detectRjCode() {
    const fromInputName = findRjCodeIn(originalInputName);

    if (fromInputName) return fromInputName;

    for (const file of filesToProcess) {
        const found = findRjCodeIn(file.name);

        if (found) return found;
    }

    if (!loadedZip) return null;

    for (const filename in loadedZip.files) {
        const found = findRjCodeIn(filename);

        if (found) return found;
    }

    return null;
}

function hideWorkInfo() {
    workInfo.classList.add('hidden');
    workCover.classList.add('hidden');
    workCover.removeAttribute('src');
    workTitle.textContent = '';
    workMeta.textContent = '';
    workStatus.textContent = '';
    workLink.classList.add('hidden');
}

function showWorkStatus(text) {
    workInfo.classList.remove('hidden');
    workStatus.textContent = text;
}

async function lookupWorkMetadata(rj) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RJ_LOOKUP_TIMEOUT);

    try {
        const response = await fetch(`${RJ_METADATA_ENDPOINT}/?rj=${encodeURIComponent(rj)}`, {
            signal: controller.signal
        });

        let data = null;

        try {
            data = await response.json();
        } catch {
            throw new Error(`元数据服务返回了非 JSON 内容（HTTP ${response.status}）`);
        }

        if (!response.ok || !data || !data.ok) {
            throw new Error((data && data.error) || `HTTP ${response.status}`);
        }

        return data;
    } finally {
        clearTimeout(timer);
    }
}

/** 抓到封面图后塞进预览网格，并在用户还没选封面时自动选中 */
async function applyWorkCover(meta) {
    if (!meta.coverUrl) return false;

    const response = await fetch(meta.coverUrl);

    if (!response.ok) throw new Error(`封面下载失败（HTTP ${response.status}）`);

    const blob = await response.blob();
    const image = {
        name: `${meta.rj || 'dlsite'}-封面.jpg`,
        mime: blob.type || 'image/jpeg',
        base64: await blobToBase64(blob),
        fromDlsite: true
    };

    zipImages = [image].concat(zipImages.filter(item => !item.fromDlsite));
    renderImageGrid();

    // 用户手动选过封面就别抢
    if (!selectedCoverImage) {
        selectCoverImage(0);
    }

    workCover.src = `data:${image.mime};base64,${image.base64}`;
    workCover.classList.remove('hidden');

    return true;
}

function renderWorkInfo(meta) {
    workInfo.classList.remove('hidden');
    workTitle.textContent = meta.title || '(无标题)';

    const parts = [];

    if (meta.circle) parts.push(meta.circle);
    if (meta.voiceBy && meta.voiceBy.length) parts.push(`声优：${meta.voiceBy.join('、')}`);
    if (meta.workType) parts.push(meta.workType);
    if (meta.releaseDate) parts.push(meta.releaseDate);
    if (meta.genres && meta.genres.length) parts.push(meta.genres.slice(0, 4).join(' / '));

    workMeta.textContent = parts.join(' · ');

    if (meta.pageUrl) {
        workLink.href = meta.pageUrl;
        workLink.classList.remove('hidden');
    }
}

/** 选好文件夹 / 压缩包后自动跑一遍：识别 RJ → 查作品 → 抓封面 */
async function lookupWorkByRj() {
    currentWork = null;

    const rj = detectRjCode();

    if (!rj) {
        hideWorkInfo();
        return;
    }

    if (!RJ_METADATA_ENDPOINT) {
        showWorkStatus(`识别到 ${rj}，但还没配置 RJ 元数据服务（部署方法见 worker/README.md），封面请手动选择。`);
        return;
    }

    showWorkStatus(`正在查询 ${rj} 的作品信息…`);

    try {
        const meta = await lookupWorkMetadata(rj);

        currentWork = meta;
        renderWorkInfo(meta);

        try {
            await applyWorkCover(meta);
            workStatus.textContent = `${meta.rj} · 已自动选好封面，可在下方预览里改选`;
        } catch (error) {
            workStatus.textContent = `${meta.rj} · 作品信息已获取，但封面下载失败：${error.message}`;
        }
    } catch (error) {
        currentWork = null;
        showWorkStatus(`查询 ${rj} 失败：${error.message}（不影响使用，封面可手动选择）`);
    }
}

// --- 文件列表 ---

function updateFileListUI(hasMp3 = false, wavCount = 0) {
    zipHasMp3 = hasMp3;
    zipWavCount = wavCount;

    const isFolderMode = currentTab === 'folder' && !!folderStore && !!folderScan;
    const shouldTranscodeWav = isFolderMode ? folderTranscodeCheckbox.checked : transcodeWavCheckbox.checked;
    const willTranscode = wavCount > 0 && shouldTranscodeWav;
    const hasWork = filesToProcess.length > 0 || hasMp3 || willTranscode;

    fileListTitle.textContent = isFolderMode ? '待处理 VTT 文件（写回原路径）' : '待处理 VTT 文件';

    if (!hasWork) {
        showStatusMessage(isFolderMode
            ? '这个文件夹里没有找到 .vtt、.mp3 或 .wav 文件。'
            : '在上传的文件中未找到任何 .vtt、.mp3 或 .wav 文件。');
        fileListContainer.classList.add('hidden');
        actionButtons.classList.add('hidden');
        renderFolderNote();
        return;
    }

    showStatusMessage('');
    fileList.innerHTML = '';

    if (filesToProcess.length === 0) {
        const li = document.createElement('li');

        li.className = 'text-sm text-gray-500 p-3';
        li.textContent = hasMp3 ? '未找到 VTT 文件，将仅处理 MP3 封面嵌入' : '未找到 VTT 文件';
        fileList.appendChild(li);
    }

    filesToProcess.forEach(file => {
        const li = document.createElement('li');
        li.className = 'list-item flex items-center justify-between bg-gray-50 p-3 rounded-lg';

        const safeName = escapeHtml(file.name);

        li.innerHTML = `
            <span class="text-sm font-medium text-gray-700 truncate" title="${safeName}">${safeName}</span>
            <span class="text-sm text-green-600">待处理</span>
        `;

        fileList.appendChild(li);
    });

    // 先让列表可见再渲染底部提示：renderFolderNote 会检查列表是不是隐藏的
    fileListContainer.classList.remove('hidden');
    actionButtons.classList.remove('hidden');

    renderZipWavNote();
    renderFolderNote();

    updateActionButtonLabel();
}

/** 在文件列表里提示包内 WAV 会被转码还是原样保留 */
function renderZipWavNote() {
    const existing = document.getElementById('zip-wav-note');

    if (existing) existing.remove();

    if (!loadedZip || !zipWavCount) return;

    const li = document.createElement('li');

    li.id = 'zip-wav-note';
    li.className = 'text-sm text-blue-700 bg-blue-50 p-3 rounded-lg';
    li.textContent = transcodeWavCheckbox.checked
        ? `另有 ${zipWavCount} 个 WAV 文件将转码为 320 kbps 的 MP3`
        : `另有 ${zipWavCount} 个 WAV 文件将原样保留（未勾选转码）`;

    fileList.appendChild(li);
}

function refreshZipFileList() {
    if (!loadedZip) return;

    updateFileListUI(zipHasMp3, countZipWavFiles(loadedZip));
}
/** 文件夹模式：文件列表里额外说清"会写到哪里" */
function renderFolderNote() {
    const existing = document.getElementById('folder-wav-note');

    if (existing) existing.remove();

    if (currentTab !== 'folder' || !folderStore || !folderScan) {
        folderNote.textContent = '';
        return;
    }

    const parts = [];

    if (folderScan.wavCount) {
        parts.push(folderTranscodeCheckbox.checked
            ? `${folderScan.wavCount} 个 WAV 将转码为 MP3 并写回原路径`
            : `${folderScan.wavCount} 个 WAV 会原样保留（未勾选转码）`);
    }

    if (folderScan.imageCount) parts.push(`${folderScan.imageCount} 张图片可用于封面`);
    if (folderScan.otherCount) parts.push(`${folderScan.otherCount} 个其它文件不会被改动`);
    if (folderScan.skippedDirs.length) parts.push(`有 ${folderScan.skippedDirs.length} 个子目录读不动，已跳过`);
    if (folderScan.truncated) parts.push('目录层级过深，只扫描了前面若干层');

    folderNote.textContent = parts.length ? `${parts.join('；')}。` : '';
    folderNote.className = folderScan.skippedDirs.length || folderScan.truncated
        ? 'text-xs text-amber-600 mt-2'
        : 'text-xs text-gray-400 mt-2';

    if (!fileList || fileListContainer.classList.contains('hidden') || !folderScan.wavCount) return;

    const li = document.createElement('li');


    li.id = 'folder-wav-note';
    li.className = 'text-sm text-blue-700 bg-blue-50 p-3 rounded-lg';
    li.innerHTML = folderTranscodeCheckbox.checked
        ? `另有 ${folderScan.wavCount} 个 WAV 将转码后写回原路径，原文件${folderDeleteSourceCheckbox.checked ? '会被删除' : '保留'}`
        : `另有 ${folderScan.wavCount} 个 WAV 将原样保留（未勾选转码）`;

    fileList.appendChild(li);
}

// --- VTT 转 LRC ---

function convertVttToLrc(vttContent) {
    const cleanContent = String(vttContent)
        .replace(/^\uFEFF/, '')
        .replace(/^WEBVTT[^\n]*\n?/i, '')
        .replace(/\r/g, '');

    const lines = cleanContent.split('\n');
    let lrcContent = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (!line.includes('-->')) continue;

        const startTime = line.split('-->')[0].trim();
        const timestamp = convertVttTimeToLrcTime(startTime);

        if (!timestamp) continue;

        let text = '';
        let j = i + 1;

        while (j < lines.length && lines[j].trim() !== '') {
            const subtitleLine = lines[j].trim();

            // 跳过常见 VTT 标签和 NOTE 块
            if (!/^NOTE\b/i.test(subtitleLine)) {
                text += subtitleLine + ' ';
            }

            j++;
        }

        text = cleanupSubtitleText(text.trim());
        i = j - 1;

        if (text) {
            lrcContent += `${timestamp}${text}\n`;
        }
    }

    return lrcContent;
}

function convertVttTimeToLrcTime(vttTime) {
    // 支持：
    // 00:01.234
    // 01:02:03.456
    const match = String(vttTime).match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);

    if (!match) return null;

    const hours = parseInt(match[1] || '0', 10);
    const minutes = parseInt(match[2] || '0', 10);
    const seconds = parseInt(match[3] || '0', 10);
    const milliseconds = parseInt((match[4] || '0').padEnd(3, '0'), 10);

    const totalMinutes = hours * 60 + minutes;
    const hundredths = Math.floor(milliseconds / 10);

    return `[${String(totalMinutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}]`;
}

function cleanupSubtitleText(text) {
    return String(text)
        .replace(/<[^>]+>/g, '') // 去掉 VTT 简单标签
        .replace(/\s+/g, ' ')
        .trim();
}

function getLrcFilename(vttFilename) {
    if (/\.mp3\.vtt$/i.test(vttFilename)) {
        return vttFilename.replace(/\.mp3\.vtt$/i, '.lrc');
    }

    if (/\.wav\.vtt$/i.test(vttFilename)) {
        return vttFilename.replace(/\.wav\.vtt$/i, '.lrc');
    }

    return vttFilename.replace(/\.vtt$/i, '.lrc');
}

// --- 图片预览与封面选择 ---

async function extractAndDisplayImages() {
    zipImages = [];
    selectedCoverImage = null;

    const imageExts = /\.(jpe?g|png|gif|webp|bmp)$/i;
    const mimeMap = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        bmp: 'image/bmp'
    };

    for (const filename in loadedZip.files) {
        const entry = loadedZip.files[filename];

        if (entry.dir || !imageExts.test(filename)) continue;

        const ext = filename.split('.').pop().toLowerCase();
        const mime = mimeMap[ext];

        if (!mime) continue;

        try {
            const base64 = await entry.async('base64');
            zipImages.push({
                name: filename,
                mime,
                base64
            });
        } catch (error) {
            console.warn(`读取图片失败：${filename}`, error);
        }
    }

    renderImageGrid();
}

function renderImageGrid() {
    imagePreviewGrid.innerHTML = '';

    if (zipImages.length === 0) {
        imagePreviewContainer.classList.add('hidden');
        return;
    }

    zipImages.forEach((img, index) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'image-thumb-wrapper';
        wrapper.dataset.index = String(index);
        wrapper.dataset.name = img.name;
        wrapper.title = img.name;

        const image = document.createElement('img');
        image.src = `data:${img.mime};base64,${img.base64}`;
        image.alt = img.name;

        const check = document.createElement('div');
        check.className = 'cover-check';
        check.textContent = '✓';

        wrapper.appendChild(image);
        wrapper.appendChild(check);

        // 保留已有选择（例如先选封面再选音频文件时）
        if (selectedCoverImage && selectedCoverImage.base64 === img.base64) {
            wrapper.classList.add('selected');
        }

        wrapper.addEventListener('click', () => selectCoverImage(index));
        imagePreviewGrid.appendChild(wrapper);
    });

    imagePreviewTitle.textContent = selectedCoverImage
        ? '图片预览 (点击选择封面，再点一次取消)'
        : '图片预览 (点击选择封面)';

    imagePreviewContainer.classList.remove('hidden');
}

function selectCoverImage(index) {
    const wrappers = imagePreviewGrid.querySelectorAll('.image-thumb-wrapper');

    if (!zipImages[index]) return;

    if (selectedCoverImage && selectedCoverImage.base64 === zipImages[index].base64) {
        selectedCoverImage = null;
        wrappers[index].classList.remove('selected');
        imagePreviewTitle.textContent = '图片预览 (点击选择封面)';
        return;
    }

    wrappers.forEach(wrapper => wrapper.classList.remove('selected'));
    wrappers[index].classList.add('selected');

    selectedCoverImage = {
        name: zipImages[index].name,
        mime: zipImages[index].mime,
        base64: zipImages[index].base64
    };

    imagePreviewTitle.textContent = '图片预览 (点击选择封面，再点一次取消)';
}

// --- 图片标准化：解决手机播放器不识别大图/Exif/非方图的问题 ---

async function normalizeCoverImage(imageBase64, imageMime, options = {}) {
    const maxSize = options.maxSize || 800;
    const quality = options.quality || 0.85;

    const blob = base64ToBlob(imageBase64, imageMime);
    const bitmap = await loadImageBitmapCompatible(blob);

    const sourceWidth = bitmap.width;
    const sourceHeight = bitmap.height;

    if (!sourceWidth || !sourceHeight) {
        throw new Error('无法读取封面图片尺寸。');
    }

    // 居中裁剪为正方形
    const cropSize = Math.min(sourceWidth, sourceHeight);
    const cropX = Math.floor((sourceWidth - cropSize) / 2);
    const cropY = Math.floor((sourceHeight - cropSize) / 2);

    // 限制最大尺寸
    const targetSize = Math.min(maxSize, cropSize);

    const canvas = document.createElement('canvas');
    canvas.width = targetSize;
    canvas.height = targetSize;

    const ctx = canvas.getContext('2d', {
        alpha: false
    });

    // 填白底，避免 PNG/WebP 透明区域转 JPEG 后变黑
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetSize, targetSize);

    ctx.drawImage(
        bitmap,
        cropX,
        cropY,
        cropSize,
        cropSize,
        0,
        0,
        targetSize,
        targetSize
    );

    const jpegBlob = await new Promise(resolve => {
        canvas.toBlob(resolve, 'image/jpeg', quality);
    });

    if (!jpegBlob) {
        throw new Error('封面图片转换为 JPEG 失败。');
    }

    const normalizedBase64 = await blobToBase64(jpegBlob);

    return {
        mime: 'image/jpeg',
        base64: normalizedBase64,
        originalWidth: sourceWidth,
        originalHeight: sourceHeight,
        outputSize: targetSize,
        byteLength: jpegBlob.size
    };
}

function base64ToBlob(base64, mime) {
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);

    for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
    }

    return new Blob([bytes], {
        type: mime
    });
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => {
            const result = String(reader.result || '');
            const commaIndex = result.indexOf(',');
            resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
        };

        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

async function loadImageBitmapCompatible(blob) {
    if ('createImageBitmap' in window) {
        return await createImageBitmap(blob);
    }

    return await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const image = new Image();

        image.onload = () => {
            URL.revokeObjectURL(url);
            resolve(image);
        };

        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('图片解码失败。'));
        };

        image.src = url;
    });
}

// --- ID3v2 读写工具 ---

function readSynchsafeInt(bytes, offset) {
    return (
        ((bytes[offset] & 0x7F) << 21) |
        ((bytes[offset + 1] & 0x7F) << 14) |
        ((bytes[offset + 2] & 0x7F) << 7) |
        (bytes[offset + 3] & 0x7F)
    );
}

function writeSynchsafeInt(value) {
    return new Uint8Array([
        (value >> 21) & 0x7F,
        (value >> 14) & 0x7F,
        (value >> 7) & 0x7F,
        value & 0x7F
    ]);
}

function readUint32BE(bytes, offset) {
    return (
        (bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]
    ) >>> 0;
}

function writeUint32BE(value) {
    return new Uint8Array([
        (value >>> 24) & 0xFF,
        (value >>> 16) & 0xFF,
        (value >>> 8) & 0xFF,
        value & 0xFF
    ]);
}

function hasId3v2Tag(bytes) {
    return bytes.length >= 10 &&
        bytes[0] === 0x49 &&
        bytes[1] === 0x44 &&
        bytes[2] === 0x33;
}

function parseId3v2(bytes) {
    if (!hasId3v2Tag(bytes)) {
        return {
            hasTag: false,
            majorVersion: null,
            revision: null,
            flags: 0,
            tagStart: 0,
            tagEnd: 0,
            frameData: new Uint8Array(0),
            audioStart: 0
        };
    }

    const majorVersion = bytes[3];
    const revision = bytes[4];
    const flags = bytes[5];
    const tagSize = readSynchsafeInt(bytes, 6);

    let tagEnd = 10 + tagSize;

    // ID3v2 footer
    if (flags & 0x10) {
        tagEnd += 10;
    }

    tagEnd = Math.min(tagEnd, bytes.length);

    return {
        hasTag: true,
        majorVersion,
        revision,
        flags,
        tagStart: 0,
        tagEnd,
        frameData: bytes.slice(10, Math.min(10 + tagSize, bytes.length)),
        audioStart: tagEnd
    };
}

/**
 * 拆出 ID3v2.3 的各个帧，返回 { id, bytes } 列表。
 * 遇到 padding 或长度不合法就停止（后面的内容当填充忽略）。
 */
function parseId3v23Frames(frameData) {
    const frames = [];
    let offset = 0;

    while (offset + 10 <= frameData.length) {
        const frameId = String.fromCharCode(
            frameData[offset],
            frameData[offset + 1],
            frameData[offset + 2],
            frameData[offset + 3]
        );

        // padding
        if (!/^[A-Z0-9]{4}$/.test(frameId)) {
            break;
        }

        const frameSize = readUint32BE(frameData, offset + 4);
        const frameTotalSize = 10 + frameSize;

        if (frameSize <= 0 || offset + frameTotalSize > frameData.length) {
            break;
        }

        frames.push({
            id: frameId,
            bytes: frameData.slice(offset, offset + frameTotalSize)
        });

        offset += frameTotalSize;
    }

    return frames;
}

function createTextFrameV23(frameId, text) {
    const textBytes = new TextEncoder().encode(String(text || ''));
    const frameContent = new Uint8Array(1 + textBytes.length);

    frameContent[0] = 0x03; // UTF-8。虽然 ID3v2.3 标准里更常见 UTF-16，但多数现代播放器能识别
    frameContent.set(textBytes, 1);

    return createFrameV23(frameId, frameContent);
}

/**
 * 把作品信息整理成 ID3v2.3 文本帧。
 * TIT2=曲名  TALB=专辑（作品名）  TPE1=艺术家（声优）  TPE2=专辑艺术家（社团）
 * TCON=流派  TYER=年份（v2.3 用 TYER，不是 v2.4 的 TDRC）
 */
function buildTextFramesV23(metadata) {
    const pairs = [
        ['TIT2', metadata.title],
        ['TALB', metadata.album],
        ['TPE1', metadata.artist],
        ['TPE2', metadata.albumArtist],
        ['TCON', metadata.genre],
        ['TYER', metadata.year]
    ].filter(([, value]) => value);

    return pairs.map(([frameId, value]) => ({
        id: frameId,
        bytes: createTextFrameV23(frameId, value)
    }));
}

function createApicFrameV23(imageBytes, imageMime) {
    const mimeTypeBytes = new TextEncoder().encode(imageMime || 'image/jpeg');

    // APIC content:
    // text encoding: 1 byte
    // MIME: n bytes
    // null terminator: 1 byte
    // picture type: 1 byte
    // description null terminator: 1 byte
    // image data: n bytes
    const frameContentSize = 1 + mimeTypeBytes.length + 1 + 1 + 1 + imageBytes.length;
    const frameContent = new Uint8Array(frameContentSize);

    let offset = 0;

    frameContent[offset++] = 0x00; // ISO-8859-1，描述为空，所以最兼容
    frameContent.set(mimeTypeBytes, offset);
    offset += mimeTypeBytes.length;
    frameContent[offset++] = 0x00; // MIME null
    frameContent[offset++] = 0x03; // Front Cover
    frameContent[offset++] = 0x00; // empty description
    frameContent.set(imageBytes, offset);

    return createFrameV23('APIC', frameContent);
}

function createFrameV23(frameId, frameContent) {
    const frame = new Uint8Array(10 + frameContent.length);
    const frameIdBytes = new TextEncoder().encode(frameId);

    frame.set(frameIdBytes, 0);
    frame.set(writeUint32BE(frameContent.length), 4);

    frame[8] = 0x00;
    frame[9] = 0x00;

    frame.set(frameContent, 10);

    return frame;
}

function createId3v23Tag(frames) {
    const frameData = concatUint8Arrays(frames);
    const header = new Uint8Array(10);

    header[0] = 0x49; // I
    header[1] = 0x44; // D
    header[2] = 0x33; // 3
    header[3] = 0x03; // ID3v2.3
    header[4] = 0x00;
    header[5] = 0x00;

    header.set(writeSynchsafeInt(frameData.length), 6);

    return concatUint8Arrays([header, frameData]);
}

function concatUint8Arrays(arrays) {
    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);

    let offset = 0;

    arrays.forEach(arr => {
        result.set(arr, offset);
        offset += arr.length;
    });

    return result;
}

function base64ToUint8Array(base64) {
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);

    for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
    }

    return bytes;
}

/** 取 MP3 里已有的 APIC 图片字节（用于判断"封面已经是这张了，不用重写"） */
function findApicImageBytes(bytes) {
    const parsed = parseId3v2(bytes);

    if (!parsed.hasTag) return null;

    for (const frame of parseId3v23Frames(parsed.frameData)) {
        if (frame.id !== 'APIC') continue;

        const content = frame.bytes.slice(10);
        let offset = 1; // 文本编码
        const mimeEnd = content.indexOf(0x00, offset);

        if (mimeEnd < 0) continue;

        offset = mimeEnd + 1;

        if (offset >= content.length) continue;

        offset += 1; // 图片类型
        const descriptionEnd = content.indexOf(0x00, offset);

        if (descriptionEnd < 0) continue;

        return content.slice(descriptionEnd + 1);
    }

    return null;
}

// --- ID3v2 封面写入 ---
// 重点改进：
// 1. 写入前把封面压缩成 800x800 JPEG
// 2. 对 ID3v2.3 文件尽量保留原标签，只替换 APIC，缺失的文本帧再补上
// 3. 非 ID3v2.3 或无标签时，写入一个新的 ID3v2.3 标签

async function addId3v2Cover(mp3ArrayBuffer, imageBase64, imageMime, metadata = {}) {
    const normalizedCover = await normalizeCoverImage(imageBase64, imageMime, {
        maxSize: 800,
        quality: 0.85
    });

    return applyNormalizedCover(mp3ArrayBuffer, normalizedCover, metadata);
}

/** 已经压好尺寸的封面直接嵌，省掉重复解码 */
function applyNormalizedCover(mp3ArrayBuffer, normalizedCover, metadata = {}) {
    const imageBytes = base64ToUint8Array(normalizedCover.base64);
    const mp3Bytes = new Uint8Array(mp3ArrayBuffer);
    const parsed = parseId3v2(mp3Bytes);
    const audioBytes = mp3Bytes.slice(parsed.audioStart);

    const apicFrame = createApicFrameV23(imageBytes, normalizedCover.mime);
    const textFrames = buildTextFramesV23(metadata);
    const frames = [];

    if (parsed.hasTag && parsed.majorVersion === 3) {
        // 保留原 ID3v2.3 的非 APIC 帧，只替换封面；
        // 原标签里没有的文本帧（专辑/艺术家等）补进去，已有的不动
        const keptFrames = parseId3v23Frames(parsed.frameData).filter(frame => frame.id !== 'APIC');
        const existingIds = new Set(keptFrames.map(frame => frame.id));

        keptFrames.forEach(frame => frames.push(frame.bytes));
        textFrames
            .filter(frame => !existingIds.has(frame.id))
            .forEach(frame => frames.push(frame.bytes));

        frames.push(apicFrame);
    } else {
        // 没有 ID3v2 标签，或版本不是 v2.3：新建一个兼容性较好的 ID3v2.3 标签
        textFrames.forEach(frame => frames.push(frame.bytes));
        frames.push(apicFrame);
    }

    const id3Tag = createId3v23Tag(frames);
    const result = new Uint8Array(id3Tag.length + audioBytes.length);

    result.set(id3Tag, 0);
    result.set(audioBytes, id3Tag.length);

    return result.buffer;
}

// --- 统一虚拟条目：ZIP / 文件夹 / 只读文件夹都用同一套结构 ---

async function blobToBytes(blob) {
    return new Uint8Array(await blob.arrayBuffer());
}

/**
 * 把任务的数据来源统一成"虚拟条目"列表：
 *   { path, relPath, name, kind, size, getBlob, getBytes, getText, getDigest }
 *
 * 这样后面的转换、打包、写回都只认这一种结构，不必到处判断
 * "现在是 ZIP 还是文件夹"。digest 只算一次并缓存，写回时用来
 * 判断"内容没变就跳过"，避免无谓地改动文件时间戳。
 */
async function buildVirtualEntries(job) {
    if (job.sourceKind === 'zip') {
        const entries = [];

        for (const filename in job.zip.files) {
            const zipEntry = job.zip.files[filename];

            if (zipEntry.dir) continue;

            entries.push(createZipEntrySource(filename, zipEntry));
        }

        return entries;
    }

    if (job.sourceKind === 'folder') {
        const rootName = job.folderRootName || 'folder';

        return (job.directoryFiles || []).map(file => createFolderEntrySource(file, rootName));
    }

    // 直传模式：只有用户挑中的那几个 VTT
    return (job.files || []).map(file => ({
        path: file.name,
        relPath: file.name,
        name: file.name,
        kind: 'vtt',
        size: 0,
        async getBlob() {
            return new Blob([await file.getContent()], { type: 'text/vtt' });
        },
        async getBytes() {
            return new TextEncoder().encode(await file.getContent());
        },
        getText: () => file.getContent(),
        async getDigest() {
            return computeDigest(new TextEncoder().encode(await file.getContent()));
        }
    }));
}

function createZipEntrySource(filename, zipEntry) {
    let bytesCache = null;
    let digestCache = null;

    return {
        path: filename,
        relPath: filename,
        name: getBaseName(filename),
        kind: entryKindFor(filename),
        size: 0,
        async getBlob() {
            return zipEntry.async('blob');
        },
        async getBytes() {
            if (!bytesCache) bytesCache = new Uint8Array(await zipEntry.async('arraybuffer'));

            return bytesCache;
        },
        async getText() {
            return zipEntry.async('string');
        },
        async getDigest() {
            if (!digestCache) digestCache = computeDigest(await this.getBytes());

            return digestCache;
        }
    };
}

function createFolderEntrySource(file, rootName) {
    let bytesCache = null;
    let digestCache = null;

    async function readBytes() {
        if (!bytesCache) bytesCache = new Uint8Array(await (await file.handle.getFile()).arrayBuffer());

        return bytesCache;
    }

    return {
        path: `${rootName}/${file.relPath}`,
        relPath: file.relPath,
        name: file.name,
        kind: entryKindFor(file.relPath),
        size: file.size || 0,
        async getBlob() {
            return file.handle.getFile();
        },
        getBytes: readBytes,
        async getText() {
            return (await file.handle.getFile()).text();
        },
        async getDigest() {
            if (!digestCache) digestCache = computeDigest(await readBytes());

            return digestCache;
        }
    };
}

function entryKindFor(filePath) {
    if (isVttFile(filePath)) return 'vtt';
    if (isWavFile(filePath)) return 'wav';
    if (isMp3File(filePath)) return 'mp3';
    if (typeof FolderFs !== 'undefined' && FolderFs.IMAGE_EXTENSIONS.test(filePath)) return 'image';

    return 'other';
}

// --- 输出名计算 ---

function getOutputFolderNameFromZip(zip, zipFileName) {
    let fallback = '';

    if (zipFileName) {
        fallback = zipFileName.replace(/\.zip$/i, '');
    }

    for (const fn in zip.files) {
        if (zip.files[fn].dir) continue;

        const parts = fn.split('/').filter(Boolean);
        const dirParts = parts.slice(0, -1);

        if (dirParts.length >= 2) {
            return `${dirParts[0]}_${dirParts[1]}`;
        }

        if (dirParts.length === 1) {
            return dirParts[0];
        }

        break;
    }

    return fallback || 'output';
}

function createFlattenedName(filename, existingNames) {
    const baseName = getBaseName(filename);
    const parts = filename.split('/').filter(Boolean);

    // 路径部分：去掉第一个根目录和最后一个文件名
    const pathParts = parts.slice(1, -1);
    const hasPath = pathParts.length > 0;
    const pathStr = pathParts.join('_');

    const isMusicOrSubtitle = /\.(mp3|wav|lrc|ogg|flac|aac|m4a)$/i.test(baseName) ||
        // 歌曲.wav.vtt 这类字幕输出的是 歌曲.lrc，要和 歌曲.mp3 同名，
        // 所以按音乐文件的方式加路径后缀，否则和音频文件名对不上
        /\.(mp3|wav|ogg|flac|aac|m4a)\.vtt$/i.test(baseName);

    let newName = baseName;

    if (existingNames.has(newName)) {
        if (isMusicOrSubtitle && hasPath) {
            // 歌曲.wav -> 歌曲_作品A.wav
            // 歌曲.wav.vtt -> 歌曲_作品A.wav.vtt（后缀插在音频扩展名之前，
            // 这样转出来的 歌曲_作品A.lrc 才能和 歌曲_作品A.mp3 同名）
            const vttSuffix = /\.vtt$/i.test(baseName) ? baseName.slice(-4) : '';
            const stem = vttSuffix ? baseName.slice(0, -4) : baseName;

            newName = stem.replace(/\.[^.]+$/, `_${pathStr}$&`) + vttSuffix;
        } else if (!isMusicOrSubtitle && hasPath) {
            newName = `${pathStr}_${baseName}`;
        } else {
            newName = addNumberSuffixUntilUnique(baseName, existingNames);
        }
    }

    if (existingNames.has(newName)) {
        newName = addNumberSuffixUntilUnique(newName, existingNames);
    }

    existingNames.add(newName);

    return newName;
}

function addNumberSuffixUntilUnique(filename, existingNames) {
    const dotIndex = filename.lastIndexOf('.');
    const nameBase = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
    const extPart = dotIndex > 0 ? filename.slice(dotIndex) : '';

    let counter = 2;
    let candidate = `${nameBase}_${counter}${extPart}`;

    while (existingNames.has(candidate)) {
        counter++;
        candidate = `${nameBase}_${counter}${extPart}`;
    }

    return candidate;
}

/**
 * 给每个条目定好"输出到哪个相对路径"（平铺模式会重命名）。
 *
 * 必须一次算完并固化到条目上，不能每次用到再算：createFlattenedName 内部
 * 带重名计数，分两次算（规划一次、执行一次）会各自从零开始，得到不一样的名字。
 * 返回的 takenNames 里已经装了所有输出名，后面转码再产生新名字时用它排重，
 * 这样"转码出的 MP3 名"和"本来就存在的 MP3 名"不会撞车。
 */
function resolveOutputNames(entries, job) {
    const existingNames = new Set();
    const takenNames = new Set();

    entries.forEach(entry => {
        // 写回原路径时默认保结构，只有勾了平铺才改名字
        entry.outputName = job.shouldFlatten
            ? createFlattenedName(entry.path, existingNames)
            : entry.relPath;
    });

    entries.forEach(entry => takenNames.add(entry.outputName));

    return takenNames;
}

/**
 * 平铺会把这些文件搬到根目录，重名时只能"跳过"而不是改名字
 * （改名字会让 歌曲.mp3 和 歌曲.lrc 对不上）。
 * 所以先在界面上说清风险，而不是等用户确认后才发现一半文件没写。
 */
function buildFlattenHint(job) {
    if (!job.shouldFlatten || !job.directoryFiles) return '';

    let nested = 0;

    for (const file of job.directoryFiles) {
        if (file.relPath.includes('/')) nested++;
    }

    if (nested === 0) return '';

    return `已勾选平铺：${nested} 个子目录里的文件会被搬到根目录，重名的（比如不同作品下同名的 01.mp3）只会写第一个，其余跳过。建议不勾选平铺。`;
}

// --- 转换与下载 ---

/**
 * 把当前界面状态冻结成一份任务快照。
 * 转换要跑很久（音声包可能几十分钟），期间运行中的任务只认这份快照，
 * 不再实时读全局变量，这样任何界面状态变化都不会影响正在进行的转换。
 */
function createJob() {
    const isFolderMode = !!folderStore;
    const isZipMode = !isFolderMode && !!loadedZip;

    return {
        sourceKind: isFolderMode ? 'folder' : (isZipMode ? 'zip' : 'direct'),
        directoryHandle: isFolderMode ? folderStore.handle : null,
        folderRootName: isFolderMode ? folderStore.rootName : null,
        directoryWritable: isFolderMode ? !!folderStore.canWrite : false,
        directoryFiles: isFolderMode ? folderFileCache : null,
        zip: loadedZip,
        files: filesToProcess,
        zipName: originalInputName,
        coverImage: selectedCoverImage, // 封面快照，最关键的一项
        work: currentWork, // 作品信息快照（用于写 ID3 的专辑/艺术家）
        shouldFlatten: isFolderMode ? folderFlattenCheckbox.checked : flattenCheckbox.checked,
        shouldTranscodeWav: isFolderMode ? folderTranscodeCheckbox.checked : transcodeWavCheckbox.checked,
        shouldDeleteSource: isFolderMode ? folderDeleteSourceCheckbox.checked : false,
        bitrate: MP3_BITRATE
    };
}

async function convertAndDownload() {
    if (isProcessing) return;
    if (filesToProcess.length === 0 && !loadedZip && !folderStore) return;

    // 文件夹的完整清单要扫一遍才知道，而扫描是异步的：先扫完再冻结快照，
    // 后面整条流水线就只认这份快照了
    if (folderStore) {
        try {
            setProgress(0.01, '正在读取文件夹清单…');
            await loadFolderFileCache();
        } catch (error) {
            console.error('读取文件夹失败:', error);
            hideProgress();
            showStatusMessage(`读取文件夹失败：${error.message || '请重新选择文件夹'}。`);
            return;
        }
    }

    const job = createJob();

    setProcessing(true);
    setButtonLoading(true);
    showStatusMessage('');

    try {
        if (job.sourceKind === 'folder' && job.directoryWritable) {
            await processFolderWriteBack(job);
        } else {
            const entries = await buildVirtualEntries(job);
            const outputZip = new JSZip();
            const result = await fillZipFromEntries(outputZip, entries, job);
            const zipBlob = await outputZip.generateAsync({
                type: 'blob'
            });
            const downloadName = getDownloadName(job);

            downloadBlob(zipBlob, downloadName);

            showResultMessage(result, `处理完成，已下载 ${downloadName}。`);
        }
    } catch (error) {
        console.error('转换或下载过程中发生错误:', error);
        showStatusMessage(`处理失败：${error.message || '请在控制台查看错误信息。'}`);
    } finally {
        setProcessing(false);
        setButtonLoading(false);
        hideProgress();
    }
}

function showResultMessage(result, successText) {
    const warnings = (result && result.warnings) || [];

    if (warnings.length > 0) {
        showStatusMessage(`${successText} 但有以下文件未处理成功：${warnings.join('；')}`);
    } else {
        showStatusMessage(successText, false);
    }
}

/** 文件夹模式下的文件清单缓存，避免重复扫目录 */
let folderFileCache = null;

async function loadFolderFileCache() {
    const handle = folderStore && folderStore.handle;

    if (!handle) throw new Error('没有可用的文件夹句柄。');

    // 选文件夹时已经扫过一遍，直接复用；只有缓存丢了才重新扫（重扫可能再弹一次授权）
    if (folderFileCache) return folderFileCache;

    const scan = await FolderFs.scanDirectory(handle);

    folderFileCache = scan.files;

    return folderFileCache;
}

// --- 目标一：打包成 ZIP（ZIP 模式 / 直传 VTT / 只读文件夹）---

async function fillZipFromEntries(outputZip, entries, job) {
    const bitrate = job.bitrate;
    const coverImage = job.coverImage; // 用快照，避免中途被 clearFiles 清掉
    const warnings = [];
    const outputFolder = job.sourceKind === 'zip'
        ? getOutputFolderNameFromZip(job.zip, job.zipName)
        : '';

    // 已占用的输出名：所有条目的输出名，跨条目排重
    const takenNames = resolveOutputNames(entries, job);

    const wavEntries = job.shouldTranscodeWav
        ? entries.filter(entry => entry.kind === 'wav')
        : [];

    let wavIndex = 0;

    for (const entry of entries) {
        if (entry.kind === 'vtt') {
            const lrcContent = convertVttToLrc(await entry.getText());

            outputZip.file(joinZipPath(outputFolder, getLrcFilename(entry.outputName)), lrcContent);            continue;
        }

        if (entry.kind === 'wav' && job.shouldTranscodeWav) {
            wavIndex++;

            const mp3Name = uniqueOutputName(toMp3Filename(entry.outputName), takenNames);

            const label = wavEntries.length > 1
                ? `(${wavIndex}/${wavEntries.length}) ${entry.name}`
                : entry.name;

            try {
                const result = await transcodeEntryToMp3(entry, {
                    bitrate,
                    coverImage,
                    work: job.work,
                    onProgress: (ratio, message) => setProgress(
                        (wavIndex - 1 + ratio) / wavEntries.length,
                        `转码 WAV ${label} — ${message || ''}`
                    )
                });

                outputZip.file(joinZipPath(outputFolder, mp3Name), new Blob([result], {
                    type: 'audio/mpeg'
                }));
            } catch (error) {
                // 转码失败就原样保留，不打断整包处理
                console.error(`WAV 转码失败：${entry.path}`, error);
                warnings.push(`${entry.name}（${error.message}）`);

                outputZip.file(joinZipPath(outputFolder, entry.outputName), await entry.getBlob());
            }

            continue;
        }

        if (entry.kind === 'mp3' && coverImage) {
            try {
                const tagged = await addId3v2Cover(
                    (await entry.getBytes()).buffer,
                    coverImage.base64,
                    coverImage.mime,
                    buildTrackMetadata(job.work, getBaseName(entry.outputName).replace(/\.[^.]+$/, ''))
                );

                outputZip.file(joinZipPath(outputFolder, entry.outputName), new Blob([tagged], {
                    type: 'audio/mpeg'
                }));
            } catch (error) {
                console.error(`写入封面失败：${entry.path}`, error);
                warnings.push(`${entry.name}（${error.message}）`);
                outputZip.file(joinZipPath(outputFolder, entry.outputName), await entry.getBlob());
            }

            continue;
        }

        outputZip.file(joinZipPath(outputFolder, entry.outputName), await entry.getBlob());
    }

    return { warnings };
}

/** 用作品信息补全 ID3 的专辑/艺术家等字段（查不到作品时留空） */
function buildTrackMetadata(work, trackTitle) {
    const metadata = { title: trackTitle };

    if (!work) return metadata;

    metadata.album = work.title || '';
    metadata.artist = (work.voiceBy && work.voiceBy.length ? work.voiceBy.join('、') : '') || work.circle || '';
    metadata.albumArtist = work.circle || '';
    metadata.genre = work.genres && work.genres.length ? work.genres.slice(0, 3).join('/') : '';
    metadata.year = (work.releaseDate || '').slice(0, 4);

    return metadata;
}

async function transcodeEntryToMp3(entry, options) {
    const arrayBuffer = (await entry.getBytes()).buffer;
    const result = await WavToMp3.wavToMp3(arrayBuffer, {
        bitrate: options.bitrate,
        onProgress: options.onProgress
    });

    let outputBuffer = result.data.buffer;

    if (options.coverImage) {
        outputBuffer = await addId3v2Cover(
            outputBuffer,
            options.coverImage.base64,
            options.coverImage.mime,
            buildTrackMetadata(options.work, entry.name.replace(/\.[^.]+$/, ''))
        );
    }

    return outputBuffer;
}

function uniqueOutputName(candidate, takenNames) {
    const name = takenNames.has(candidate)
        ? addNumberSuffixUntilUnique(candidate, takenNames)
        : candidate;

    takenNames.add(name);

    return name;
}

function getDownloadName(job) {
    let downloadName = `converted_lrc_${Date.now()}.zip`;

    if (job.sourceKind === 'zip' && job.zipName) {
        const baseName = job.zipName.replace(/\.zip$/i, '');
        downloadName = `${baseName}_after.zip`;
    } else if (job.sourceKind === 'folder' && job.folderRootName) {
        downloadName = `${job.folderRootName}_after.zip`;
    } else if (job.sourceKind === 'direct' && job.zipName) {
        const baseName = job.zipName.replace(/\.vtt$/i, '');
        downloadName = `${baseName}等等.zip`;
    }

    return downloadName;
}

function downloadBlob(blob, filename) {
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');

    a.href = downloadUrl;
    a.download = filename;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    URL.revokeObjectURL(downloadUrl);
}

// --- 目标二：写回原文件夹 ---

/** 读一遍目录里已经存在的文件（只读元信息，不读内容），用于区分"新增"和"覆盖" */
async function indexExistingPaths(handle, relativePaths) {
    const distinct = [...new Set(relativePaths)];
    const existing = new Set();
    const directoryCache = new Map();

    async function childNames(relativeDir) {
        if (directoryCache.has(relativeDir)) return directoryCache.get(relativeDir);

        let directory = handle;

        if (relativeDir) {
            try {
                directory = await handle.getDirectoryHandle(relativeDir);
            } catch {
                const empty = new Set();

                directoryCache.set(relativeDir, empty);
                return empty;
            }
        }

        const names = await listChildNames(directory);

        directoryCache.set(relativeDir, names);

        return names;
    }

    for (const relative of distinct) {
        const parts = relative.split('/').filter(Boolean);

        if (parts.length === 0) continue;

        const fileName = parts.pop();
        const names = await childNames(parts.join('/'));

        if (names.has(fileName)) existing.add(relative);
    }

    return existing;
}

async function listChildNames(directoryHandle) {
    const names = new Set();

    try {
        for await (const child of directoryHandle.values()) {
            names.add(child.name);
        }
    } catch {
        // 列不出来就当空目录
    }

    return names;
}

/**
 * 先把要做的每一件事算清楚（写什么、覆盖谁、删什么），
 * 再去执行。规划与执行严格分开，确认弹窗里显示的清单就是真正会发生的操作。
 */
async function planFolderWrites(entries, job) {
    const targets = [];
    const skipped = [];
    const plan = { writes: [], newFiles: [], overwrites: [], deletes: [], skipped };

    for (const entry of entries) {
        const outputName = entry.outputName;

        if (entry.kind === 'vtt') {
            targets.push({
                relPath: getLrcFilename(outputName),
                source: entry,
                typeLabel: 'LRC',
                build: async () => convertVttToLrc(await entry.getText()),
                // 勾了"剪掉源文件"就顺手删掉 VTT——和 ZIP 模式的输出一致（输出包里不会有 VTT）
                deleteSource: job.shouldDeleteSource ? entry.relPath : null
            });

            continue;
        }

        if (entry.kind === 'wav' && job.shouldTranscodeWav) {
            targets.push({
                relPath: toMp3Filename(outputName),
                source: entry,
                typeLabel: 'MP3',
                build: async () => transcodeEntryToMp3(entry, {
                    bitrate: job.bitrate,
                    coverImage: job.coverImage,
                    work: job.work,
                    onProgress: (ratio, message) => setProgress(
                        0.05 + ratio * 0.9,
                        `转码 WAV ${entry.name} — ${message || ''}`
                    )
                }),
                deleteSource: job.shouldDeleteSource ? entry.relPath : null
            });

            continue;
        }

        if (entry.kind === 'mp3' && job.coverImage) {
            targets.push({
                relPath: outputName,
                source: entry,
                typeLabel: 'MP3 封面',
                build: async () => addId3v2Cover(
                    (await entry.getBytes()).buffer,
                    job.coverImage.base64,
                    job.coverImage.mime,
                    buildTrackMetadata(job.work, entry.name.replace(/\.[^.]+$/, ''))
                ),
                deleteSource: null
            });
        }

        // 图片和其它文件一律不动
    }

    // 同名目标只处理一次，例如「歌曲.wav」（转码成 歌曲.mp3）撞上本来就有的「歌曲.mp3」
    const claimed = new Map();

    for (const target of targets) {
        const owner = claimed.get(target.relPath);

        if (owner) {
            skipped.push({
                relPath: target.relPath,
                reason: `与 ${owner.source.relPath} 的输出重名，已跳过「${target.source.relPath}」`
            });

            continue;
        }

        claimed.set(target.relPath, target);
        plan.writes.push(target);
    }

    const existing = await indexExistingPaths(job.directoryHandle, plan.writes.map(target => target.relPath));
    const deletionSet = new Set();

    plan.writes.forEach(target => {
        if (existing.has(target.relPath)) {
            plan.overwrites.push(target.relPath);
        } else {
            plan.newFiles.push(target.relPath);
        }

        if (target.deleteSource && target.deleteSource !== target.relPath) {
            // 去重：平铺时两个不同作品可能压到同一个输出名，但源文件只会被登记一次
            deletionSet.add(target.deleteSource);
        }
    });

    plan.deletes = [...deletionSet];

    return plan;
}

function buildWritebackSummary(plan, handle) {
    const blocks = [];
    const maxItems = 12;

    function block(title, items, className, hint) {
        if (items.length === 0) return;

        const shown = items.slice(0, maxItems);
        const rest = items.length - shown.length;
        const listItems = shown
            .map(item => `<li>${escapeHtml(typeof item === 'string' ? item : item.relPath)}</li>`)
            .join('');

        blocks.push(`
            <div class="writeback-heading ${className}">${title}（${items.length}）${hint ? ` <span class="font-normal">${hint}</span>` : ''}</div>
            <ul class="writeback-list">${listItems}${rest > 0 ? `<li>…还有 ${rest} 个</li>` : ''}</ul>
        `);
    }

    block('新增文件', plan.newFiles, 'is-new');
    block('覆盖原文件', plan.overwrites, 'is-overwrite', '（原内容会被替换）');
    block('删除源文件', plan.deletes, 'is-delete', '（转码成功后执行，不可撤销）');
    block('跳过', plan.skipped.map(item => `${item.relPath} ← ${item.reason}`), 'is-skip');

    const totalBytes = plan.writes
        .map(target => target.source.size)
        .filter(size => size > 0)
        .reduce((sum, size) => sum + size, 0);

    blocks.push(`
        <p class="text-xs text-gray-500 mt-3">
            目标文件夹：<span class="path-badge">${escapeHtml(handle.name || '')}</span>
            ${totalBytes > 0 ? ` · 读取约 ${escapeHtml(formatBytes(totalBytes))}` : ''}
        </p>
    `);

    return blocks.join('');
}

function openWritebackModal(plan, handle, job) {
    writebackTitle.textContent = '确认写回原文件夹';

    const mode = job.shouldFlatten ? '平铺到根目录' : '保持原有目录结构';
    const hint = buildFlattenHint(job);

    writebackTarget.textContent =
        `「${handle.name || '所选文件夹'}」 · ${mode} · 共 ${plan.writes.length} 个文件将被写入`;

    writebackSummary.innerHTML =
        (hint ? `<p class="text-xs text-amber-600 mb-3">${escapeHtml(hint)}</p>` : '') +
        buildWritebackSummary(plan, handle);

    writebackModal.classList.remove('hidden');

    return new Promise(resolve => {
        modalResolver = resolve;
    });
}

function resolveWritebackConfirm(confirmed) {
    if (!modalResolver) return;

    const resolve = modalResolver;

    modalResolver = null;
    writebackModal.classList.add('hidden');
    resolve(confirmed);
}

function closeWritebackModal() {
    writebackModal.classList.add('hidden');
    modalResolver = null;
}

/** 写回：逐项转码 → 写入 → 最后删源文件（失败的原样保留） */
async function executeFolderPlan(plan, job) {
    const handle = job.directoryHandle;
    const warnings = [];
    const failedDeletes = [];
    let writtenCount = 0;
    let unchangedCount = 0;

    for (let index = 0; index < plan.writes.length; index++) {
        const target = plan.writes[index];
        const label = `(${index + 1}/${plan.writes.length}) ${target.relPath}`;

        try {
            setProgress(index / plan.writes.length, `写入 ${label}`);

            const data = await target.build();

            // 内容一模一样就别写：既省时间，也不动文件时间戳
            if (target.relPath !== target.source.relPath) {
                const existingDigest = await readExistingDigest(handle, target.relPath);

                if (existingDigest && existingDigest === computeDigest(toBytes(data))) {
                    unchangedCount++;
                    continue;
                }
            }

            await FolderFs.writeFile(handle, target.relPath, data);
            writtenCount++;
        } catch (error) {
            console.error(`写回失败：${target.relPath}`, error);
            warnings.push(`${target.relPath}（${error.message}）`);
        }
    }

    for (const relPath of plan.deletes) {
        try {
            setProgress(0.99, `删除源文件 ${relPath}`);
            await FolderFs.deleteFile(handle, relPath);
        } catch (error) {
            console.error(`删除失败：${relPath}`, error);
            failedDeletes.push(`${relPath}（${error.message}）`);
        }
    }

    return { writtenCount, unchangedCount, warnings, failedDeletes };
}

function readExistingDigest(handle, relPath) {
    return FolderFs.readFile(handle, relPath)
        .then(bytes => computeDigest(bytes))
        .catch(() => null);
}

function toBytes(data) {
    return FolderFs.toBytes(data);
}

async function processFolderWriteBack(job) {
    const entries = await buildVirtualEntries(job);

    resolveOutputNames(entries, job);

    setProgress(0.01, '正在核对目标文件夹…');

    const plan = await planFolderWrites(entries, job);

    if (plan.writes.length === 0) {
        showStatusMessage(plan.skipped.length
            ? `没有可写回的文件：${plan.skipped.map(item => `${item.relPath}（${item.reason}）`).join('；')}`
            : '没有需要写回的文件。');
        return;
    }

    hideProgress();

    const confirmed = await openWritebackModal(plan, job.directoryHandle, job);

    if (!confirmed) {
        showStatusMessage('已取消写回，原文件夹没有被改动。', false);
        return;
    }

    const result = await executeFolderPlan(plan, job);
    const parts = [`已写入 ${result.writtenCount} 个文件`];

    if (result.unchangedCount) parts.push(`${result.unchangedCount} 个内容相同已跳过`);
    if (plan.deletes.length) parts.push(`删除了 ${plan.deletes.length - result.failedDeletes.length} 个源文件`);
    if (plan.skipped.length) parts.push(`跳过 ${plan.skipped.length} 个重名输出`);

    const problems = result.warnings.concat(result.failedDeletes);

    if (problems.length) {
        showStatusMessage(`${parts.join('，')}；但有 ${problems.length} 项失败：${problems.join('；')}`);
    } else {
        showStatusMessage(`${parts.join('，')}。已写回「${job.directoryHandle.name || ''}」。`, false);
    }
}
