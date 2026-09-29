/**
 * WAV → MP3 转码核心测试（零依赖，直接 node 运行）
 *
 *   node tests/wav-to-mp3.test.js
 *
 * 首次运行会从 CDN 下载 lamejs 到系统临时目录做缓存；离线时只跑纯逻辑测试。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const WavToMp3 = require('../audio.js');

const LAME_URL = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';

let passed = 0;
let failed = 0;
let skipped = 0;

const tests = [];

function test(name, fn) {
    tests.push({ name, fn });
}

function skip(name) {
    tests.push({ name, skip: true });
}

// --- 合成 WAV ---

function makeWav(options) {
    const {
        sampleRate = 44100,
        channels = 2,
        bitsPerSample = 16,
        float = false,
        frames = 4410,
        extensible = false,
        extraDataBytes = 0,
        formatTagOverride = null,
        sampleAt = (frame, channel) => Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 0.5
    } = options;

    const bytesPerSample = bitsPerSample / 8;
    const frameBytes = channels * bytesPerSample;
    const dataSize = frames * frameBytes + extraDataBytes;
    const fmtSize = extensible ? 40 : 16;
    const dataChunkOffset = 12 + 8 + fmtSize;
    const total = dataChunkOffset + 8 + dataSize;

    const buffer = Buffer.alloc(total);

    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(total - 8, 4);
    buffer.write('WAVE', 8, 'ascii');

    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(fmtSize, 16);

    const tag = formatTagOverride !== null ? formatTagOverride : extensible ? 0xfffe : float ? 3 : 1;

    buffer.writeUInt16LE(tag, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * frameBytes, 28);
    buffer.writeUInt16LE(frameBytes, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);

    if (extensible) {
        buffer.writeUInt16LE(22, 36);
        buffer.writeUInt16LE(bitsPerSample, 38);
        buffer.writeUInt32LE(channels === 1 ? 0x4 : 0x3, 40);
        buffer.writeUInt16LE(float ? 3 : 1, 44);
    }

    buffer.write('data', dataChunkOffset, 'ascii');
    buffer.writeUInt32LE(dataSize, dataChunkOffset + 4);

    const dataOffset = dataChunkOffset + 8;

    for (let frame = 0; frame < frames; frame++) {
        for (let channel = 0; channel < channels; channel++) {
            const value = Math.max(-1, Math.min(1, sampleAt(frame, channel)));
            const position = dataOffset + frame * frameBytes + channel * bytesPerSample;

            if (float) {
                if (bitsPerSample === 64) buffer.writeDoubleLE(value, position);
                else buffer.writeFloatLE(value, position);
            } else if (bitsPerSample === 8) {
                buffer.writeUInt8(Math.max(0, Math.min(255, Math.round(value * 127) + 128)), position);
            } else if (bitsPerSample === 16) {
                buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), position);
            } else if (bitsPerSample === 24) {
                const int = Math.max(-8388608, Math.min(8388607, Math.round(value * 8388607)));
                const unsigned = int < 0 ? int + 0x1000000 : int;

                buffer.writeUInt8(unsigned & 0xff, position);
                buffer.writeUInt8((unsigned >> 8) & 0xff, position + 1);
                buffer.writeUInt8((unsigned >> 16) & 0xff, position + 2);
            } else if (bitsPerSample === 32) {
                buffer.writeInt32LE(Math.max(-2147483648, Math.min(2147483647, Math.round(value * 2147483647))), position);
            }
        }
    }

    return buffer;
}

function toArrayBuffer(buffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function readMp3Header(bytes) {
    for (let i = 0; i + 4 <= bytes.length; i++) {
        if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;

        const versionBits = (bytes[i + 1] >> 3) & 0x03;
        const layerBits = (bytes[i + 1] >> 1) & 0x03;
        const bitrateIndex = (bytes[i + 2] >> 4) & 0x0f;
        const rateIndex = (bytes[i + 2] >> 2) & 0x03;
        const modeBits = (bytes[i + 3] >> 6) & 0x03;

        const rateTable = {
            3: [44100, 48000, 32000],
            2: [22050, 24000, 16000],
            0: [11025, 12000, 8000]
        }[versionBits];

        const bitrateTableV1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
        const bitrateTableV2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

        if (!rateTable || layerBits !== 1) continue;

        return {
            offset: i,
            versionBits,
            mpeg: versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5,
            sampleRate: rateTable[rateIndex],
            bitrate: (versionBits === 3 ? bitrateTableV1 : bitrateTableV2)[bitrateIndex],
            mode: ['stereo', 'joint', 'dual', 'mono'][modeBits]
        };
    }

    return null;
}

/** 用零交叉估算主频，用于验证重采样没有变调 */
function estimateFrequency(samples, sampleRate) {
    let crossings = 0;
    let first = -1;
    let last = -1;

    for (let i = 1; i < samples.length; i++) {
        if (samples[i - 1] < 0 && samples[i] >= 0) {
            if (first < 0) first = i;
            last = i;
            crossings++;
        }
    }

    if (crossings < 2) return 0;

    return ((crossings - 1) * sampleRate) / (last - first);
}

