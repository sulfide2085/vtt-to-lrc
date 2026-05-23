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

// 状态
let filesToProcess = []; // 统一存储待处理文件 { name, getContent }
let loadedZip = null; // 存储上传的 ZIP 对象
let originalInputName = null; // 存储原始输入文件名

// --- 事件监听 ---

// 标签页切换
tabDirect.addEventListener('click', () => switchTab('direct'));
tabZip.addEventListener('click', () => switchTab('zip'));

// 拖拽事件
dropZones.forEach(zone => {
    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('dragover');
    });
    zone.addEventListener('dragleave', (e) => zone.classList.remove('dragover'));
    zone.addEventListener('drop', (e) => {
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

// 文件输入
fileInputDirect.addEventListener('change', (e) => handleDirectFiles(e.target.files));
fileInputZip.addEventListener('change', (e) => {
    if (e.target.files.length) handleZipFile(e.target.files[0]);
});

// 操作按钮
convertBtn.addEventListener('click', convertAndDownload);
clearBtn.addEventListener('click', clearFiles);

// --- 功能函数 ---

function switchTab(tabName) {
    if (tabName === 'direct') {
        tabDirect.classList.add('active');
        tabZip.classList.remove('active');
        panelDirect.classList.add('active');
        panelZip.classList.remove('active');
    } else {
        tabDirect.classList.remove('active');
        tabZip.classList.add('active');
        panelDirect.classList.remove('active');
        panelZip.classList.add('active');
    }
     clearFiles(); // 切换时清空
}

// 处理直接上传的 VTT 文件
function handleDirectFiles(fileList) {
    clearFiles();
    const vttFiles = Array.from(fileList).filter(file => file.name.endsWith('.vtt'));
    if (vttFiles.length === 0) return;

    originalInputName = vttFiles[0].name;

    filesToProcess = vttFiles.map(file => ({
        name: file.name,
        getContent: () => file.text()
    }));
    updateFileListUI();
}

// 处理 ZIP 压缩包
async function handleZipFile(zipFile) {
    if (!zipFile || !(zipFile.type.includes('zip') || zipFile.name.endsWith('.zip'))) {
        showStatusMessage('请上传一个 ZIP 格式的压缩包。');
        return;
    }
    clearFiles();
    originalInputName = zipFile.name;

    try {
        loadedZip = await JSZip.loadAsync(zipFile); // 存储整个 ZIP 对象
        const vttZipEntries = [];
        for (const filename in loadedZip.files) {
            if (filename.endsWith('.vtt') && !loadedZip.files[filename].dir) {
                vttZipEntries.push(loadedZip.files[filename]);
            }
        }
        filesToProcess = vttZipEntries.map(entry => ({
            name: entry.name,
            getContent: () => entry.async('string')
        }));
        updateFileListUI();
    } catch (error) {
        console.error('解压文件时出错:', error);
        showStatusMessage('无法读取此 ZIP 文件，可能已损坏。');
        loadedZip = null;
    }
}

function updateFileListUI() {
    if (filesToProcess.length === 0) {
        showStatusMessage(`在上传的文件中未找到任何 .vtt 文件。`);
        fileListContainer.classList.add('hidden');
        actionButtons.classList.add('hidden');
        return;
    }
    fileList.innerHTML = '';
    filesToProcess.forEach(file => {
        const li = document.createElement('li');
        li.className = 'list-item flex items-center justify-between bg-gray-50 p-3 rounded-lg';
        li.innerHTML = `
            <span class="text-sm font-medium text-gray-700 truncate" title="${file.name}">${file.name}</span>
            <span class="text-sm text-green-600">待处理</span>`;
        fileList.appendChild(li);
    });
    fileListContainer.classList.remove('hidden');
    actionButtons.classList.remove('hidden');
}

function showStatusMessage(message) {
    statusMessage.textContent = message;
}

function clearFiles() {
    filesToProcess = [];
    loadedZip = null; // 清空已加载的 ZIP
    originalInputName = null;
    fileInputDirect.value = '';
    fileInputZip.value = '';
    fileList.innerHTML = '';
    fileListContainer.classList.add('hidden');
    actionButtons.classList.add('hidden');
    showStatusMessage('');
}

function convertVttToLrc(vttContent) {
    const cleanContent = vttContent.replace(/^WEBVTT\s*/, '').replace(/NOTE\s.*\n/g, '').replace(/\r/g, '');
    const lines = cleanContent.split('\n');
    let lrcContent = '';
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('-->')) {
            const startTime = lines[i].split(' --> ')[0].trim();
            const timeParts = startTime.split(/[:.]/);
            if (timeParts.length < 3) continue;
            const hours = timeParts.length > 3 ? parseInt(timeParts[0], 10) : 0;
            const minutes = parseInt(timeParts[timeParts.length - 3], 10) || 0;
            const seconds = parseInt(timeParts[timeParts.length - 2], 10) || 0;
            const milliseconds = parseInt(timeParts[timeParts.length - 1], 10) || 0;
            const totalMinutes = hours * 60 + minutes;
            const hundredths = Math.floor(milliseconds / 10);
            let text = '';
            let j = i + 1;
            while (j < lines.length && lines[j] && lines[j].trim() !== '') {
                text += lines[j].trim() + ' ';
                j++;
            }
            text = text.trim();
            i = j - 1;
            if (text) {
                const lrcTimestamp = `[${String(totalMinutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}]`;
                lrcContent += `${lrcTimestamp}${text}\n`;
            }
        }
    }
    return lrcContent;
}

