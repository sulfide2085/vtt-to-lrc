# VTT to LRC 转换工具

批量将 VTT 字幕文件转换为 LRC 歌词文件，并把 WAV 音频转码为高质量 MP3 的在线工具，纯前端实现，无需后端服务。

## 功能

- **两种上传模式**：直接上传多个 VTT 文件，或上传 ZIP 压缩包
- **批量转换**：一次性处理多个文件，输出为 ZIP 下载
- **WAV 转 MP3**：独立标签页，把 WAV 转码为最高 **320 kbps CBR** 的 MP3（MPEG-1 Layer III）
- **ZIP 内自动转码**：ZIP 模式可勾选把包内 WAV 一并转码为 MP3，体积通常缩小约 80%
- **MP3 封面嵌入**：可从包内选择图片（或单独上传）作为封面，自动写入 MP3 的 ID3v2 标签
- **无 VTT 也能用**：ZIP 内没有 VTT 文件时，仍可单独为 MP3 嵌入封面并下载
- **平铺选项**：ZIP 模式可将所有文件输出到根目录，重名时自动添加路径前/后缀
- **智能文件夹命名**：输出 ZIP 内自动以原包前两层目录合并命名文件夹（如 `输入压缩包名称_示例作品名称/`）
- **文件保留**：ZIP 模式下自动保留非 VTT 文件（如 MP3、图片）
- **智能命名**：自动处理 `文件名.mp3.vtt` 等复合后缀；`歌曲.wav` + `歌曲.wav.vtt` 会输出同名的 `歌曲.mp3` 与 `歌曲.lrc`

## 使用方式

直接用浏览器打开 `index.html` 即可使用，无需安装任何依赖。

```bash
# 如需本地预览
python -m http.server 8080
# 然后访问 http://localhost:8080
```

## WAV 转 MP3 说明

| 项目 | 说明 |
| --- | --- |
| 支持输入 | PCM 8 / 16 / 24 / 32 bit、IEEE float 32 / 64 bit、`WAVE_FORMAT_EXTENSIBLE`，单声道 / 立体声 / 多声道（多声道会下混为立体声） |
| 编码器 | [lamejs](https://github.com/zhuker/lamejs)（LAME 3.x 的 JS 移植），全程在浏览器本地完成，文件不会上传 |
| 码率 | 固定 **320 kbps CBR**。WAV 是无损 PCM，等效码率（CD 音质约 1411 kbps）远高于 320，没有"源码率"可继承，因此不提供码率选择；只有采样率过低时才会自动降到上限（见下） |
| 采样率 | lamejs 仅支持 8k / 11.025k / 12k / 16k / 22.05k / 24k / 32k / 44.1k / 48k；其它采样率（如 96k / 192k）会自动重采样到最接近的受支持采样率，避免变速变调 |
| 码率上限 | 采样率 ≥ 32 kHz 为 320 kbps；16–24 kHz 上限 160 kbps；≤ 12 kHz 上限 64 kbps，超出会自动收敛并在进度里提示 |
| 已压缩音频 | ZIP 内已有的 MP3 不会被重新编码，只按需写入封面，原码率保持不变 |
| 速度 | 约 6–10 倍实时（44.1 kHz 立体声 320 kbps 每分钟约 9 秒），转码时显示进度条 |

## 文件结构

```
index.html              — 页面结构
styles.css              — 样式
app.js                  — 界面交互、VTT→LRC、ID3 封面写入、ZIP 打包
audio.js                — WAV 解析 / 重采样 / MP3 编码核心（不依赖 DOM）
tests/wav-to-mp3.test.js — 转码核心单元测试（零依赖）
tests/browser-e2e.js     — 真实浏览器端到端测试（需要本机 Chrome/Edge）
```

## 测试

```bash
node tests/wav-to-mp3.test.js   # 19 项：解析、位深、重采样、码率收敛、MP3 帧头
node tests/browser-e2e.js       # 41 项：真实 Chrome 驱动页面，含真实下载与 ID3 封面校验

# 也可以直接测线上站点（部署后冒烟验证）
node tests/browser-e2e.js https://sulfide2085.github.io/vtt-to-lrc/
```

两个脚本都不需要安装依赖：单元测试会在首次运行时把 lamejs 缓存到系统临时目录；端到端测试找不到 Chrome/Edge 时会自动跳过。

## 技术栈

- Tailwind CSS（CDN）
- JSZip（CDN）
- lamejs（CDN）
- 原生 JavaScript

## LRC 格式说明

输出的 LRC 文件格式为 `[MM:SS.xx]歌词文本`，支持小时级时间戳。

## 许可

MIT