// --- 纯逻辑测试 ---

test('解析 16 bit 立体声 WAV 头', () => {
    const wav = WavToMp3.parseWav(toArrayBuffer(makeWav({ frames: 4410 })));

    assert.strictEqual(wav.channels, 2);
    assert.strictEqual(wav.sampleRate, 44100);
    assert.strictEqual(wav.bitsPerSample, 16);
    assert.strictEqual(wav.isFloat, false);
    assert.strictEqual(wav.frames, 4410);
    assert.ok(Math.abs(wav.duration - 0.1) < 1e-9);
});

test('解析 WAVE_FORMAT_EXTENSIBLE 24 bit', () => {
    const wav = WavToMp3.parseWav(toArrayBuffer(makeWav({ bitsPerSample: 24, extensible: true, channels: 1 })));

    assert.strictEqual(wav.channels, 1);
    assert.strictEqual(wav.bitsPerSample, 24);
    assert.strictEqual(wav.formatTag, 1);
    assert.strictEqual(wav.isFloat, false);
});

test('解码 16 bit 样本值与源数据一致', () => {
    const frames = 1000;
    const buffer = makeWav({ frames, channels: 2, sampleAt: (frame, channel) => (frame % 100) / 200 - 0.25 + channel * 0.1 });
    const pcm = WavToMp3.decodeWavToPcm(toArrayBuffer(buffer));

    assert.strictEqual(pcm.channelCount, 2);
    assert.strictEqual(pcm.frames, frames);
    assert.strictEqual(pcm.sampleRate, 44100);

    for (let i = 0; i < frames; i += 97) {
        const expected = Math.round(((i % 100) / 200 - 0.25) * 32767);
        assert.ok(Math.abs(pcm.channels[0][i] - expected) <= 1, `左声道第 ${i} 点应为 ${expected}，实际 ${pcm.channels[0][i]}`);

        const expectedRight = Math.round(((i % 100) / 200 - 0.15) * 32767);
        assert.ok(Math.abs(pcm.channels[1][i] - expectedRight) <= 1, `右声道第 ${i} 点应为 ${expectedRight}，实际 ${pcm.channels[1][i]}`);
    }
});

test('解码 24 bit 取高 16 位', () => {
    const pcm = WavToMp3.decodeWavToPcm(toArrayBuffer(makeWav({
        bitsPerSample: 24,
        channels: 1,
        frames: 500,
        sampleAt: () => 0.5
    })));

    assert.strictEqual(pcm.channelCount, 1);
    assert.ok(Math.abs(pcm.channels[0][10] - 16384) <= 1, `期望约 16384，实际 ${pcm.channels[0][10]}`);
});

test('解码 32 bit 浮点', () => {
    const pcm = WavToMp3.decodeWavToPcm(toArrayBuffer(makeWav({
        float: true,
        bitsPerSample: 32,
        channels: 1,
        frames: 500,
        sampleAt: () => -0.25
    })));

    assert.ok(Math.abs(pcm.channels[0][10] + 8192) <= 1, `期望约 -8192，实际 ${pcm.channels[0][10]}`);
});

test('解码 8 bit 无符号 PCM', () => {
    const pcm = WavToMp3.decodeWavToPcm(toArrayBuffer(makeWav({
        bitsPerSample: 8,
        channels: 1,
        frames: 500,
        sampleAt: () => 0.5
    })));

    // 0.5 → 0.5*127+128 = 192（无符号）→ (192-128)*256 = 16384
    assert.ok(Math.abs(pcm.channels[0][10] - 16384) <= 256, `期望约 16384，实际 ${pcm.channels[0][10]}`);
});

