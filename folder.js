/**
 * 文件夹模式：用 File System Access API 直接读写本地文件夹。
 *
 * 为什么单独一个文件：ZIP 模式只能"读进来、打包下载"，文件夹模式的整个价值
 * 在于**写回原路径**，而写回要用到一套和 ZIP 完全不同的 API（句柄、可写流、
 * 删除条目），且这套 API 只有 Chromium 系浏览器支持。放在一起会让 app.js
 * 里到处是能力判断；拆出来之后 app.js 只需要问 isSupported()。
 *
 * 几个刻意的取舍：
 * 1. 不用 dirHandle.entries() 的异步迭代器：Chrome 从 86 到 122 才有，用
 *    values() + 递归兼容性更好，也更好写失败处理。
 * 2. 单个子目录读不动（权限被系统拒绝）只跳过该目录，不整体失败——音声包里
 *    混进一个系统目录不该让整包转不了。
 * 3. 只统计需要的文件（VTT/WAV/MP3/图片），其它文件一律不动，避免误删。
 * 4. 只读句柄（拖拽进来的目录在旧版 Chrome / Firefox 上就是这个形态）
 *    一律降级成"读进来、打包下载"，绝不假装能写。
 */
(function (global) {
    'use strict';

    const FA_SUPPORTED = typeof global.showDirectoryPicker === 'function';

    /** 递归深度上限：防止有人把盘根目录塞进来，转半天 */
    const MAX_DEPTH = 24;

    /** 这些目录名直接跳过（大小写不敏感） */
    const JUNK_DIRS = new Set([
        'node_modules', '.git', '.svn', '.hg', '__macosx',
        '$recycle.bin', 'system volume information', '.cache', '.idea', '.vscode'
    ]);

    const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp)$/i;

    const MIME_BY_EXTENSION = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        bmp: 'image/bmp'
    };

    // --- 能力判断 ---

    /**
     * 浏览器是否有目录句柄能力。
     * options.supported 是端到端测试用的开关：真实浏览器里没法把 showDirectoryPicker
     * 变成不存在，只能靠它模拟 Firefox / Safari 的降级路径。
     */
    function isSupported(options = {}) {
        if (typeof options.supported === 'boolean') return options.supported;

        return FA_SUPPORTED || typeof global.__vttTestDirectoryProvider === 'function';
    }

    /**
     * 是否能写回原路径。
     * 注意：选中目录之前无法确定，所以界面先按 isSupported() 显示，
     * 拿到句柄后再用 canWriteDirectory() 复核一次。
     */
    function canWriteDirectory(handle) {
        return !!handle && typeof handle.removeEntry === 'function';
    }

    function canWriteFile(handle) {
        return !!handle && typeof handle.createWritable === 'function';
    }

    /** 用户在选择器里点了取消（不是错误，不该弹报错） */
    function isAbortError(error) {
        return !!error && (error.name === 'AbortError' || /abort/i.test(error.name || ''));
    }

    function mimeForPath(filePath) {
        const ext = String(filePath).split('.').pop().toLowerCase();

        return MIME_BY_EXTENSION[ext] || 'application/octet-stream';
    }

    function getBaseName(filePath) {
        return String(filePath).split(/[\\/]/).pop();
    }

    function getExtension(filePath) {
        const base = getBaseName(filePath);
        const dotIndex = base.lastIndexOf('.');

        return dotIndex > 0 ? base.slice(dotIndex).toLowerCase() : '';
    }

    // --- 选择目录 ---

    /**
     * 弹目录选择器。
     *
     * 返回值区分三种情况，调用方据此决定写回还是降级：
     *   { handle, supported: true,  canWrite: true  }  Chromium，可以写回原路径
     *   { handle, supported: true,  canWrite: false }  只读句柄（拖拽降级），只能打包下载
     *   { supported: false }                          浏览器不支持，调用方改用 <input webkitdirectory>
     *   { canceled: true }                            用户点了取消
     *
     * window.__vttTestDirectoryProvider 是端到端测试的注入点：真实浏览器里
     * 自动化工具点不动系统目录选择器，测试用它塞一个内存目录树进来，
     * 从而能真的验证"文件被写到了哪个路径、内容对不对"。
     */
    async function pickDirectory(options = {}) {
        const provider = typeof global.__vttTestDirectoryProvider === 'function'
            ? global.__vttTestDirectoryProvider
            : (FA_SUPPORTED ? defaultPicker : null);

        if (!provider) {
            return { supported: false };
        }

        const handle = await provider({
            id: options.id || 'vtt-to-lrc-directory',
            mode: 'readwrite',
            startIn: options.startIn || 'documents'
        });

        if (!handle) return { canceled: true };

        return {
            handle,
            supported: true,
            canWrite: canWriteDirectory(handle)
        };
    }

    function defaultPicker(options) {
        return global.showDirectoryPicker(options);
    }

    // --- 递归扫描 ---

    function sortByName(left, right) {
        return left.name.localeCompare(right.name, 'zh-Hans-CN', { numeric: true });
    }

    /**
     * 递归列出目录下所有文件。
     * 返回 { files, skippedDirs, truncated }，files 为
     * { path, name, relPath, size, lastModified, handle }，path 从所选目录名开始。
     */
    async function scanDirectory(rootHandle, options = {}) {
        const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : MAX_DEPTH;
        const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
        const rootName = String(rootHandle.name || 'folder');
        const files = [];
        const skippedDirs = [];
        let truncated = false;
        let visited = 0;

        async function readChildren(handle) {
            const children = [];

            for await (const child of handle.values()) {
                children.push(child);
            }

            return children.sort(sortByName);
        }

        async function walk(handle, relDir, depth) {
            if (depth > maxDepth) {
                truncated = true;
                return;
            }

            let children;

            try {
                children = await readChildren(handle);
            } catch (error) {
                skippedDirs.push(`${relDir || rootName}（${error.message || '无法读取'}）`);
                return;
            }

            for (const child of children) {
                const childPath = relDir ? `${relDir}/${child.name}` : child.name;

                if (child.kind === 'directory') {
                    if (JUNK_DIRS.has(String(child.name).toLowerCase())) continue;

                    await walk(child, childPath, depth + 1);
                    continue;
                }

                // 所有文件都收进来，不只 VTT / WAV / MP3 / 图片：
                // 平铺要把整个目录树都展开，漏掉的文件会留在子目录里挡住清理；
                // 只读模式下这些文件也会原样进 ZIP，和压缩包模式的行为一致。
                let size = 0;
                let lastModified = 0;

                // 拿体积和修改时间：确认清单里要显示，也用于"内容没变就跳过"
                try {
                    const file = await child.getFile();

                    size = file.size;
                    lastModified = file.lastModified;
                } catch {
                    // 读不到元信息不影响后续读取，留 0
                }

                files.push({
                    path: `${rootName}/${childPath}`,
                    relPath: childPath,
                    name: child.name,
                    size,
                    lastModified,
                    handle: child
                });

                visited++;

                if (onProgress && visited % 25 === 0) {
                    onProgress(`已扫描 ${visited} 个文件…（当前：${childPath}）`);
                }
            }
        }

        await walk(rootHandle, '', 1);

        return {
            files,
            skippedDirs,
            truncated,
            rootName,
            canWrite: canWriteDirectory(rootHandle)
        };
    }

    // --- 写回 / 删除 ---

    function toBytes(data) {
        if (data instanceof Uint8Array) return data;
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (typeof data === 'string') return new TextEncoder().encode(data);

        throw new Error('不支持写入这种数据。');
    }

    /** 把相对路径逐级创建出来，返回目标文件的句柄 */
    async function resolveFileHandle(rootHandle, relPath, options = {}) {
        const parts = String(relPath).split(/[\\/]/).filter(Boolean);

        if (parts.length === 0) {
            throw new Error('写回路径为空。');
        }

        const fileName = parts.pop();
        let dir = rootHandle;

        for (const part of parts) {
            dir = await dir.getDirectoryHandle(part, {
                create: options.create !== false
            });
        }

        return dir.getFileHandle(fileName, {
            create: options.create !== false
        });
    }

    async function writeFile(rootHandle, relPath, data) {
        const fileHandle = await resolveFileHandle(rootHandle, relPath);

        if (!canWriteFile(fileHandle)) {
            throw new Error('这个文件夹只读（浏览器未授予写入权限），无法写回。');
        }

        const writable = await fileHandle.createWritable();

        try {
            await writable.write(toBytes(data));
        } catch (error) {
            // 写失败就中止：调 close() 反而会把半截数据落盘
            await writable.abort().catch(() => {});
            throw error;
        }

        await writable.close();

        return relPath;
    }

    async function readFile(rootHandle, relPath) {
        const parts = String(relPath).split(/[\\/]/).filter(Boolean);
        const fileName = parts.pop();
        let dir = rootHandle;

        for (const part of parts) {
            dir = await dir.getDirectoryHandle(part);
        }

        const fileHandle = await dir.getFileHandle(fileName);

        return new Uint8Array(await (await fileHandle.getFile()).arrayBuffer());
    }

    /** 只删文件，不删目录：目录里可能还有用户自己的东西 */
    async function deleteFile(rootHandle, relPath) {
        const parts = String(relPath).split(/[\\/]/).filter(Boolean);
        const fileName = parts.pop();
        let dir = rootHandle;

        for (const part of parts) {
            dir = await dir.getDirectoryHandle(part);
        }

        await dir.removeEntry(fileName);
    }

    /**
     * 删掉一个子目录，删之前重新确认它真的是空的。
     *
     * 只看规划时的清单不够：目录里可能还有扫描时被忽略的文件（txt、字幕之外的
     * 任何东西），那些文件不在清单里，却实实在在占着目录。写盘之后重新列一遍
     * 是最可靠的判断。
     *
     * 返回 true 表示目录已经不存在（删掉了，或本来就没有）。
     */
    async function deleteDirectoryIfEmpty(rootHandle, relPath) {
        const parts = String(relPath).split(/[\\/]/).filter(Boolean);

        if (parts.length === 0) return false;

        const dirName = parts.pop();
        let parent = rootHandle;

        try {
            for (const part of parts) {
                parent = await parent.getDirectoryHandle(part, { create: false });
            }

            const directory = await parent.getDirectoryHandle(dirName, { create: false });
            const names = [];

            for await (const child of directory.values()) {
                names.push(child.name);
            }

            if (names.length > 0) return false;

            await parent.removeEntry(dirName);

            return true;
        } catch (error) {
            // 目录已经不存在 = 目标状态已达成；其它错误（非空 / 权限）照实抛出
            if (error && error.name === 'NotFoundError') return true;

            throw error;
        }
    }

    /**
     * 用 File 对象建一个只读目录句柄。
     * 降级路径（<input webkitdirectory>）已经拿到了完整 File 列表，
     * 这里包一层让后面扫描/转换代码不用写两套分支——只是写入会被拒绝。
     * 先把路径还原成一棵树（按层去重），再套上句柄的形状。
     */
    function handleFromFiles(files, rootName) {
        const name = rootName || '所选文件夹';
        const root = { dirs: new Map(), files: [] };

        for (const file of files) {
            const segments = String(file.webkitRelativePath || file.name)
                .split(/[\\/]/)
                .filter(Boolean);

            // 去掉第一层（就是所选目录本身）
            if (segments.length > 1) segments.shift();

            const fileName = segments.pop();

            if (!fileName) continue;

            const relPath = segments.concat(fileName).join('/');

            let cursor = root;

            for (const segment of segments) {
                if (!cursor.dirs.has(segment)) {
                    cursor.dirs.set(segment, { dirs: new Map(), files: [] });
                }

                cursor = cursor.dirs.get(segment);
            }

            cursor.files.push(file);
        }

        return materializeDirectory(root, name);
    }

    function materializeDirectory(node, name) {
        const directory = {
            kind: 'directory',
            name,
            readOnly: true,
            async *values() {
                const files = node.files
                    .slice()
                    .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN', { numeric: true }));

                for (const file of files) {
                    yield {
                        kind: 'file',
                        name: file.name,
                        getFile: async () => file
                    };
                }

                const dirNames = [...node.dirs.keys()].sort((left, right) => left.localeCompare(right, 'zh-Hans-CN', { numeric: true }));

                for (const dirName of dirNames) {
                    yield materializeDirectory(node.dirs.get(dirName), dirName);
                }
            }
        };

        return directory;
    }

    global.FolderFs = {
        MAX_DEPTH,
        IMAGE_EXTENSIONS,
        MIME_BY_EXTENSION,
        isSupported,
        canWriteDirectory,
        canWriteFile,
        isAbortError,
        mimeForPath,
        getBaseName,
        getExtension,
        pickDirectory,
        scanDirectory,
        resolveFileHandle,
        writeFile,
        readFile,
        deleteFile,
        deleteDirectoryIfEmpty,
        handleFromFiles,
        toBytes
    };
})(window);
