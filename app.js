// DOM 元素
const tabDirect = document.getElementById('tab-direct');
const tabZip = document.getElementById('tab-zip');
const tabAudio = document.getElementById('tab-audio');
const panelDirect = document.getElementById('panel-direct');
const panelZip = document.getElementById('panel-zip');
const panelAudio = document.getElementById('panel-audio');
const dropZones = document.querySelectorAll('.drop-zone');
const fileInputDirect = document.getElementById('file-input-direct');
const fileInputZip = document.getElementById('file-input-zip');
const fileInputAudio = document.getElementById('file-input-audio');
const fileInputCover = document.getElementById('file-input-cover');
const coverFileName = document.getElementById('cover-file-name');
const fileListContainer = document.getElementById('file-list-container');
const fileListTitle = document.getElementById('file-list-title');
const fileList = document.getElementById('file-list');
const actionButtons = document.getElementById('action-buttons');
const convertBtn = document.getElementById('convert-btn');
const clearBtn = document.getElementById('clear-btn');
const btnText = document.getElementById('btn-text');
const spinner = document.getElementById('spinner');
const statusMessage = document.getElementById('status-message');
const flattenOption = document.getElementById('flatten-option');
const flattenCheckbox = document.getElementById('flatten-checkbox');
const imagePreviewContainer = document.getElementById('image-preview-container');
const imagePreviewGrid = document.getElementById('image-preview-grid');
const audioOptions = document.getElementById('audio-options');
const transcodeOption = document.getElementById('transcode-option');
const transcodeWavCheckbox = document.getElementById('transcode-wav-checkbox');
const lameStatus = document.getElementById('lame-status');
const progressContainer = document.getElementById('progress-container');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');

// 状态
let filesToProcess = []; // 统一存储待处理文件 { name, getContent }
let audioFilesToProcess = []; // 待转码的 WAV File 对象
let audioFileStatusNodes = []; // 文件列表里每行的状态节点
let loadedZip = null; // 存储上传的 ZIP 对象
let originalInputName = null; // 存储原始输入文件名
let zipImages = []; // { name, mime, base64 }
let selectedCoverImage = null; // { mime, base64 } 或 null
let currentTab = 'direct'; // direct | zip | audio
let zipHasMp3 = false; // 包内是否有 MP3（用于文件列表提示）
let zipWavCount = 0; // 包内 WAV 数量

// 固定 320 kbps：WAV 是无损 PCM，等效码率（CD 音质约 1411 kbps）远高于 320，
// 没有"源码率"可继承，所以一律按 320 kbps 编码；只有采样率过低时
// （16~24 kHz 上限 160 kbps，≤12 kHz 上限 64 kbps）才会自动降到上限。
const MP3_BITRATE = 320;

const TAB_ELEMENTS = {
    direct: { tab: tabDirect, panel: panelDirect },
    zip: { tab: tabZip, panel: panelZip },
    audio: { tab: tabAudio, panel: panelAudio }
};

// --- 事件监听 ---

