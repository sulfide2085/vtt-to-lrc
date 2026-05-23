# VTT to LRC 转换工具

批量将 VTT 字幕文件转换为 LRC 歌词文件的在线工具，纯前端实现，无需后端服务。

## 功能

- **两种上传模式**：直接上传多个 VTT 文件，或上传 ZIP 压缩包
- **批量转换**：一次性处理多个文件，输出为 ZIP 下载
- **文件保留**：ZIP 模式下自动保留非 VTT 文件（如 MP3）
- **智能命名**：自动处理 `文件名.mp3.vtt` 等复合后缀

## 使用方式

直接用浏览器打开 `index.html` 即可使用，无需安装任何依赖。

```bash
# 如需本地预览
python -m http.server 8080
# 然后访问 http://localhost:8080
```

## 文件结构

```
index.html    — 页面结构
styles.css    — 样式
app.js        — 转换逻辑与交互
```

## 技术栈

- Tailwind CSS（CDN）
- JSZip（CDN）
- 原生 JavaScript

## LRC 格式说明

输出的 LRC 文件格式为 `[MM:SS.xx]歌词文本`，支持小时级时间戳。

## 许可

MIT