function getLrcFilename(vttFilename) {
    if (vttFilename.endsWith('.mp3.vtt')) {
        return vttFilename.replace('.mp3.vtt', '.lrc');
    }
    if (vttFilename.endsWith('.wav.vtt')) {
        return vttFilename.replace('.wav.vtt', '.lrc');
    }
    return vttFilename.replace(/.vtt$/, '.lrc');
}

async function convertAndDownload() {
    if (filesToProcess.length === 0 && !loadedZip) return;
    setButtonLoading(true);
    try {
        const outputZip = new JSZip();

        if (loadedZip) {
            // 模式一：处理上传的 ZIP 包
            for (const filename in loadedZip.files) {
                const zipEntry = loadedZip.files[filename];
                if (zipEntry.dir) {
                    continue; // JSZip 会自动处理文件夹
                }

                if (filename.endsWith('.vtt')) {
                    const vttContent = await zipEntry.async('string');
                    const lrcContent = convertVttToLrc(vttContent);
                    const lrcFilename = getLrcFilename(filename);
                    outputZip.file(lrcFilename, lrcContent);
                } else {
                    // 其他文件直接复制
                    const fileContent = await zipEntry.async('blob');
                    outputZip.file(filename, fileContent);
                }
            }
        } else {
            // 模式二：处理直接上传的 VTT 文件
            for (const file of filesToProcess) {
                const vttContent = await file.getContent();
                const lrcContent = convertVttToLrc(vttContent);
                const lrcFilename = getLrcFilename(file.name);
                outputZip.file(lrcFilename, lrcContent);
            }
        }

        const zipBlob = await outputZip.generateAsync({ type: 'blob' });
        const downloadUrl = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = downloadUrl;

        let downloadName = `converted_lrc_${Date.now()}.zip`; // Fallback name
        if (loadedZip && originalInputName) {
            // ZIP mode
            const baseName = originalInputName.replace(/\.zip$/i, '');
            downloadName = `${baseName}_after.zip`;
        } else if (!loadedZip && originalInputName) {
            // Direct VTTs mode
            const baseName = originalInputName.replace(/\.vtt$/i, '');
            downloadName = `${baseName}等等.zip`;
        }
        a.download = downloadName;

        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(downloadUrl);
    } catch (error) {
        console.error('转换或下载过程中发生错误:', error);
        showStatusMessage('处理失败，请在控制台查看错误信息。');
    } finally {
        setButtonLoading(false);
    }
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