test('单声道保持单声道', () => {
    const pcm = WavToMp3.decodeWavToPcm(toArrayBuffer(makeWav({ channels: 1 })));

    assert.strictEqual(pcm.channelCount, 1);
    assert.strictEqual(pcm.isMono, true);
});

test('5.1 声道下混为立体声', () => {
    const pcm = WavToMp3.decodeWavToPcm(toArrayBuffer(makeWav({
        channels: 6,
        frames: 600,
        sampleAt: (frame, channel) => (channel % 2 === 0 ? 0.4 : -0.4)
    })));

    assert.strictEqual(pcm.channelCount, 2);
    assert.strictEqual(pcm.sourceChannelCount, 6);
    assert.ok(pcm.channels[0][100] > 10000, '左声道应接近 +0.4');
    assert.ok(pcm.channels[1][100] < -10000, '右声道应接近 -0.4');
});

test('96 kHz 自动重采样到 48 kHz 且不变调', () => {
    const sourceRate = 96000;
    const tone = 1000;
    const frames = sourceRate; // 1 秒
    const buffer = makeWav({
        sampleRate: sourceRate,
        channels: 2,
        frames,
        sampleAt: frame => Math.sin((2 * Math.PI * tone * frame) / sourceRate)
    });

    const pcm = WavToMp3.decodeWavToPcm(toArrayBuffer(buffer));

    assert.strictEqual(pcm.resampled, true);
    assert.strictEqual(pcm.sampleRate, 48000);
    assert.strictEqual(pcm.sourceSampleRate, 96000);
    assert.ok(Math.abs(pcm.frames - 48000) <= 2, `重采样后长度应约 48000，实际 ${pcm.frames}`);

    const frequency = estimateFrequency(pcm.channels[0], 48000);

    assert.ok(Math.abs(frequency - tone) < 20, `重采样后主频应仍是 ${tone} Hz，实际 ${frequency.toFixed(1)} Hz`);
});

test('192 kHz 降到 48 kHz', () => {
    assert.strictEqual(WavToMp3.pickTargetSampleRate(192000), 48000);
    assert.strictEqual(WavToMp3.pickTargetSampleRate(88200), 48000);
    assert.strictEqual(WavToMp3.pickTargetSampleRate(64000), 48000);
    assert.strictEqual(WavToMp3.pickTargetSampleRate(44100), 44100);
    assert.strictEqual(WavToMp3.pickTargetSampleRate(22050), 22050);
});

test('码率上限随采样率收敛', () => {
    assert.strictEqual(WavToMp3.effectiveBitrate(44100, 320), 320);
    assert.strictEqual(WavToMp3.effectiveBitrate(48000, 320), 320);
    assert.strictEqual(WavToMp3.effectiveBitrate(22050, 320), 160);
    assert.strictEqual(WavToMp3.effectiveBitrate(11025, 320), 64);
});

test('data 区块长度不是帧长整数倍时也能解码', () => {
    const buffer = makeWav({ frames: 500, channels: 2, extraDataBytes: 2 });
    const pcm = WavToMp3.decodeWavToPcm(toArrayBuffer(buffer));

    assert.strictEqual(pcm.frames, 500);
    assert.ok(Number.isFinite(pcm.channels[1][499]));
});

test('非 PCM 格式给出明确错误', () => {
    assert.throws(() => WavToMp3.parseWav(toArrayBuffer(makeWav({ formatTagOverride: 0x0055 }))), /不支持的 WAV 编码格式/);
    assert.throws(() => WavToMp3.parseWav(toArrayBuffer(Buffer.from('这不是音频文件的内容，只是随便凑够长度的一段文字。'))), /不是有效的 RIFF\/WAV/);
});

test('MP3 输出帧头符合 320 kbps / 44.1 kHz', async () => {
    if (!globalThis.lamejs) return;

    const result = await WavToMp3.wavToMp3(toArrayBuffer(makeWav({ frames: 44100 })), { bitrate: 320 });
    const header = readMp3Header(result.data);

    assert.ok(header, '应能找到 MPEG 同步帧');
    assert.strictEqual(header.mpeg, 1);
    assert.strictEqual(header.sampleRate, 44100);
    assert.strictEqual(header.bitrate, 320);
    assert.strictEqual(result.bitrate, 320);
});

