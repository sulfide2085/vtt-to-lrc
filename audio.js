/**
 * WAV → MP3 转码核心（纯逻辑，不依赖 DOM）
 *
 * 设计要点：
 * 1. 自己解析 WAV，支持 PCM 8/16/24/32 bit、IEEE float 32/64 bit、WAVE_FORMAT_EXTENSIBLE；
 * 2. lamejs（LAME 的 JS 移植）只认 8k/11.025k/12k/16k/22.05k/24k/32k/44.1k/48k 这 9 个采样率，
 *    其他采样率（96k/192k/88.2k…）会被它"静默"当成 48k 处理，导致变速变调，因此必须自己重采样；
 * 3. 码率上限随采样率变化：MPEG-1（≥32k）最高 320 kbps，MPEG-2（16k~24k）最高 160 kbps，
 *    MPEG-2.5（≤12k）最高 64 kbps，超出会自动收敛到上限；
 * 4. 编码是同步的重活，按块让出主线程，避免页面卡死，并可上报进度。
 */
(function (root, factory) {
    const api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }

    if (root) {
        root.WavToMp3 = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // lamejs 原生支持的采样率
    const LAME_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

    // 各 MPEG 版本 Layer III 的最高码率
    const MAX_BITRATE_MPEG1 = 320;
    const MAX_BITRATE_MPEG2 = 160;
    const MAX_BITRATE_MPEG25 = 64;

    // 重采样参数
    const RESAMPLE_TAPS_PER_SIDE = 16; // 单位增益时的单侧抽头数
    const RESAMPLE_MAX_TAPS_PER_SIDE = 64;
    const RESAMPLE_KAISER_BETA = 8.6; // ≈ -90 dB 阻带
    const KERNEL_OVERSAMPLE = 256; // 核表过采样倍数

    const SAMPLE_BLOCK = 1152; // MPEG-1 Layer III 每帧样本数
    const YIELD_EVERY_BLOCKS = 24; // 每编码多少块让出一次主线程（约 0.6 秒音频）

    const WAV_FORMAT_PCM = 0x0001;
    const WAV_FORMAT_FLOAT = 0x0003;
    const WAV_FORMAT_EXTENSIBLE = 0xFFFE;

    // --- 通用小工具 ---

    function getLamejs() {
        if (typeof globalThis !== 'undefined' && globalThis.lamejs) return globalThis.lamejs;
        if (typeof lamejs !== 'undefined') return lamejs; // eslint-disable-line no-undef
        return null;
    }

    function isLamejsReady() {
        const lame = getLamejs();
        return !!(lame && typeof lame.Mp3Encoder === 'function');
    }

    function clampInt16(value) {
        if (value > 32767) return 32767;
        if (value < -32768) return -32768;
        return value | 0;
    }

    function readAscii(bytes, offset, length) {
        let out = '';

        for (let i = 0; i < length; i++) {
            out += String.fromCharCode(bytes[offset + i]);
        }

        return out;
    }

    let yieldChannel = null;

    /**
     * 让出主线程，让浏览器有机会刷新进度条。
     * 优先用 MessageChannel：它是宏任务，能被渲染打断，且不像 setTimeout 那样
     * 在嵌套调用 5 次后被强制钳到 4ms（长音频下会累积出几秒的额外耗时）。
     */
    function yieldToEventLoop() {
        if (typeof MessageChannel === 'function') {
            if (!yieldChannel) {
                yieldChannel = new MessageChannel();

                if (typeof yieldChannel.port1.unref === 'function') {
                    yieldChannel.port1.unref();
                    yieldChannel.port2.unref();
                }
            }

            const channel = yieldChannel;

            return new Promise(resolve => {
                channel.port1.onmessage = () => resolve();
                channel.port2.postMessage(0);
            });
        }

        return new Promise(resolve => setTimeout(resolve, 0));
    }

    function formatBytes(value) {
        const bytes = Number(value) || 0;

        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;

        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function formatDuration(seconds) {
        const total = Math.max(0, Math.round(Number(seconds) || 0));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;

        if (h > 0) {
            return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        }

        return `${m}:${String(s).padStart(2, '0')}`;
    }

    // --- 采样率与码率 ---

    function isLameRateSupported(sampleRate) {
        return LAME_SAMPLE_RATES.indexOf(sampleRate) !== -1;
    }

    /**
     * 把任意采样率映射到 lamejs 支持的采样率（取最接近的一个）。
     * 48k 以上的高采样率一律降到 48k，避免被 lamejs 当成 48k 却按原速播放。
     */
    function pickTargetSampleRate(sampleRate) {
        if (isLameRateSupported(sampleRate)) return sampleRate;

        let best = LAME_SAMPLE_RATES[0];
        let bestDiff = Infinity;

        LAME_SAMPLE_RATES.forEach(rate => {
            const diff = Math.abs(rate - sampleRate);

            if (diff < bestDiff) {
                bestDiff = diff;
                best = rate;
            }
        });

        return best;
    }

    function maxBitrateForSampleRate(sampleRate) {
        if (sampleRate >= 32000) return MAX_BITRATE_MPEG1;
        if (sampleRate >= 16000) return MAX_BITRATE_MPEG2;

        return MAX_BITRATE_MPEG25;
    }

    /** 把请求码率收敛到该采样率允许的上限 */
    function effectiveBitrate(sampleRate, requestedBitrate) {
        const max = maxBitrateForSampleRate(sampleRate);
        const requested = Number(requestedBitrate) || MAX_BITRATE_MPEG1;

        return Math.max(8, Math.min(requested, max));
    }

    function estimateMp3Bytes(seconds, bitrate) {
        return Math.round((Number(seconds) || 0) * (Number(bitrate) || 0) * 1000 / 8);
    }

    // --- WAV 解析 ---

    function parseFmtChunk(view, body, size) {
        let formatTag = view.getUint16(body, true);
        const channels = view.getUint16(body + 2, true);
        const sampleRate = view.getUint32(body + 4, true);
        const blockAlignRaw = view.getUint16(body + 12, true);
        const bitsPerSample = view.getUint16(body + 14, true);

        let validBitsPerSample = bitsPerSample;

        if (formatTag === WAV_FORMAT_EXTENSIBLE) {
            if (size < 40 || body + 40 > view.byteLength) {
                throw new Error('WAVE_FORMAT_EXTENSIBLE 的 fmt 区块不完整。');
            }

            validBitsPerSample = view.getUint16(body + 18, true) || bitsPerSample;
            formatTag = view.getUint16(body + 24, true); // SubFormat GUID 前两字节即格式码
        }

        if (formatTag !== WAV_FORMAT_PCM && formatTag !== WAV_FORMAT_FLOAT) {
            const hint = formatTag === 0x0055 ? '（这是 MP3 伪装成 WAV）'
                : formatTag === 0x0002 ? '（ADPCM 压缩 WAV）'
                    : formatTag === 0x0006 || formatTag === 0x0007 ? '（A-law/μ-law 电话音频）'
                        : '';

            throw new Error(`不支持的 WAV 编码格式：0x${formatTag.toString(16).padStart(4, '0')}${hint}，请先导出为 PCM WAV。`);
        }

        if (!channels || channels < 1) {
            throw new Error('WAV 声道数无效。');
        }

        if (!sampleRate) {
            throw new Error('WAV 采样率无效。');
        }

        const isFloat = formatTag === WAV_FORMAT_FLOAT;

        if (isFloat && bitsPerSample !== 32 && bitsPerSample !== 64) {
            throw new Error(`不支持的浮点位深：${bitsPerSample} bit。`);
        }

        if (!isFloat && [8, 16, 24, 32].indexOf(bitsPerSample) === -1) {
            throw new Error(`不支持的 PCM 位深：${bitsPerSample} bit。`);
        }

        const bytesPerSample = bitsPerSample / 8;
        const frameBytes = Math.max(blockAlignRaw || 0, channels * bytesPerSample);

        return {
            formatTag,
            isFloat,
            channels,
            sampleRate,
            bitsPerSample,
            validBitsPerSample,
            bytesPerSample,
            frameBytes
        };
    }

    /**
     * 解析 RIFF/WAVE 头，返回采样格式与 data 区块位置。
     * 只解析头部，不复制音频数据。
     */
    function parseWav(arrayBuffer) {
        if (!arrayBuffer || typeof arrayBuffer.byteLength !== 'number') {
            throw new Error('无效的音频数据。');
        }

        const bytes = new Uint8Array(arrayBuffer);
        const view = new DataView(arrayBuffer);

        if (bytes.length < 12) {
            throw new Error('文件太小，不是有效的 WAV。');
        }

        const riffMagic = readAscii(bytes, 0, 4);

        if (riffMagic === 'RF64' || riffMagic === 'BW64') {
            throw new Error('暂不支持 RF64/BW64（超过 4GB 的 WAV）文件。');
        }

        if (riffMagic !== 'RIFF') {
            throw new Error('不是有效的 RIFF/WAV 文件。');
        }

        if (readAscii(bytes, 8, 4) !== 'WAVE') {
            throw new Error('不是有效的 WAVE 文件。');
        }

        let fmt = null;
        let dataOffset = -1;
        let dataSize = 0;

        let offset = 12;

        while (offset + 8 <= bytes.length) {
            const chunkId = readAscii(bytes, offset, 4);
            const chunkSize = view.getUint32(offset + 4, true);
            const body = offset + 8;

            if (chunkId === 'fmt ') {
                if (chunkSize < 16 || body + 16 > bytes.length) {
                    throw new Error('fmt 区块损坏。');
                }

                fmt = parseFmtChunk(view, body, chunkSize);
            } else if (chunkId === 'data') {
                // 流式 WAV 常把 size 写成 0 或 0xFFFFFFFF，此时按实际长度处理
                const declared = chunkSize === 0 || chunkSize === 0xFFFFFFFF ? bytes.length - body : chunkSize;

                dataOffset = body;
                dataSize = Math.max(0, Math.min(declared, bytes.length - body));
            }

            // 区块长度按偶数字节对齐
            offset = body + chunkSize + (chunkSize % 2);
        }

        if (!fmt) {
            throw new Error('WAV 缺少 fmt 区块。');
        }

        if (dataOffset < 0) {
            throw new Error('WAV 缺少 data 区块。');
        }

        const frames = Math.floor(dataSize / fmt.frameBytes);

        if (frames <= 0) {
            throw new Error('WAV 中没有可用的音频数据。');
        }

        return Object.assign({}, fmt, {
            bytes,
            view,
            dataOffset,
            dataSize,
            frames,
            duration: frames / fmt.sampleRate
        });
    }

    // --- 取样：把某一声道读成 Int16Array 或 Float32Array ---

    function readChannelSamples(wav, channel, asFloat) {
        const { bytes, view, dataOffset, frames, channels, bitsPerSample, isFloat, bytesPerSample, frameBytes } = wav;

        const out = asFloat ? new Float32Array(frames) : new Int16Array(frames);
        const base = dataOffset + channel * bytesPerSample;
        const step = frameBytes;

        // 16 bit PCM 快路径：直接建 Int16 视图（需要 2 字节对齐且不越界）
        if (!isFloat && bitsPerSample === 16 &&
            (bytes.byteOffset + base) % 2 === 0 &&
            base + frames * channels * 2 <= bytes.byteLength) {
            const src = new Int16Array(bytes.buffer, bytes.byteOffset + base, frames * channels);

            for (let i = 0, p = 0; i < frames; i++, p += channels) {
                const value = src[p];
                out[i] = asFloat ? value / 32768 : value;
            }

            return out;
        }

        const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

        if (isFloat) {
            const read = bitsPerSample === 64
                ? pos => dataView.getFloat64(pos, true)
                : pos => dataView.getFloat32(pos, true);

            for (let i = 0, pos = base; i < frames; i++, pos += step) {
                const value = read(pos);

                if (asFloat) {
                    out[i] = value > 1 ? 1 : value < -1 ? -1 : value;
                } else {
                    out[i] = clampInt16(Math.round((value > 1 ? 1 : value < -1 ? -1 : value) * 32768));
                }
            }

            return out;
        }

        switch (bitsPerSample) {
            case 8: {
                // 8 bit WAV 是无符号的，128 为静音中点
                for (let i = 0, pos = base; i < frames; i++, pos += step) {
                    const value = (dataView.getUint8(pos) - 128) * 256;
                    out[i] = asFloat ? value / 32768 : value;
                }

                break;
            }

            case 24: {
                for (let i = 0, pos = base; i < frames; i++, pos += step) {
                    let value = dataView.getUint8(pos) |
                        (dataView.getUint8(pos + 1) << 8) |
                        (dataView.getUint8(pos + 2) << 16);

                    if (value & 0x800000) value -= 0x1000000;

                    if (asFloat) {
                        out[i] = value / 8388608;
                    } else {
                        out[i] = clampInt16(Math.round(value / 256));
                    }
                }

                break;
            }

            case 32: {
                for (let i = 0, pos = base; i < frames; i++, pos += step) {
                    const value = dataView.getInt32(pos, true);
                    out[i] = asFloat ? value / 2147483648 : clampInt16(Math.round(value / 65536));
                }

                break;
            }

            default: {
                // 16 bit 但未对齐，走通用路径
                for (let i = 0, pos = base; i < frames; i++, pos += step) {
                    const value = dataView.getInt16(pos, true);
                    out[i] = asFloat ? value / 32768 : value;
                }
            }
        }

        return out;
    }

    // --- 重采样：Kaiser 窗 sinc 插值 ---

    function besselI0(x) {
        let sum = 1;
        let term = 1;

        for (let k = 1; k < 32; k++) {
            const half = x / (2 * k);
            term *= half * half;
            sum += term;

            if (term < sum * 1e-16) break;
        }

        return sum;
    }

    function buildResampleKernel(inRate, outRate) {
        const ratio = outRate / inRate;
        const cutoff = Math.min(1, ratio); // 相对输入奈奎斯特的截止频率
        const halfTaps = Math.max(4, Math.min(RESAMPLE_MAX_TAPS_PER_SIDE, Math.ceil(RESAMPLE_TAPS_PER_SIDE / cutoff)));
        const tableSize = 2 * halfTaps * KERNEL_OVERSAMPLE + 1;
        const table = new Float32Array(tableSize);
        const norm = besselI0(RESAMPLE_KAISER_BETA);

        for (let n = 0; n < tableSize; n++) {
            const x = n / KERNEL_OVERSAMPLE - halfTaps; // x ∈ [-halfTaps, halfTaps]
            const s = x * cutoff;

            const sinc = s === 0 ? 1 : Math.sin(Math.PI * s) / (Math.PI * s);

            const r = x / halfTaps;
            const inside = 1 - r * r;
            const window = inside > 0 ? besselI0(RESAMPLE_KAISER_BETA * Math.sqrt(inside)) / norm : 0;

            table[n] = sinc * window * cutoff;
        }

        return { table, halfTaps, ratio, cutoff };
    }

    function resampleChannel(input, kernel) {
        const { table, halfTaps, ratio } = kernel;
        const outLength = Math.max(1, Math.round(input.length * ratio));
        const out = new Float32Array(outLength);

        const lastIndex = input.length - 1;
        const tableMax = table.length - 1;

        for (let j = 0; j < outLength; j++) {
            const pos = j / ratio;
            const center = Math.floor(pos);

            const from = Math.max(center - halfTaps + 1, 0);
            const to = Math.min(center + halfTaps, lastIndex);

            let sum = 0;
            let weight = 0;

            for (let i = from; i <= to; i++) {
                let index = Math.round((pos - i + halfTaps) * KERNEL_OVERSAMPLE);

                if (index < 0) index = 0;
                else if (index > tableMax) index = tableMax;

                const k = table[index];
                sum += input[i] * k;
                weight += k;
            }

            // 按权重和归一化，保证边界处与直流增益一致
            out[j] = weight !== 0 ? sum / weight : 0;
        }

        return out;
    }

    function floatToInt16(input) {
        const out = new Int16Array(input.length);

        for (let i = 0; i < input.length; i++) {
            out[i] = clampInt16(Math.round(input[i] * 32768));
        }

        return out;
    }

    // --- 解码：WAV -> Int16 声道数据 ---

    function decodeParsedWav(wav, onStage) {
        const targetRate = pickTargetSampleRate(wav.sampleRate);
        const needsResample = targetRate !== wav.sampleRate;
        const kernel = needsResample ? buildResampleKernel(wav.sampleRate, targetRate) : null;

        const report = typeof onStage === 'function' ? onStage : null;
        const outChannels = [];
        const isMono = wav.channels === 1;

        if (wav.channels <= 2) {
            for (let c = 0; c < wav.channels; c++) {
                if (report) report(0.05 + 0.1 * (c / wav.channels), `正在读取第 ${c + 1} 声道…`);

                if (needsResample) {
                    const floatData = readChannelSamples(wav, c, true);
                    outChannels.push(floatToInt16(resampleChannel(floatData, kernel)));
                } else {
                    outChannels.push(readChannelSamples(wav, c, false));
                }
            }
        } else {
            // 多声道（5.1 等）：偶数声道归左、奇数声道归右后取平均
            if (report) report(0.05, `正在把 ${wav.channels} 声道下混为立体声…`);

            const targetLength = needsResample ? Math.max(1, Math.round(wav.frames * kernel.ratio)) : wav.frames;
            const accLeft = new Float32Array(targetLength);
            const accRight = new Float32Array(targetLength);
            const countLeft = new Uint16Array(targetLength);
            const countRight = new Uint16Array(targetLength);

            for (let c = 0; c < wav.channels; c++) {
                const floatData = readChannelSamples(wav, c, true);
                const data = needsResample ? resampleChannel(floatData, kernel) : floatData;
                const acc = c % 2 === 0 ? accLeft : accRight;
                const counter = c % 2 === 0 ? countLeft : countRight;
                const length = Math.min(data.length, targetLength);

                for (let i = 0; i < length; i++) {
                    acc[i] += data[i];
                    counter[i] += 1;
                }
            }

            const left = new Int16Array(targetLength);
            const right = new Int16Array(targetLength);

            for (let i = 0; i < targetLength; i++) {
                left[i] = clampInt16(Math.round((countLeft[i] ? accLeft[i] / countLeft[i] : 0) * 32768));
                right[i] = clampInt16(Math.round((countRight[i] ? accRight[i] / countRight[i] : 0) * 32768));
            }

            outChannels.push(left, right);
        }

        return {
            channels: outChannels,
            channelCount: outChannels.length,
            sampleRate: targetRate,
            sourceSampleRate: wav.sampleRate,
            sourceChannelCount: wav.channels,
            sourceBitsPerSample: wav.bitsPerSample,
            sourceIsFloat: wav.isFloat,
            resampled: needsResample,
            frames: outChannels[0].length,
            duration: outChannels[0].length / targetRate,
            isMono
        };
    }

    function decodeWavToPcm(arrayBuffer, options) {
        const opts = options || {};
        const wav = parseWav(arrayBuffer);

        return decodeParsedWav(wav, opts.onStage);
    }

    // --- 编码：Int16 声道数据 -> MP3 ---

    async function encodeMp3(pcm, options) {
        const opts = options || {};
        const lame = getLamejs();

        if (!lame || typeof lame.Mp3Encoder !== 'function') {
            throw new Error('MP3 编码库（lamejs）未加载，请检查网络后刷新页面。');
        }

        const sampleRate = opts.sampleRate || pcm.sampleRate;
        const bitrate = effectiveBitrate(sampleRate, opts.bitrate);
        const channelCount = pcm.channels.length === 1 ? 1 : 2;
        const left = pcm.channels[0];
        const right = channelCount === 2 ? pcm.channels[1] : null;
        const total = left.length;

        if (!total) {
            throw new Error('没有可编码的音频数据。');
        }

        const encoder = new lame.Mp3Encoder(channelCount, sampleRate, bitrate);
        const chunks = [];
        const report = typeof opts.onProgress === 'function' ? opts.onProgress : null;

        let blockCount = 0;
        let byteLength = 0;

        for (let offset = 0; offset < total; offset += SAMPLE_BLOCK) {
            const end = Math.min(offset + SAMPLE_BLOCK, total);
            const leftChunk = left.subarray(offset, end);

            const encoded = channelCount === 2
                ? encoder.encodeBuffer(leftChunk, right.subarray(offset, end))
                : encoder.encodeBuffer(leftChunk);

            if (encoded.length > 0) {
                const chunk = new Uint8Array(encoded.length);

                chunk.set(encoded);
                chunks.push(chunk);
                byteLength += chunk.length;
            }

            blockCount++;

            if (blockCount % YIELD_EVERY_BLOCKS === 0) {
                if (report) report(end / total, { byteLength, processedSamples: end, totalSamples: total });

                await yieldToEventLoop();
            }
        }

        const tail = encoder.flush();

        if (tail.length > 0) {
            const chunk = new Uint8Array(tail.length);

            chunk.set(tail);
            chunks.push(chunk);
            byteLength += chunk.length;
        }

        if (report) report(1, { byteLength, processedSamples: total, totalSamples: total });

        const output = new Uint8Array(byteLength);
        let position = 0;

        chunks.forEach(chunk => {
            output.set(chunk, position);
            position += chunk.length;
        });

        return {
            data: output,
            bitrate,
            sampleRate,
            channelCount,
            byteLength,
            duration: total / sampleRate
        };
    }

    // --- 一站式：WAV 文件 -> MP3 文件 ---

    async function wavToMp3(arrayBuffer, options) {
        const opts = options || {};
        const report = typeof opts.onProgress === 'function' ? opts.onProgress : null;

        // 进度权重：解析+解码占前 25%，编码占后 75%
        const decodeReporter = (ratio, message) => {
            if (report) report(Math.min(0.25, ratio * 0.25), message);
        };

        if (report) report(0, '正在解析 WAV 文件…');

        const wav = parseWav(arrayBuffer);

        if (report) {
            report(0.02, `WAV：${wav.channels} 声道 / ${wav.sampleRate} Hz / ${wav.bitsPerSample} bit / ${formatDuration(wav.duration)}`);
        }

        const pcm = decodeParsedWav(wav, decodeReporter);
        const bitrate = effectiveBitrate(pcm.sampleRate, opts.bitrate);

        if (report) {
            const resampleNote = pcm.resampled ? `，重采样 ${pcm.sourceSampleRate} → ${pcm.sampleRate} Hz` : '';
            report(0.25, `开始编码 MP3 ${bitrate} kbps${resampleNote}`);
        }

        const encoded = await encodeMp3(pcm, {
            bitrate,
            sampleRate: pcm.sampleRate,
            onProgress: (ratio, info) => {
                if (report) report(0.25 + ratio * 0.75, `正在编码 MP3 ${bitrate} kbps ${Math.round(ratio * 100)}%`, info);
            }
        });

        return Object.assign({}, encoded, {
            sourceSampleRate: pcm.sourceSampleRate,
            sourceChannelCount: pcm.sourceChannelCount,
            sourceBitsPerSample: pcm.sourceBitsPerSample,
            resampled: pcm.resampled,
            requestedBitrate: Number(opts.bitrate) || MAX_BITRATE_MPEG1,
            bitrateLimited: bitrate < (Number(opts.bitrate) || MAX_BITRATE_MPEG1)
        });
    }

    return {
        LAME_SAMPLE_RATES,
        isLamejsReady,
        getLamejs,
        parseWav,
        decodeWavToPcm,
        decodeParsedWav,
        encodeMp3,
        wavToMp3,
        isLameRateSupported,
        pickTargetSampleRate,
        maxBitrateForSampleRate,
        effectiveBitrate,
        estimateMp3Bytes,
        buildResampleKernel,
        resampleChannel,
        formatBytes,
        formatDuration
    };
});
