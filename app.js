// DOM 元素
const tabDirect = document.getElementById('tab-direct');
const tabZip = document.getElementById('tab-zip');
const panelDirect = document.getElementById('panel-direct');
const panelZip = document.getElementById('panel-zip');
const dropZones = document.querySelectorAll('.drop-zone');
const fileInputDirect = document.getElementById('file-input-direct');
const fileInputZip = document.getElementById('file-input-zip');
const fileListContainer = document.getElementById('file-list-container');
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

// 状态
let filesToProcess = []; // 统一存储待处理文件 { name, getContent }
let loadedZip = null; // 存储上传的 ZIP 对象
let originalInputName = null; // 存储原始输入文件名
let zipImages = []; // { name, mime, base64 }
let selectedCoverImage = null; // { mime, base64 } 或 null

// --- 事件监听 ---

tabDirect.addEventListener('click', () => switchTab('direct'));
tabZip.addEventListener('click', () => switchTab('zip'));

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
        if (zone.parentElement.id === 'panel-direct') {
            handleDirectFiles(files);
        } else {
            if (files.length) handleZipFile(files[0]);
        }
    });
});

fileInputDirect.addEventListener('change', e => {
    handleDirectFiles(e.target.files);
});

fileInputZip.addEventListener('change', e => {
    if (e.target.files.length) handleZipFile(e.target.files[0]);
});

convertBtn.addEventListener('click', convertAndDownload);
clearBtn.addEventListener('click', clearFiles);

// --- 基础工具函数 ---

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function showStatusMessage(message) {
    statusMessage.textContent = message;
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

function isZipFile(file) {
    if (!file) return false;
    return file.type.includes('zip') || /\.zip$/i.test(file.name);
}

// --- 页面状态 ---

function switchTab(tabName) {
    if (tabName === 'direct') {
        tabDirect.classList.add('active');
        tabZip.classList.remove('active');
        panelDirect.classList.add('active');
        panelZip.classList.remove('active');
        flattenOption.classList.add('hidden');
    } else {
        tabDirect.classList.remove('active');
        tabZip.classList.add('active');
        panelDirect.classList.remove('active');
        panelZip.classList.add('active');
        flattenOption.classList.remove('hidden');
    }

    clearFiles();
}

function clearFiles() {
    filesToProcess = [];
    loadedZip = null;
    originalInputName = null;
    zipImages = [];
    selectedCoverImage = null;

    imagePreviewGrid.innerHTML = '';
    imagePreviewContainer.classList.add('hidden');

    fileInputDirect.value = '';
    fileInputZip.value = '';

    fileList.innerHTML = '';
    fileListContainer.classList.add('hidden');
    actionButtons.classList.add('hidden');

    showStatusMessage('');
    setButtonLoading(false);
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
    clearFiles();

    const vttFiles = Array.from(inputFileList).filter(file => isVttFile(file.name));

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

        const vttZipEntries = [];
        let hasMp3 = false;

        for (const filename in loadedZip.files) {
            const entry = loadedZip.files[filename];
            if (entry.dir) continue;

            if (isVttFile(filename)) {
                vttZipEntries.push(entry);
            }

            if (isMp3File(filename)) {
                hasMp3 = true;
            }
        }

        filesToProcess = vttZipEntries.map(entry => ({
            name: entry.name,
            getContent: () => entry.async('string')
        }));

        updateFileListUI(hasMp3);
        await extractAndDisplayImages();
    } catch (error) {
        console.error('解压文件时出错:', error);
        showStatusMessage('无法读取此 ZIP 文件，可能已损坏。');
        loadedZip = null;
    }
}

function updateFileListUI(hasMp3 = false) {
    if (filesToProcess.length === 0) {
        if (hasMp3) {
            showStatusMessage('');
            fileList.innerHTML = '<li class="text-sm text-gray-500 p-3">未找到 VTT 文件，将仅处理 MP3 封面嵌入</li>';
            fileListContainer.classList.remove('hidden');
            actionButtons.classList.remove('hidden');
        } else {
            showStatusMessage('在上传的文件中未找到任何 .vtt 或 .mp3 文件。');
            fileListContainer.classList.add('hidden');
            actionButtons.classList.add('hidden');
        }
        return;
    }

    fileList.innerHTML = '';

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

    fileListContainer.classList.remove('hidden');
    actionButtons.classList.remove('hidden');
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

    const isMusicOrSubtitle = /\.(mp3|wav|lrc|ogg|flac|aac|m4a)$/i.test(baseName);

    let newName = baseName;

    if (existingNames.has(newName)) {
        if (isMusicOrSubtitle && hasPath) {
            newName = baseName.replace(/\.[^.]+$/, `_${pathStr}$&`);
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
    if (filesToProcess.length === 0 && !loadedZip) return;

    setButtonLoading(true);
    showStatusMessage('');

    try {
        const outputZip = new JSZip();

        if (loadedZip) {
            await processZipMode(outputZip);
        } else {
            await processDirectVttMode(outputZip);
        }

        const zipBlob = await outputZip.generateAsync({
            type: 'blob'
        });

        downloadBlob(zipBlob, getDownloadName());
        showStatusMessage('处理完成。');
    } catch (error) {
        console.error('转换或下载过程中发生错误:', error);
        showStatusMessage(`处理失败：${error.message || '请在控制台查看错误信息。'}`);
    } finally {
        setButtonLoading(false);
    }
}

async function processZipMode(outputZip) {
    const shouldFlatten = flattenCheckbox.checked;
    const existingNames = new Set();
    const outputFolder = getOutputFolderNameFromZip(loadedZip);

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