test('单声道输入输出单声道 MP3', async () => {
    if (!globalThis.lamejs) return;

    const result = await WavToMp3.wavToMp3(toArrayBuffer(makeWav({ channels: 1, frames: 22050 })), { bitrate: 320 });

    assert.strictEqual(readMp3Header(result.data).mode, 'mono');
});

test('低采样率自动收敛码率', async () => {
    if (!globalThis.lamejs) return;

    const result = await WavToMp3.wavToMp3(toArrayBuffer(makeWav({ sampleRate: 22050, frames: 22050 })), { bitrate: 320 });

    assert.strictEqual(result.bitrate, 160);
    assert.strictEqual(result.bitrateLimited, true);
    assert.strictEqual(readMp3Header(result.data).bitrate, 160);
    assert.strictEqual(readMp3Header(result.data).mpeg, 2);
});

test('96 kHz 立体声 24 bit 端到端时长正确', async () => {
    if (!globalThis.lamejs) return;

    const seconds = 2;
    const result = await WavToMp3.wavToMp3(toArrayBuffer(makeWav({
        sampleRate: 96000,
        bitsPerSample: 24,
        frames: 96000 * seconds
    })), { bitrate: 320 });

    const header = readMp3Header(result.data);

    assert.strictEqual(header.sampleRate, 48000, 'MP3 采样率应为 48 kHz');
    assert.strictEqual(header.bitrate, 320);

    const duration = result.data.length / (320 * 1000 / 8);

    // 编码器首尾会有约 1 帧的延迟填充，允许 10% 误差
    assert.ok(Math.abs(duration - seconds) / seconds < 0.1, `时长应约 ${seconds}s，实际 ${duration.toFixed(2)}s`);
});

test('非整块长度（不足 1152 样本收尾）时长正确', async () => {
    if (!globalThis.lamejs) return;

    // 3.7 秒 = 163170 样本，除以 1152 不是整数，最后一块只有 324 个样本
    const seconds = 3.7;
    const frames = Math.round(44100 * seconds);
    const result = await WavToMp3.wavToMp3(toArrayBuffer(makeWav({ frames })), { bitrate: 320 });

    const duration = result.data.length / (320 * 1000 / 8);

    assert.ok(
        Math.abs(duration - seconds) / seconds < 0.05,
        `时长应约 ${seconds}s，实际 ${duration.toFixed(2)}s（收尾样本可能被丢弃）`
    );
});

test('缺少 lamejs 时报错友好', async () => {
    if (!globalThis.lamejs) return;

    const saved = globalThis.lamejs;

    delete globalThis.lamejs;

    try {
        await assert.rejects(
            () => WavToMp3.wavToMp3(toArrayBuffer(makeWav({ frames: 1152 })), { bitrate: 320 }),
            /lamejs/
        );
    } finally {
        globalThis.lamejs = saved;
    }
});

// --- 运行 ---

async function loadLamejs() {
    const cacheFile = path.join(os.tmpdir(), 'vtt-to-lrc-lamejs', 'lame.min.js');

    try {
        if (!fs.existsSync(cacheFile)) {
            const response = await fetch(LAME_URL);

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
            fs.writeFileSync(cacheFile, Buffer.from(await response.arrayBuffer()));
        }

        const context = { console };

        vm.createContext(context);
        vm.runInContext(fs.readFileSync(cacheFile, 'utf8'), context);

        globalThis.lamejs = context.lamejs;

        return true;
    } catch (error) {
        console.log(`⚠ 无法加载 lamejs（${error.message}），跳过编码相关测试。\n`);
        return false;
    }
}

async function main() {
    const lameReady = await loadLamejs();

    for (const item of tests) {
        if (item.skip) {
            skipped++;
            continue;
        }

        if (!lameReady && /MP3|编码|lamejs|96 kHz/.test(item.name)) {
            skipped++;
            continue;
        }

        try {
            await item.fn();
            passed++;
            console.log(`  ✓ ${item.name}`);
        } catch (error) {
            failed++;
            console.log(`  ✗ ${item.name}`);
            console.log(`      ${error.message}`);
        }
    }

    console.log(`\n通过 ${passed}，失败 ${failed}，跳过 ${skipped}`);

    process.exit(failed === 0 ? 0 : 1);
}

main();
