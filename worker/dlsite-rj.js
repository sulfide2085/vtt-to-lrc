/**
 * DLsite RJ 元数据中转 Worker
 *
 * 为什么需要它：DLsite 的 JSON 接口 https://www.dlsite.com/maniax/api/=/product.json?workno=RJxxxxxx
 * 不给任何 CORS 头，浏览器直连会被拦截（实测带 Origin 请求也没有 access-control-*）。
 * 这个 Worker 在 Cloudflare 网络上代为请求，再把精简后的 JSON 连同 CORS 头返回给网页。
 *
 * 封面图不需要经过这里：img.dlsite.jp 返回 Access-Control-Allow-Origin: *，
 * 网页可以直接把图片抓下来塞进 ID3。所以这个 Worker 只搬运几百字节的元数据。
 *
 * 内置 24 小时缓存：DLsite 的接口对请求频率敏感（连发十几次就会被丢连接），
 * 同一个 RJ 只会真正回源一次。
 *
 * 部署：见同目录 README.md
 */

const DLSITE_API = 'https://www.dlsite.com/maniax/api/=/product.json';
const CACHE_SECONDS = 60 * 60 * 24;

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
};

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: Object.assign({
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=3600'
        }, CORS_HEADERS)
    });
}

/** 把 DLsite 返回的各种图片字段统一成 https 绝对地址 */
function pickImageUrl(image) {
    const raw = image && typeof image === 'object'
        ? (image.url || image.relative_url || '')
        : (typeof image === 'string' ? image : '');

    if (!raw) return '';
    if (raw.startsWith('http')) return raw;
    if (raw.startsWith('//')) return `https:${raw}`;

    return `https://img.dlsite.jp/${raw.replace(/^\/+/, '')}`;
}

/** creaters 里的字段有时是数组、有时是单个对象，统一成名字数组 */
function pickNames(value) {
    if (Array.isArray(value)) {
        return value.map(item => item && item.name).filter(Boolean);
    }

    return value && value.name ? [value.name] : [];
}

export default {
    async fetch(request) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        if (request.method !== 'GET') {
            return jsonResponse({ ok: false, error: '只支持 GET' }, 405);
        }

        const raw = (url.searchParams.get('rj') || url.searchParams.get('workno') || '').trim();
        const rj = raw.toUpperCase().replace(/^([^R])/, 'RJ$1').replace(/^RJ\s*/, 'RJ');

        if (!/^RJ\d{6,8}$/.test(rj)) {
            return jsonResponse({ ok: false, error: 'RJ 号格式不对，应形如 RJ344794 或 RJ01014447' }, 400);
        }

        // 缓存：同一个 RJ 一天内只回源一次
        const cache = caches.default;
        const cacheKey = new Request(`https://rj-metadata.cache/${rj}`, { method: 'GET' });
        const cached = await cache.match(cacheKey);

        if (cached) {
            const body = await cached.text();

            return new Response(body, {
                status: 200,
                headers: Object.assign({
                    'Content-Type': 'application/json; charset=utf-8',
                    'X-RJ-Cache': 'HIT'
                }, CORS_HEADERS)
            });
        }

        let upstream;

        try {
            upstream = await fetch(`${DLSITE_API}?workno=${encodeURIComponent(rj)}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8',
                    'Referer': `https://www.dlsite.com/maniax/work/=/product_id/${rj}.html`
                }
            });
        } catch (error) {
            return jsonResponse({ ok: false, error: `连接 DLsite 失败：${error.message}` }, 502);
        }

        if (!upstream.ok) {
            return jsonResponse({ ok: false, error: `DLsite 返回 HTTP ${upstream.status}（可能是限流，稍后再试）` }, 502);
        }

        let list;

        try {
            list = await upstream.json();
        } catch {
            return jsonResponse({ ok: false, error: 'DLsite 返回的不是 JSON（可能被风控页面替换了）' }, 502);
        }

        if (!Array.isArray(list) || list.length === 0) {
            return jsonResponse({ ok: false, error: 'DLsite 上没有找到这个 RJ 号' }, 404);
        }

        const product = list[0];
        const creaters = product.creaters || {};
        const genres = Array.isArray(product.genres)
            ? product.genres.map(genre => genre && genre.name).filter(Boolean)
            : [];

        const payload = {
            ok: true,
            rj: product.workno || rj,
            title: product.work_name || '',
            titleKana: product.work_name_kana || '',
            circle: product.maker_name || product.brand_name || '',
            voiceBy: pickNames(creaters.voice_by),
            scenarioBy: pickNames(creaters.scenario_by),
            illustBy: pickNames(creaters.illust_by),
            musicBy: pickNames(creaters.music_by),
            genres,
            workType: product.work_type_string || '',
            fileType: product.file_type_string || product.file_type || '',
            ageCategory: product.age_category_string || '',
            releaseDate: String(product.regist_date || '').slice(0, 10),
            coverUrl: pickImageUrl(product.image_main),
            coverThumbUrl: pickImageUrl(product.image_thumb),
            pageUrl: `https://www.dlsite.com/maniax/work/=/product_id/${product.workno || rj}.html`
        };

        const body = JSON.stringify(payload);

        // 只缓存成功结果，失败不缓存（避免把偶发限流记住一天）
        await cache.put(cacheKey, new Response(body, {
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': `public, max-age=${CACHE_SECONDS}`
            }
        }));

        return new Response(body, {
            status: 200,
            headers: Object.assign({
                'Content-Type': 'application/json; charset=utf-8',
                'X-RJ-Cache': 'MISS'
            }, CORS_HEADERS)
        });
    }
};