tabDirect.addEventListener('click', () => switchTab('direct'));
tabZip.addEventListener('click', () => switchTab('zip'));
tabAudio.addEventListener('click', () => switchTab('audio'));

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

        if (panel && panel.id === 'panel-audio') {
            handleAudioFiles(files);
        } else if (panel && panel.id === 'panel-zip') {
            if (files.length) handleZipFile(files[0]);
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

fileInputAudio.addEventListener('change', e => {
    handleAudioFiles(e.target.files);
});

fileInputCover.addEventListener('change', e => {
    if (e.target.files.length) handleCoverFile(e.target.files[0]);
});

transcodeWavCheckbox.addEventListener('change', refreshZipFileList);

convertBtn.addEventListener('click', convertAndDownload);
clearBtn.addEventListener('click', clearFiles);

updateLameStatus();

// --- 基础工具函数 ---

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

/**
 * 把 ZIP 条目名里的反斜杠统一成斜杠。
 *
 * Windows 资源管理器 / Compress-Archive 打包时用反斜杠存路径
 * （音声压缩包基本都是这么来的），而反斜杠在 zip 规范里并不是分隔符，
 * 不处理的话输出包会出现 "作品集\第一話\01.mp3" 这种带反斜杠的怪文件名，
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

// --- 编码库状态 ---

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

// --- 页面状态 ---

function switchTab(tabName) {
    currentTab = tabName;

    Object.keys(TAB_ELEMENTS).forEach(name => {
        const isActive = name === tabName;
        const elements = TAB_ELEMENTS[name];

        elements.tab.classList.toggle('active', isActive);
        elements.tab.classList.toggle('text-gray-500', !isActive);
        elements.tab.classList.toggle('hover:text-gray-700', !isActive);
        elements.panel.classList.toggle('active', isActive);
    });

    flattenOption.classList.toggle('hidden', tabName !== 'zip');
    audioOptions.classList.toggle('hidden', tabName === 'direct');
    transcodeOption.classList.toggle('hidden', tabName !== 'zip');

    clearFiles();
    updateActionButtonText();
}

function updateActionButtonText() {
    if (currentTab === 'audio') {
        btnText.textContent = audioFilesToProcess.length > 1 ? '转码并下载 ZIP' : '转码并下载 MP3';
        return;
    }

    btnText.textContent = '转换并下载 ZIP';
}

function clearFiles() {
    filesToProcess = [];
    audioFilesToProcess = [];
    audioFileStatusNodes = [];
    loadedZip = null;
    originalInputName = null;
    zipImages = [];
    selectedCoverImage = null;
    zipHasMp3 = false;
    zipWavCount = 0;

    imagePreviewGrid.innerHTML = '';
    imagePreviewContainer.classList.add('hidden');

    fileInputDirect.value = '';
    fileInputZip.value = '';
    fileInputAudio.value = '';
    fileInputCover.value = '';
    coverFileName.textContent = '';

    fileList.innerHTML = '';
    fileListTitle.textContent = '待处理 VTT 文件';
    fileListContainer.classList.add('hidden');
    actionButtons.classList.add('hidden');

    hideProgress();
    showStatusMessage('');
    setButtonLoading(false);
    updateActionButtonText();
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

// --- 文件处理 ---

function handleDirectFiles(inputFileList) {
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

    updateFileListUI();
}

async function handleZipFile(zipFile) {
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
    } catch (error) {
        console.error('解压文件时出错:', error);
        showStatusMessage('无法读取此 ZIP 文件，可能已损坏。');
        loadedZip = null;
    }
}

// --- WAV 文件处理（音频转码模式）---

function handleAudioFiles(inputFileList) {
    // 先选封面、再选音频时，封面不应该被清掉
    const previousImages = zipImages;
    const previousCover = selectedCoverImage;

    // 同样先快照：clearFiles() 会把 input.value 置空，FileList 会跟着变空
    const selectedFiles = Array.from(inputFileList);

    // 直接丢进来一个音声压缩包：转到 ZIP 流程，并默认勾选 WAV 转码
    const zipFile = selectedFiles.find(file => isZipFile(file));

    if (zipFile) {
        transcodeWavCheckbox.checked = true;
        switchTab('zip');
        handleZipFile(zipFile);
        return;
    }

    clearFiles();

    const wavFiles = selectedFiles.filter(file => isWavFile(file.name));

    if (wavFiles.length === 0) {
        showStatusMessage('请选择 .wav 文件。');
        return;
    }

    originalInputName = wavFiles[0].name;
    audioFilesToProcess = wavFiles;

    if (previousCover) {
        zipImages = previousImages;
        selectedCoverImage = previousCover;
        coverFileName.textContent = previousCover.name || '';
        renderImageGrid();
    }

    renderAudioFileList();
    updateActionButtonText();
    showStatusMessage('');
}

async function handleCoverFile(file) {
    if (!file.type.startsWith('image/')) {
        showStatusMessage('封面必须是图片文件。');
        return;
    }

    try {
        const base64 = await blobToBase64(file);
        const image = {
            name: file.name,
            mime: file.type || 'image/jpeg',
            base64
        };

        zipImages = [image];
        selectedCoverImage = {
            name: image.name,
            mime: image.mime,
            base64: image.base64
        };
        coverFileName.textContent = file.name;

        renderImageGrid();
        showStatusMessage('');
    } catch (error) {
        console.error('读取封面图片失败:', error);
        showStatusMessage('读取封面图片失败。');
    }
}

function renderAudioFileList() {
    fileList.innerHTML = '';
    audioFileStatusNodes = [];

    audioFilesToProcess.forEach(file => {
        const li = document.createElement('li');
        li.className = 'list-item flex items-center justify-between bg-gray-50 p-3 rounded-lg';

        const safeName = escapeHtml(file.name);

        li.innerHTML = `
            <span class="text-sm font-medium text-gray-700 truncate" title="${safeName}">${safeName}</span>
            <span class="text-sm text-gray-400 shrink-0 ml-2" data-role="status">${WavToMp3.formatBytes(file.size)}</span>
        `;

        fileList.appendChild(li);
        audioFileStatusNodes.push(li.querySelector('[data-role="status"]'));
    });

    fileListTitle.textContent = '待转码 WAV 文件';
    fileListContainer.classList.remove('hidden');
    actionButtons.classList.remove('hidden');
}

function setAudioFileStatus(index, text, tone = 'muted') {
    const node = audioFileStatusNodes[index];

    if (!node) return;

    const colors = {
        muted: 'text-gray-400',
        done: 'text-green-600',
        error: 'text-red-500'
    };

    node.textContent = text;
    node.className = `text-sm shrink-0 ml-2 ${colors[tone] || colors.muted}`;
}

function updateFileListUI(hasMp3 = false, wavCount = 0) {
    zipHasMp3 = hasMp3;
    zipWavCount = wavCount;

    const willTranscode = wavCount > 0 && transcodeWavCheckbox.checked;
    const hasWork = filesToProcess.length > 0 || hasMp3 || willTranscode;

    if (!hasWork) {
        showStatusMessage('在上传的文件中未找到任何 .vtt、.mp3 或 .wav 文件。');
        fileListContainer.classList.add('hidden');
        actionButtons.classList.add('hidden');
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

    renderZipWavNote();

    fileListContainer.classList.remove('hidden');
    actionButtons.classList.remove('hidden');
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

    updateFileListUI(zipHasMp3, zipWavCount);
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

    imagePreviewContainer.classList.remove('hidden');
}

function selectCoverImage(index) {
    const wrappers = imagePreviewGrid.querySelectorAll('.image-thumb-wrapper');

    if (selectedCoverImage && selectedCoverImage.base64 === zipImages[index].base64) {
        selectedCoverImage = null;
        wrappers[index].classList.remove('selected');
        return;
    }

    wrappers.forEach(wrapper => wrapper.classList.remove('selected'));
    wrappers[index].classList.add('selected');

    selectedCoverImage = {
        name: zipImages[index].name,
        mime: zipImages[index].mime,
        base64: zipImages[index].base64
    };
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

function removeApicFramesFromId3v23(frameData) {
    const keptFrames = [];
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

        if (frameId !== 'APIC') {
            keptFrames.push(frameData.slice(offset, offset + frameTotalSize));
        }

        offset += frameTotalSize;
    }

    return concatUint8Arrays(keptFrames);
}

function createTextFrameV23(frameId, text) {
    const textBytes = new TextEncoder().encode(String(text || ''));
    const frameContent = new Uint8Array(1 + textBytes.length);

    frameContent[0] = 0x03; // UTF-8。虽然 ID3v2.3 标准里更常见 UTF-16，但多数现代播放器能识别
    frameContent.set(textBytes, 1);

    return createFrameV23(frameId, frameContent);
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

// --- ID3v2 封面写入 ---
// 重点改进：
// 1. 写入前把封面压缩成 800x800 JPEG
// 2. 对 ID3v2.3 文件尽量保留原标签，只替换 APIC
// 3. 非 ID3v2.3 或无标签时，写入一个新的 ID3v2.3 标签

async function addId3v2Cover(mp3ArrayBuffer, imageBase64, imageMime, metadata = {}) {
    const normalizedCover = await normalizeCoverImage(imageBase64, imageMime, {
        maxSize: 800,
        quality: 0.85
    });

    const imageBytes = base64ToUint8Array(normalizedCover.base64);
    const mp3Bytes = new Uint8Array(mp3ArrayBuffer);
    const parsed = parseId3v2(mp3Bytes);
    const audioBytes = mp3Bytes.slice(parsed.audioStart);

    const apicFrame = createApicFrameV23(imageBytes, normalizedCover.mime);

    let frames = [];

    if (parsed.hasTag && parsed.majorVersion === 3) {
        // 保留原 ID3v2.3 的非 APIC 帧，只替换封面
        const keptFrameData = removeApicFramesFromId3v23(parsed.frameData);

        frames.push(keptFrameData);

        // 如原标签里完全缺少基础信息，可按文件名补一个标题
        if (metadata.title) {
            // 为了避免重复 TIT2，这里不强行补写。
            // 需要强制补标题时，可以在这里添加 createTextFrameV23('TIT2', metadata.title)
        }

        frames.push(apicFrame);
    } else {
        // 没有 ID3v2 标签，或版本不是 v2.3：新建一个兼容性较好的 ID3v2.3 标签
        if (metadata.title) {
            frames.push(createTextFrameV23('TIT2', metadata.title));
        }

        frames.push(apicFrame);
    }

    const id3Tag = createId3v23Tag(frames);
    const result = new Uint8Array(id3Tag.length + audioBytes.length);

    result.set(id3Tag, 0);
    result.set(audioBytes, id3Tag.length);

    return result.buffer;
}

// --- ZIP 输出辅助 ---

function getOutputFolderNameFromZip(zip) {
    let fallback = '';

    if (originalInputName) {
        fallback = originalInputName.replace(/\.zip$/i, '');
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

// --- 转换与下载 ---

async function convertAndDownload() {
    if (currentTab === 'audio') {
        if (audioFilesToProcess.length === 0) return;

        await convertAudioFiles();
        return;
    }

    if (filesToProcess.length === 0 && !loadedZip) return;

    setButtonLoading(true);
    showStatusMessage('');

    try {
        const outputZip = new JSZip();

        const result = loadedZip
            ? await processZipMode(outputZip)
            : await processDirectVttMode(outputZip);

        const zipBlob = await outputZip.generateAsync({
            type: 'blob'
        });

        downloadBlob(zipBlob, getDownloadName());

        const warnings = (result && result.warnings) || [];

        if (warnings.length > 0) {
            showStatusMessage(`处理完成，但有以下文件未能转码：${warnings.join('；')}`);
        } else {
            showStatusMessage('处理完成。', false);
        }
    } catch (error) {
        console.error('转换或下载过程中发生错误:', error);
        showStatusMessage(`处理失败：${error.message || '请在控制台查看错误信息。'}`);
    } finally {
        setButtonLoading(false);
        hideProgress();
    }
}

// --- WAV 转 MP3 ---

async function convertAudioFiles() {
    setButtonLoading(true);
    showStatusMessage('');
    setProgress(0, '准备转码…');

    const startedAt = Date.now();

    try {
        const result = await processAudioMode();
        const outputs = result.outputs;
        const failures = result.failures;
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

        if (outputs.length === 0) {
            throw new Error(failures.join('；') || '没有可用的输出。');
        }

        if (outputs.length === 1) {
            downloadBlob(new Blob([outputs[0].buffer], {
                type: 'audio/mpeg'
            }), outputs[0].name);
        } else {
            const outputZip = new JSZip();
            const usedNames = new Set();

            outputs.forEach(output => {
                const name = usedNames.has(output.name)
                    ? addNumberSuffixUntilUnique(output.name, usedNames)
                    : output.name;

                usedNames.add(name);
                outputZip.file(name, new Blob([output.buffer], {
                    type: 'audio/mpeg'
                }));
            });

            const zipBlob = await outputZip.generateAsync({
                type: 'blob'
            });

            downloadBlob(zipBlob, getAudioDownloadName(outputs.length));
        }

        if (failures.length > 0) {
            showStatusMessage(`完成 ${outputs.length} 个，失败 ${failures.length} 个：${failures.join('；')}`);
        } else {
            setProgress(1, `全部完成，用时 ${elapsed} 秒`);
            showStatusMessage('');
        }
    } catch (error) {
        console.error('WAV 转 MP3 失败:', error);
        showStatusMessage(`转码失败：${error.message || '请在控制台查看错误信息。'}`);
        hideProgress();
    } finally {
        setButtonLoading(false);
    }
}

async function processAudioMode() {
    const bitrate = MP3_BITRATE;
    const total = audioFilesToProcess.length;
    const outputs = [];
    const failures = [];

    for (let index = 0; index < total; index++) {
        const file = audioFilesToProcess[index];
        const label = total > 1 ? `(${index + 1}/${total}) ${file.name}` : file.name;

        setAudioFileStatus(index, '转码中…');

        try {
            const arrayBuffer = await file.arrayBuffer();

            const result = await WavToMp3.wavToMp3(arrayBuffer, {
                bitrate,
                onProgress: (ratio, message) => setProgress((index + ratio) / total, `${label} — ${message || ''}`)
            });

            let outputBuffer = result.data.buffer;

            if (selectedCoverImage) {
                setProgress((index + 0.98) / total, `${label} — 正在写入封面…`);

                outputBuffer = await addId3v2Cover(
                    outputBuffer,
                    selectedCoverImage.base64,
                    selectedCoverImage.mime,
                    {
                        title: file.name.replace(/\.wav$/i, '')
                    }
                );
            }

            outputs.push({
                name: toMp3Filename(file.name),
                buffer: outputBuffer,
                result
            });

            const limitedNote = result.bitrateLimited
                ? `（源采样率 ${result.sampleRate} Hz，上限 ${result.bitrate} kbps）`
                : '';

            setAudioFileStatus(
                index,
                `完成 · ${result.bitrate} kbps · ${WavToMp3.formatBytes(outputBuffer.byteLength)}${limitedNote}`,
                'done'
            );
        } catch (error) {
            // 单个文件坏掉不应该影响整批
            console.error(`转码失败：${file.name}`, error);
            failures.push(`${file.name}：${error.message}`);
            setAudioFileStatus(index, `失败：${error.message}`, 'error');
        }
    }

    return { outputs, failures };
}

function getAudioDownloadName(count) {
    const baseName = originalInputName ? originalInputName.replace(/\.wav$/i, '') : 'audio';

    return `${baseName}等${count}个_mp3.zip`;
}

// --- ZIP 模式内的 WAV 转码 ---

function countZipWavFiles() {
    let count = 0;

    for (const filename in loadedZip.files) {
        if (!loadedZip.files[filename].dir && isWavFile(filename)) {
            count++;
        }
    }

    return count;
}

function uniqueOutputName(candidate, takenNames) {
    const name = takenNames.has(candidate)
        ? addNumberSuffixUntilUnique(candidate, takenNames)
        : candidate;

    takenNames.add(name);

    return name;
}

async function processZipMode(outputZip) {
    const shouldFlatten = flattenCheckbox.checked;
    const shouldTranscodeWav = transcodeWavCheckbox.checked;
    const bitrate = MP3_BITRATE;
    const existingNames = new Set();
    const outputFolder = getOutputFolderNameFromZip(loadedZip);

    // 非平铺模式保留原始路径，先把所有原始文件名登记下来，
    // 免得转码出来的 MP3 覆盖掉包内同名的 MP3
    const reservedNames = new Set();

    if (!shouldFlatten) {
        for (const filename in loadedZip.files) {
            if (!loadedZip.files[filename].dir) {
                reservedNames.add(filename);
            }
        }
    }

    const wavCount = shouldTranscodeWav ? countZipWavFiles() : 0;
    const warnings = [];
    let wavIndex = 0;

    for (const filename in loadedZip.files) {
        const zipEntry = loadedZip.files[filename];
        if (zipEntry.dir) continue;

        const newName = shouldFlatten
            ? createFlattenedName(filename, existingNames)
            : filename;

        if (isVttFile(filename)) {
            const vttContent = await zipEntry.async('string');
            const lrcContent = convertVttToLrc(vttContent);
            const lrcFilename = shouldFlatten
                ? getLrcFilename(newName)
                : getLrcFilename(filename);

            outputZip.file(joinZipPath(outputFolder, lrcFilename), lrcContent);
            continue;
        }

        if (isWavFile(filename) && shouldTranscodeWav) {
            wavIndex++;

            const mp3Name = uniqueOutputName(
                toMp3Filename(newName),
                shouldFlatten ? existingNames : reservedNames
            );

            const label = wavCount > 1
                ? `(${wavIndex}/${wavCount}) ${getBaseName(filename)}`
                : getBaseName(filename);

            try {
                const arrayBuffer = await zipEntry.async('arraybuffer');

                const result = await WavToMp3.wavToMp3(arrayBuffer, {
                    bitrate,
                    onProgress: (ratio, message) => setProgress(
                        (wavIndex - 1 + ratio) / wavCount,
                        `转码 WAV ${label} — ${message || ''}`
                    )
                });

                let outputBuffer = result.data.buffer;

                if (selectedCoverImage) {
                    setProgress((wavIndex - 0.02) / wavCount, `转码 WAV ${label} — 正在写入封面…`);

                    outputBuffer = await addId3v2Cover(
                        outputBuffer,
                        selectedCoverImage.base64,
                        selectedCoverImage.mime,
                        {
                            title: getBaseName(filename).replace(/\.[^.]+$/, '')
                        }
                    );
                }

                outputZip.file(joinZipPath(outputFolder, mp3Name), new Blob([outputBuffer], {
                    type: 'audio/mpeg'
                }));
            } catch (error) {
                // 转码失败就原样保留，不打断整包处理
                console.error(`WAV 转码失败：${filename}`, error);
                warnings.push(`${getBaseName(filename)}（${error.message}）`);

                const fileContent = await zipEntry.async('blob');

                outputZip.file(joinZipPath(outputFolder, newName), fileContent);
            }

            continue;
        }

        if (isMp3File(filename) && selectedCoverImage) {
            const arrayBuffer = await zipEntry.async('arraybuffer');

            const metadata = {
                title: getBaseName(newName).replace(/\.[^.]+$/, '')
            };

            const taggedBuffer = await addId3v2Cover(
                arrayBuffer,
                selectedCoverImage.base64,
                selectedCoverImage.mime,
                metadata
            );

            outputZip.file(
                joinZipPath(outputFolder, newName),
                new Blob([taggedBuffer], {
                    type: 'audio/mpeg'
                })
            );

            continue;
        }

        const fileContent = await zipEntry.async('blob');
        outputZip.file(joinZipPath(outputFolder, newName), fileContent);
    }

    return { warnings };
}

async function processDirectVttMode(outputZip) {
    for (const file of filesToProcess) {
        const vttContent = await file.getContent();
        const lrcContent = convertVttToLrc(vttContent);
        const lrcFilename = getLrcFilename(file.name);

        outputZip.file(lrcFilename, lrcContent);
    }
}

function getDownloadName() {
    let downloadName = `converted_lrc_${Date.now()}.zip`;

    if (loadedZip && originalInputName) {
        const baseName = originalInputName.replace(/\.zip$/i, '');
        downloadName = `${baseName}_after.zip`;
    } else if (!loadedZip && originalInputName) {
        const baseName = originalInputName.replace(/\.vtt$/i, '');
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