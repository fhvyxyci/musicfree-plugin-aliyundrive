/**
 * MusicFree 插件 —— 阿里云盘
 * Copyright (C) 2026 fhvyxyci
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * ---------------------------------------------------------------------------
 *
 * 数据来源：阿里云盘官方开放平台 API（https://openapi.alipan.com）
 * 接口路径与参数依据：
 *   - 阿里云盘官方开源 SDK（alibaba/aliyunpan-ios-sdk 的 AliyunpanScope）
 *   - OpenList 的 drivers/aliyundrive_open 驱动
 *   - OpenList 令牌服务 OpenListTeam/OpenList-APIPages
 *
 * 用户信息通过 userVariables 存储：刷新令牌 / 音乐目录 / 云盘类型 /
 * 客户端ID / 客户端密钥 / 令牌刷新服务地址
 *
 * 提供的入口：
 *   - 搜索（单曲 / 专辑 / 歌单）—— 专辑与歌单按「文件夹」呈现，内容一致
 *   - 排行榜（全部歌曲 / 按目录浏览）
 *   - 推荐歌单（全部文件夹）
 */

const axios = require('axios');

/* ============================ 常量 ============================ */

const OPEN_API = 'https://openapi.alipan.com';
// OpenList 提供的公共令牌刷新服务（未填写自有 clientId/clientSecret 时使用）
const DEFAULT_RENEW_API = 'https://api.oplist.org/alicloud/renewapi';
// 备用刷新通道：对应 api.oplist.org 的「阿里云盘 直接登录」扫码流程
const FALLBACK_RENEW_API = 'https://api.oplist.org/alicloud2/renewapi';

// 「全部歌曲」虚拟榜单的 ID
const ALL_SONGS_ID = '__ALL_SONGS__';
// 推荐歌单页「全部文件夹」标签的 ID
const ALL_FOLDERS_TAG = '__ALL_FOLDERS__';
// 歌单 / 专辑条目 ID 的前缀（形如 folder:<driveId>:<fileId>）
const FOLDER_PREFIX = 'folder:';

// 视为音频的扩展名
const AUDIO_EXT = [
  'mp3', 'flac', 'm4a', 'aac', 'wav', 'ape', 'ogg', 'oga', 'opus',
  'wma', 'm4b', 'aiff', 'aif', 'dsf', 'dff', 'tak', 'wv', 'mp2',
  'mka', 'amr', 'ac3', 'dts', 'mid', 'midi', 'ra', 'caf', 'alac',
];
// 视为歌词的扩展名
const LYRIC_EXT = ['lrc'];

const PAGE_SIZE = 100;        // 阿里云盘单页上限 100
const SHEET_PAGE_SIZE = 30;   // 歌单 / 专辑列表每页条数
const URL_EXPIRE_SEC = 14400; // 下载直链有效期（秒），官方上限 4 小时
const REQUEST_TIMEOUT = 8000; // 单次请求超时（沙箱整体限时较紧）
const WALK_BUDGET_MS = 6000;  // 递归遍历的单次时间预算

// 全局请求最小间隔：官方开放平台对短时间内的密集请求会返回 TooManyRequests
// （实测连发约 40 次即被限流，需等待约 7 秒），这里主动降速规避
const MIN_REQUEST_INTERVAL = 200;
// 单次限流等待上限
const MAX_RATE_LIMIT_WAIT = 8000;

// 云盘类型 -> getDriveInfo 返回的字段
const DRIVE_FIELD = {
  default: 'default_drive_id',
  resource: 'resource_drive_id',
  backup: 'backup_drive_id',
};

/* ============================ 运行时缓存 ============================ */

// 插件实例在应用运行期间常驻，模块级变量可以跨方法调用保存状态
const cache = {
  signature: '',
  // 当前生效的刷新令牌（会随刷新滚动更新，仅存在于内存中）
  refreshToken: '',
  accessToken: '',
  accessTokenExpireAt: 0,
  // 云盘信息
  driveInfo: null,
  userName: '',
  // 音乐根目录（{driveId, fileId, name, path, parentPath}）
  roots: null,
  // file_id -> drive_id，便于只拿到 id 时也能定位到正确的云盘
  fileDrive: {},
  // 搜索是否支持 category 条件（首次探测后固定）
  categoryQuerySupported: true,
  // 单曲搜索的分页游标
  searchKey: '',
  searchMarkers: {},
  // 排行榜（按目录浏览）的分页游标
  topListKey: '',
  topListMarkers: {},
  // 歌单 / 专辑（按文件夹）的分页游标
  sheetKey: '',
  sheetMarkers: {},
  folderNameCache: {},
  // 递归遍历状态，可跨多次调用续跑
  crawl: null,
};

/* ============================ 工具函数 ============================ */

function extOf(name) {
  const str = String(name == null ? '' : name);
  const idx = str.lastIndexOf('.');
  return idx > 0 ? str.slice(idx + 1) : '';
}

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

// 兼容接口返回的两种命名风格（外层 snake_case，内层 camelCase）
function pick(obj, keys) {
  for (let i = 0; i < keys.length; i++) {
    const v = obj ? obj[keys[i]] : undefined;
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

// 过滤阿里云盘搜索语法中的引号，避免语句被截断
function escapeQueryValue(v) {
  return trimStr(v).replace(/['"\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 清洗用户粘贴的刷新令牌：去掉换行、空格与可能被一起复制的引号 / 花括号。
 */
function sanitizeToken(raw) {
  let s = trimStr(raw);
  if (!s) return '';
  s = s.replace(/[\s"'`]/g, '');
  s = s.replace(/^\{+/, '').replace(/\}+$/, '');
  s = s.replace(/^refresh_?token:?/i, '');
  s = s.replace(/^token:?/i, '');
  s = s.replace(/[,;]+$/, '');
  return s;
}

function isAudioFile(file) {
  if (!file || file.type !== 'file') return false;
  const ext = (file.file_extension || file.fileExtension || extOf(file.name)).toLowerCase();
  if (AUDIO_EXT.indexOf(ext) >= 0) return true;
  return file.category === 'audio';
}

function isLyricFile(file) {
  if (!file || file.type !== 'file') return false;
  const ext = (file.file_extension || file.fileExtension || extOf(file.name)).toLowerCase();
  return LYRIC_EXT.indexOf(ext) >= 0;
}

// 从文件名解析歌手/歌名：常见命名 "歌手 - 歌名"，
// 若连字符左侧只是音轨号（如 "01 - xxx"），则不当作歌手
function parseFileName(fileName) {
  const ext = extOf(fileName);
  const base = trimStr(ext ? fileName.slice(0, fileName.length - ext.length - 1) : fileName);
  const idx = base.indexOf(' - ');
  if (idx > 0) {
    const left = trimStr(base.slice(0, idx));
    if (/^\d{1,3}$/.test(left)) {
      return { artist: '', title: trimStr(base.replace(/^\d{1,3}\s*[-._)]\s*/, '')) };
    }
    return { artist: left, title: trimStr(base.slice(idx + 3)) };
  }
  return { artist: '', title: base };
}

function toNumber(v) {
  const n = parseFloat(v);
  return isNaN(n) ? undefined : Math.round(n);
}

function errorText(e) {
  if (!e) return '未知错误';
  const resp = e.response;
  if (resp && resp.data) {
    const d = resp.data;
    if (typeof d === 'string') return d.slice(0, 200);
    if (d.message) return (d.code ? d.code + ': ' : '') + d.message;
    if (d.text) return String(d.text);
  }
  return e.message ? String(e.message) : String(e);
}

function isRateLimited(e) {
  const t = errorText(e);
  return t.indexOf('TooManyRequests') >= 0 || t.indexOf('请求过快') >= 0;
}

// 限流或网络抖动，属于「可以稍后重试」的错误
function isRetryable(e) {
  if (isRateLimited(e)) return true;
  const t = String((e && e.message) || '');
  return /timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|Network Error/i.test(t);
}

// 从 "请求过快，请等待 5407 毫秒后再请求" 中取出等待时长
function parseWaitMs(e) {
  const m = errorText(e).match(/(\d+)\s*毫秒/);
  if (m) return Math.min(parseInt(m[1], 10), MAX_RATE_LIMIT_WAIT);
  return 1500;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// 全局节流：保证相邻请求之间有最小间隔
let lastRequestAt = 0;
async function pace() {
  const wait = MIN_REQUEST_INTERVAL - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

/* ============================ 用户变量与令牌 ============================ */

function readVars() {
  let raw = {};
  try {
    if (typeof env !== 'undefined' && env && typeof env.getUserVariables === 'function') {
      raw = env.getUserVariables() || {};
    }
  } catch (e) {
    raw = {};
  }
  return {
    refreshToken: sanitizeToken(raw.refreshToken),
    clientId: trimStr(raw.clientId),
    clientSecret: trimStr(raw.clientSecret),
    folderId: trimStr(raw.folderId) || 'root',
    driveType: (trimStr(raw.driveType) || 'all').toLowerCase(),
    renewApi: trimStr(raw.renewApi) || DEFAULT_RENEW_API,
  };
}

// 用户改了配置就清空所有缓存，避免旧账号的数据串台
function syncVars() {
  const vars = readVars();
  const signature = vars.refreshToken + '|' + vars.clientId + '|' + vars.clientSecret;
  if (cache.signature !== signature) {
    cache.signature = signature;
    cache.refreshToken = vars.refreshToken;
    cache.accessToken = '';
    cache.accessTokenExpireAt = 0;
    cache.driveInfo = null;
    cache.userName = '';
    cache.roots = null;
    cache.fileDrive = {};
    cache.searchKey = '';
    cache.searchMarkers = {};
    cache.topListKey = '';
    cache.topListMarkers = {};
    cache.sheetKey = '';
    cache.sheetMarkers = {};
    cache.folderNameCache = {};
    cache.crawl = null;
  }
  return vars;
}

function buildRefreshAttempts(vars, refreshToken) {
  const attempts = [];
  // 方式一：自建应用，直接向上游 OAuth2 接口刷新（令牌不经过任何第三方）
  if (vars.clientId && vars.clientSecret) {
    attempts.push({
      kind: 'oauth',
      url: OPEN_API + '/oauth/access_token',
      body: {
        client_id: vars.clientId,
        client_secret: vars.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      },
    });
  }
  // 方式二：OpenList 公共刷新服务（对应 api.oplist.org 的「阿里云盘 应用登录」）
  const renewList = [vars.renewApi];
  if (renewList.indexOf(DEFAULT_RENEW_API) < 0) renewList.push(DEFAULT_RENEW_API);
  if (renewList.indexOf(FALLBACK_RENEW_API) < 0) renewList.push(FALLBACK_RENEW_API);
  for (let i = 0; i < renewList.length; i++) {
    const isDefault = renewList[i] === DEFAULT_RENEW_API;
    attempts.push({
      kind: 'renew',
      url: renewList[i],
      // 公共服务的 server_use=true 表示使用 OpenList 内置的应用凭据
      params: isDefault
        ? { refresh_ui: refreshToken, server_use: 'true', driver_txt: 'alicloud_qr' }
        : { refresh_ui: refreshToken },
    });
  }
  return attempts;
}

/**
 * 换取 access_token。
 *
 * 阿里云盘的 refresh_token 刷新后会滚动更新（旧令牌仍可用一段时间，新令牌 90 天有效），
 * 而 MusicFree 的用户变量是只读的，无法把新令牌写回配置，
 * 因此把最新令牌保存在内存中，在同一次运行期间持续接力使用。
 */
async function fetchAccessToken(useCachedFirst) {
  const vars = syncVars();

  const tokens = [];
  if (useCachedFirst && cache.refreshToken) tokens.push(cache.refreshToken);
  if (vars.refreshToken && tokens.indexOf(vars.refreshToken) < 0) tokens.push(vars.refreshToken);
  if (!tokens.length) {
    throw new Error('未配置刷新令牌：请先在本插件设置中填写「刷新令牌 (refresh_token)」');
  }

  const failures = [];
  for (let t = 0; t < tokens.length; t++) {
    const attempts = buildRefreshAttempts(vars, tokens[t]);
    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];
      try {
        let res;
        if (attempt.kind === 'oauth') {
          res = await axios.post(attempt.url, attempt.body, {
            headers: { 'Content-Type': 'application/json' },
            timeout: REQUEST_TIMEOUT,
          });
        } else {
          res = await axios.get(attempt.url, {
            params: attempt.params,
            timeout: REQUEST_TIMEOUT,
          });
        }
        const d = res.data || {};
        const accessToken = d.access_token || '';
        if (!accessToken) {
          throw new Error(d.text || d.message || d.code || '返回内容中没有 access_token');
        }
        const expiresIn = Number(d.expires_in) > 0 ? Number(d.expires_in) : 7200;
        cache.accessToken = accessToken;
        // 预留 60 秒安全边界
        cache.accessTokenExpireAt = Date.now() + (expiresIn - 60) * 1000;
        cache.refreshToken = d.refresh_token || tokens[t];
        return accessToken;
      } catch (e) {
        failures.push(errorText(e));
      }
    }
  }
  // 报第一条错误：它来自主通道，最能说明问题（后续通道的报错往往是连带的）
  const reason = failures.length ? failures[0] : '未知错误';
  const extra = failures.length > 1 ? '（共尝试 ' + failures.length + ' 个刷新通道）' : '';
  throw new Error(
    '刷新令牌失败：' + reason + extra +
    '。请到 api.oplist.org 重新获取「刷新令牌」（驱动选“阿里云盘 应用登录”并勾选“使用官方参数”），' +
    '或填写自建应用的客户端ID与应用密钥'
  );
}

async function getAccessToken(force) {
  if (!force && cache.accessToken && Date.now() < cache.accessTokenExpireAt) {
    return cache.accessToken;
  }
  return fetchAccessToken(!!force);
}

/**
 * 统一请求封装：
 *   - 自动带 token
 *   - token 失效时刷新并重试一次
 *   - 遇到 TooManyRequests 时按服务端建议等待后重试一次
 */
async function api(uri, body, retried, rateRetried) {
  syncVars();
  const accessToken = await getAccessToken(false);
  await pace();
  let res;
  try {
    res = await axios.post(OPEN_API + uri, body || {}, {
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT,
    });
  } catch (e) {
    const resp = e && e.response;
    const code = resp && resp.data && resp.data.code;
    const status = resp && resp.status;

    if (code === 'TooManyRequests' && !rateRetried) {
      await sleep(parseWaitMs(e));
      return api(uri, body, retried, true);
    }

    const tokenExpired =
      code === 'AccessTokenInvalid' ||
      code === 'AccessTokenExpired' ||
      code === 'I400JD' ||
      status === 401;
    if (!retried && tokenExpired) {
      await getAccessToken(true);
      return api(uri, body, true, rateRetried);
    }
    throw new Error(errorText(e));
  }
  const data = res && res.data;
  if (data && data.code) {
    if (data.code === 'TooManyRequests' && !rateRetried) {
      await sleep(parseWaitMs({ response: { data: data } }));
      return api(uri, body, retried, true);
    }
    throw new Error(data.code + ': ' + (data.message || '请求失败'));
  }
  return data || {};
}

/* ============================ 云盘信息 ============================ */

async function getDriveInfoRaw() {
  if (cache.driveInfo) return cache.driveInfo;
  const data = await api('/adrive/v1.0/user/getDriveInfo', {});
  cache.driveInfo = data || {};
  cache.userName = data.name || '';
  return cache.driveInfo;
}

function driveLabel(driveId, info) {
  if (info && driveId === info.resource_drive_id) return '资源库';
  if (info && driveId === info.backup_drive_id && driveId !== info.default_drive_id) return '备份盘';
  return '';
}

// 按「云盘类型」得到要访问的 drive_id 列表（all = 所有可用云盘）
async function getDriveIds() {
  const vars = syncVars();
  const info = await getDriveInfoRaw();
  let ids;
  if (vars.driveType === 'all') {
    ids = [info.default_drive_id, info.resource_drive_id, info.backup_drive_id];
  } else {
    const field = DRIVE_FIELD[vars.driveType] || 'default_drive_id';
    ids = [info[field] || info.default_drive_id];
  }
  const uniq = [];
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] && uniq.indexOf(ids[i]) < 0) uniq.push(ids[i]);
  }
  if (!uniq.length) throw new Error('无法获取云盘 ID，请在插件设置里检查「云盘类型」');
  return uniq;
}

async function getDriveId() {
  const ids = await getDriveIds();
  return ids[0];
}

// 音乐目录支持三种写法：root / 目录 ID / 以 / 开头的路径
async function resolveFolderIdOnDrive(driveId, raw) {
  const value = trimStr(raw);
  if (!value || value === 'root' || value === '/') return 'root';
  if (value.charAt(0) === '/') {
    const data = await api('/adrive/v1.0/openFile/get_by_path', {
      drive_id: driveId,
      file_path: value,
    });
    if (!data.file_id) throw new Error('找不到目录 ' + value);
    return data.file_id;
  }
  return value;
}

function configuredRoots(vars) {
  const list = vars.folderId
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return !!s; });
  return list.length ? list : ['root'];
}

/**
 * 解析出所有音乐根目录。
 * 返回 { roots: [{driveId, fileId, name, path, parentPath}], problems: [失败说明] }。
 * 全部失败时抛错（把真实原因暴露出来，而不是悄悄回退到根目录）。
 */
async function resolveRoots(vars) {
  if (cache.roots && cache.roots.length) return { roots: cache.roots, problems: [] };

  const info = await getDriveInfoRaw();
  const driveIds = await getDriveIds();
  const configured = configuredRoots(vars);
  const roots = [];
  const problems = [];

  for (let d = 0; d < driveIds.length; d++) {
    for (let r = 0; r < configured.length; r++) {
      const label = driveLabel(driveIds[d], info);
      try {
        const fileId = await resolveFolderIdOnDrive(driveIds[d], configured[r]);
        roots.push({ driveId: driveIds[d], fileId: fileId, label: label });
      } catch (e) {
        // 多盘模式下某个盘没有该目录属于正常现象，记账但不算失败
        problems.push('[' + (label || '默认云盘') + '] ' + configured[r] + '：' + errorText(e));
      }
    }
  }

  if (!roots.length) {
    throw new Error(
      '音乐目录无法访问 —— ' + problems.join('；') +
      '。请在插件设置里检查「音乐目录」和「云盘类型」（文件在资源库就选 resource，在备份盘就选 backup）'
    );
  }

  // 补上目录名与展示路径（歌单/专辑用它作为名称与父级说明）
  for (let i = 0; i < roots.length; i++) {
    const driveName = roots[i].label || '我的云盘';
    if (roots[i].fileId === 'root') {
      // 根目录直接用云盘名，避免出现「我的云盘 / 根目录」这种冗余
      roots[i].name = driveName;
      roots[i].path = driveName;
    } else {
      try {
        roots[i].name = await getFolderName(roots[i].driveId, roots[i].fileId);
      } catch (e) {
        roots[i].name = roots[i].fileId;
      }
      roots[i].path = driveName + ' / ' + roots[i].name;
    }
    roots[i].parentPath = driveName;
  }

  cache.roots = roots;
  return { roots: roots, problems: problems };
}

async function getFolderName(driveId, folderId) {
  if (folderId === 'root') return '根目录';
  const key = driveId + '|' + folderId;
  if (cache.folderNameCache[key]) return cache.folderNameCache[key];
  const data = await api('/adrive/v1.0/openFile/get', {
    drive_id: driveId,
    file_id: folderId,
  });
  const name = data.name || folderId;
  cache.folderNameCache[key] = name;
  return name;
}

/* ============================ 数据转换 ============================ */

function toMusicItem(file, driveId) {
  const fileName = file.name || '';
  const ext = (file.file_extension || file.fileExtension || extOf(fileName)).toLowerCase();

  // 优先使用云盘内嵌的音乐元数据
  // 注意：外层字段是 snake_case，内层却是 camelCase，两种都兼容
  const preview = file.video_preview_metadata || file.videoPreviewMetadata || {};
  const musicMeta = preview.audio_music_meta || preview.audioMusicMeta || {};
  const audioMeta = preview.audio_meta || preview.audioMeta || {};
  const mediaMeta = file.video_media_metadata || file.videoMediaMetadata || {};

  const parsed = parseFileName(fileName);

  // 文件里带了内嵌标签时以标签为准；此时不再拿文件名去猜歌手，
  // 否则 "01 - Scarlet -arr-.flac" 这种命名会把音轨号/歌名误当成歌手
  const tagged = !!trimStr(pick(musicMeta, ['title']));

  const title = trimStr(pick(musicMeta, ['title'])) || parsed.title || fileName;
  const artist = trimStr(pick(musicMeta, ['artist'])) || (tagged ? '' : parsed.artist) || '未知歌手';
  const album = trimStr(pick(musicMeta, ['album'])) || '未知专辑';
  const artwork =
    trimStr(pick(musicMeta, ['coverUrl', 'cover_url'])) ||
    trimStr(pick(preview, ['thumbnail'])) ||
    trimStr(file.thumbnail);

  let duration = toNumber(pick(preview, ['duration']));
  if (!duration) duration = toNumber(pick(audioMeta, ['duration']));
  if (!duration) duration = toNumber(pick(mediaMeta, ['duration']));

  if (file.file_id && driveId) cache.fileDrive[file.file_id] = driveId;

  return {
    id: file.file_id,
    title: title,
    artist: artist,
    album: album,
    artwork: artwork || undefined,
    duration: duration,
    // 扩展字段：供 getMediaSource / getLyric 复用，避免重复请求
    fileName: fileName,
    parentId: file.parent_file_id,
    fileExt: ext,
    driveId: driveId,
  };
}

function driveOfItem(item) {
  if (item && item.driveId) return item.driveId;
  if (item && item.id && cache.fileDrive[item.id]) return cache.fileDrive[item.id];
  return '';
}

/* ============================ 搜索（单曲） ============================ */

// 在单个云盘上搜索一页
async function searchOnDrive(driveId, keyword, marker) {
  const base = "name match '" + keyword + "'";
  const run = function (query) {
    const body = {
      drive_id: driveId,
      limit: PAGE_SIZE,
      query: query,
      order_by: 'name ASC',
      fields: '*',
    };
    if (marker) body.marker = marker;
    return api('/adrive/v1.0/openFile/search', body);
  };
  if (cache.categoryQuerySupported) {
    try {
      return await run(base + " and category = 'audio'");
    } catch (e) {
      // 该条件不被支持时永久降级，避免每次搜索都失败一次
      cache.categoryQuerySupported = false;
    }
  }
  return run(base);
}

async function searchMusic(query, page) {
  const driveIds = await getDriveIds();
  const keyword = escapeQueryValue(query);
  if (!keyword) return { isEnd: true, data: [] };

  if (cache.searchKey !== keyword) {
    cache.searchKey = keyword;
    cache.searchMarkers = {};
  }

  const currentPage = page > 0 ? page : 1;
  if (currentPage > 1 && !cache.searchMarkers[currentPage]) {
    return { isEnd: true, data: [] };
  }
  const markers = cache.searchMarkers[currentPage] || {};
  const nextMarkers = {};

  const list = [];
  for (let d = 0; d < driveIds.length; d++) {
    const driveId = driveIds[d];
    const marker = markers[driveId];
    // 从第 2 页起，已经搜完的云盘不再重复请求
    if (currentPage > 1 && !marker) continue;
    let data = null;
    try {
      data = await searchOnDrive(driveId, keyword, marker);
    } catch (e) {
      if (drivesExhausted(driveIds, markers) && !list.length) throw e;
      continue;
    }
    const items = (data && data.items) || [];
    for (let i = 0; i < items.length; i++) {
      if (isAudioFile(items[i])) list.push(toMusicItem(items[i], driveId));
    }
    const next = data && data.next_marker;
    if (next) nextMarkers[driveId] = next;
  }

  if (Object.keys(nextMarkers).length) cache.searchMarkers[currentPage + 1] = nextMarkers;
  return { isEnd: !Object.keys(nextMarkers).length, data: list };
}

function drivesExhausted(driveIds, markers) {
  for (let i = 0; i < driveIds.length; i++) {
    if (markers[driveIds[i]]) return false;
  }
  return true;
}

/* ============================ 递归遍历（全部歌曲 + 文件夹索引） ============================ */

function registerFolder(state, info) {
  const key = info.driveId + '|' + info.fileId;
  let f = state.folderMap[key];
  if (!f) {
    f = {
      driveId: info.driveId,
      fileId: info.fileId,
      name: info.name,
      path: info.path,
      parentPath: info.parentPath,
      worksNum: 0,
      artwork: '',
    };
    state.folderMap[key] = f;
    state.folderOrder.push(key);
  }
  return f;
}

function folderOf(state, driveId, fileId) {
  return state.folderMap[driveId + '|' + fileId];
}

// 含有音频的文件夹，按展示路径排序（结果稳定，可安全分页）
function folderList(state) {
  const out = [];
  for (let i = 0; i < state.folderOrder.length; i++) {
    const f = state.folderMap[state.folderOrder[i]];
    if (f && f.worksNum > 0) out.push(f);
  }
  out.sort(function (a, b) {
    if (a.path === b.path) return a.fileId < b.fileId ? -1 : 1;
    return a.path < b.path ? -1 : 1;
  });
  return out;
}

/**
 * 递归遍历音乐目录。一次遍历同时产出两份结果：
 *   - items    全部音频（「全部歌曲」榜单用）
 *   - folders  按文件夹分组（「歌单 / 专辑」按文件夹展示用）
 *
 * 遍历状态保存在 cache.crawl 中，可以跨多次方法调用续跑，
 * 每次最多消耗 WALK_BUDGET_MS 毫秒，避免触发沙箱超时（大曲库首次不会一次跑完）。
 */
async function crawlMusic(roots) {
  const signature = roots.map(function (r) { return r.driveId + ':' + r.fileId; }).join(',');
  if (!cache.crawl || cache.crawl.signature !== signature) {
    const state = {
      signature: signature,
      queue: [],
      cur: null,
      marker: undefined,
      items: [],
      folderMap: {},
      folderOrder: [],
      done: false,
      skipped: 0,
    };
    for (let i = 0; i < roots.length; i++) {
      const r = roots[i];
      registerFolder(state, {
        driveId: r.driveId,
        fileId: r.fileId,
        name: r.name || r.fileId,
        path: r.path || r.fileId,
        parentPath: r.parentPath || '我的云盘',
      });
      state.queue.push({ driveId: r.driveId, fileId: r.fileId, path: r.path || r.fileId });
    }
    cache.crawl = state;
  }
  const s = cache.crawl;
  const deadline = Date.now() + WALK_BUDGET_MS;

  while (!s.done) {
    if (!s.cur) {
      if (!s.queue.length) { s.done = true; break; }
      s.cur = s.queue.shift();
      s.marker = undefined;
    }
    if (Date.now() > deadline) break;

    const body = {
      drive_id: s.cur.driveId,
      parent_file_id: s.cur.fileId,
      limit: PAGE_SIZE,
      order_by: 'name',
      order_direction: 'ASC',
      fields: '*',
    };
    if (s.marker) body.marker = s.marker;

    let data;
    try {
      data = await api('/adrive/v1.0/openFile/list', body);
    } catch (e) {
      if (isRetryable(e)) {
        // 限流/网络抖动：保留当前目录，下次调用接着爬（不该被当成"空目录"）
        break;
      }
      // 该目录确实读不了（已删除/无权限），跳过
      s.cur = null;
      s.marker = undefined;
      s.skipped++;
      continue;
    }

    const folder = folderOf(s, s.cur.driveId, s.cur.fileId);
    const items = (data && data.items) || [];
    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      if (f.type === 'folder') {
        const parentPath = folder ? folder.path : s.cur.path;
        const childPath = parentPath + ' / ' + f.name;
        registerFolder(s, {
          driveId: s.cur.driveId,
          fileId: f.file_id,
          name: f.name,
          path: childPath,
          parentPath: parentPath,
        });
        s.queue.push({ driveId: s.cur.driveId, fileId: f.file_id, path: childPath });
      } else if (isAudioFile(f)) {
        const item = toMusicItem(f, s.cur.driveId);
        s.items.push(item);
        if (folder) {
          folder.worksNum++;
          if (!folder.artwork && item.artwork) folder.artwork = item.artwork;
        }
      }
    }
    s.marker = (data && data.next_marker) || undefined;
    if (!s.marker) s.cur = null;
  }
  return s;
}

/* ============================ 歌单 / 专辑（按文件夹） ============================ */

// 把文件夹转成歌单 / 专辑条目（两种类型内容一致，只是语义不同）
function toFolderSheetItem(f, kind) {
  return {
    id: FOLDER_PREFIX + f.driveId + ':' + f.fileId,
    title: f.name,
    artist: f.parentPath || '阿里云盘',
    artwork: f.artwork || undefined,
    description: '文件夹 · 共 ' + f.worksNum + ' 首',
    worksNum: f.worksNum,
    // 扩展字段：进入详情时直接用它定位文件夹，不必再查一次
    driveId: f.driveId,
    folderId: f.fileId,
    kind: kind,
  };
}

/**
 * 搜索歌单 / 专辑：把「音乐目录下的文件夹」当作歌单/专辑返回。
 *
 * - 关键词按**文件夹名**匹配（不区分大小写）；关键词为空则返回全部文件夹
 * - 只返回含音频的文件夹
 * - 首次调用会遍历目录；大曲库单次跑不完时先返回已发现的部分，
 *   后续翻页会接着遍历并补上（isEnd 为 false 表示还有）
 */
async function searchFolderSheets(query, page, kind) {
  const vars = syncVars();
  const resolved = await resolveRoots(vars);
  const state = await crawlMusic(resolved.roots);

  const keyword = escapeQueryValue(query).toLowerCase();
  const all = folderList(state);
  const matched = keyword
    ? all.filter(function (f) { return f.name.toLowerCase().indexOf(keyword) >= 0; })
    : all;

  const currentPage = page > 0 ? page : 1;
  const start = (currentPage - 1) * SHEET_PAGE_SIZE;
  const data = matched.slice(start, start + SHEET_PAGE_SIZE).map(function (f) {
    return toFolderSheetItem(f, kind);
  });

  return {
    isEnd: state.done && matched.length <= start + SHEET_PAGE_SIZE,
    data: data,
  };
}

// 从歌单/专辑条目里还原出文件夹位置（条目字段优先，其次是 id 前缀）
function folderRefOf(item) {
  const src = item || {};
  if (src.driveId && (src.folderId || src.fileId)) {
    return { driveId: src.driveId, folderId: src.folderId || src.fileId, title: src.title };
  }
  const id = String(src.id == null ? '' : src.id);
  if (id.indexOf(FOLDER_PREFIX) === 0) {
    const rest = id.slice(FOLDER_PREFIX.length);
    const idx = rest.indexOf(':');
    if (idx > 0) {
      return { driveId: rest.slice(0, idx), folderId: rest.slice(idx + 1), title: src.title };
    }
  }
  return { driveId: '', folderId: '', title: src.title };
}

// 列出某个文件夹下的音频（歌单 / 专辑详情）
async function listFolderSongs(ref, page) {
  const driveId = ref.driveId || (await getDriveId());
  const folderId = ref.folderId;

  const key = driveId + '|' + folderId;
  if (cache.sheetKey !== key) {
    cache.sheetKey = key;
    cache.sheetMarkers = {};
  }

  const currentPage = page > 0 ? page : 1;
  const marker = currentPage <= 1 ? undefined : cache.sheetMarkers[currentPage];
  if (currentPage > 1 && marker === undefined) {
    return { isEnd: true, musicList: [] };
  }

  const body = {
    drive_id: driveId,
    parent_file_id: folderId,
    limit: PAGE_SIZE,
    order_by: 'name',
    order_direction: 'ASC',
    fields: '*',
  };
  if (marker) body.marker = marker;

  const data = await api('/adrive/v1.0/openFile/list', body);
  const items = (data && data.items) || [];
  const nextMarker = data && data.next_marker;
  if (nextMarker) cache.sheetMarkers[currentPage + 1] = nextMarker;

  const musicList = [];
  for (let i = 0; i < items.length; i++) {
    if (isAudioFile(items[i])) musicList.push(toMusicItem(items[i], driveId));
  }
  return { isEnd: !nextMarker, musicList: musicList };
}

async function getFolderDetail(item, page) {
  const ref = folderRefOf(item);
  if (!ref.folderId) return { isEnd: true, musicList: [] };
  const result = await listFolderSongs(ref, page);
  return {
    isEnd: result.isEnd,
    musicList: result.musicList,
    folderTitle: ref.title,
  };
}

/* ============================ 排行榜 / 目录 ============================ */

async function getTopLists() {
  const vars = syncVars();
  const resolved = await resolveRoots(vars);
  const roots = resolved.roots;
  const multiDrive = roots.length > 1;

  // 第一组：全部歌曲（递归包含子目录）
  const allGroup = {
    title: '全部',
    data: [{
      id: ALL_SONGS_ID,
      title: '全部歌曲（含子目录）',
      artist: cache.userName || '阿里云盘',
      roots: roots,
    }],
  };

  // 第二组：按目录浏览
  const dirEntries = [];
  for (let i = 0; i < roots.length; i++) {
    const rt = roots[i];
    const prefix = rt.path;
    dirEntries.push({
      id: rt.fileId,
      title: prefix,
      driveId: rt.driveId,
      folderId: rt.fileId,
      isFolder: true,
    });
    try {
      const data = await api('/adrive/v1.0/openFile/list', {
        drive_id: rt.driveId,
        parent_file_id: rt.fileId,
        limit: PAGE_SIZE,
        order_by: 'name',
        order_direction: 'ASC',
        type: 'folder',
      });
      const items = (data && data.items) || [];
      for (let j = 0; j < items.length; j++) {
        if (items[j].type !== 'folder') continue;
        dirEntries.push({
          id: items[j].file_id,
          title: prefix + ' / ' + items[j].name,
          driveId: rt.driveId,
          folderId: items[j].file_id,
          isFolder: true,
        });
      }
    } catch (e) {
      // 子目录列举失败不影响主目录
    }
  }

  // 多盘模式下，把解析失败的目录提示出来，避免"目录少了一个"却查不到原因
  if (multiDrive && resolved.problems.length) {
    dirEntries.push({ id: '__BROKEN__', title: '⚠ 未找到：' + resolved.problems.join('；'), isFolder: false });
  }

  return [allGroup, { title: '目录', data: dirEntries }];
}

async function getAllSongsPage(topListItem, page) {
  const vars = syncVars();
  let roots = topListItem && topListItem.roots;
  if (!roots || !roots.length) roots = cache.roots;
  if (!roots || !roots.length) roots = (await resolveRoots(vars)).roots;

  const state = await crawlMusic(roots);
  const currentPage = page > 0 ? page : 1;
  const start = (currentPage - 1) * PAGE_SIZE;
  const slice = state.items.slice(start, start + PAGE_SIZE);
  const hasMore = !state.done || state.items.length > start + PAGE_SIZE;

  return {
    isEnd: !hasMore,
    musicList: slice,
    topListItem: { id: ALL_SONGS_ID, title: (topListItem && topListItem.title) || '全部歌曲' },
  };
}

async function getTopListDetail(topListItem, page) {
  const item = topListItem || {};
  if (item.id === ALL_SONGS_ID) return getAllSongsPage(item, page);
  if (item.id === '__BROKEN__' || item.isFolder === false) {
    return { isEnd: true, musicList: [] };
  }

  const driveId = item.driveId || driveOfItem(item) || (await getDriveId());
  const folderId = item.folderId || item.id;

  const cacheKey = driveId + '|' + folderId;
  if (cache.topListKey !== cacheKey) {
    cache.topListKey = cacheKey;
    cache.topListMarkers = {};
  }

  const currentPage = page > 0 ? page : 1;
  const marker = currentPage <= 1 ? undefined : cache.topListMarkers[currentPage];
  if (currentPage > 1 && marker === undefined) {
    return { isEnd: true, musicList: [] };
  }

  const body = {
    drive_id: driveId,
    parent_file_id: folderId,
    limit: PAGE_SIZE,
    order_by: 'name',
    order_direction: 'ASC',
    fields: '*',
  };
  if (marker) body.marker = marker;

  const data = await api('/adrive/v1.0/openFile/list', body);
  const items = (data && data.items) || [];
  const nextMarker = data && data.next_marker;
  if (nextMarker) cache.topListMarkers[currentPage + 1] = nextMarker;

  const musicList = [];
  for (let i = 0; i < items.length; i++) {
    if (isAudioFile(items[i])) musicList.push(toMusicItem(items[i], driveId));
  }

  return {
    isEnd: !nextMarker,
    musicList: musicList,
    topListItem: { id: folderId, title: item.title, driveId: driveId, folderId: folderId },
  };
}

/* ============================ 歌词 ============================ */

async function getLyric(musicItem) {
  const driveId = driveOfItem(musicItem) || (await getDriveId());
  const fileName = musicItem.fileName || musicItem.title;
  const ext = extOf(fileName);
  const base = ext ? fileName.slice(0, fileName.length - ext.length - 1) : fileName;
  const parentId = musicItem.parentId;

  if (!base) throw new Error('缺少文件信息，无法查找歌词');

  const data = await api('/adrive/v1.0/openFile/search', {
    drive_id: driveId,
    limit: 50,
    query: "name = '" + escapeQueryValue(base + '.lrc') + "'",
    fields: '*',
  });

  const items = (data && data.items) || [];
  let lrcFile = null;
  // 优先同目录同名，其次整个云盘同名
  for (let i = 0; i < items.length; i++) {
    if (isLyricFile(items[i]) && items[i].parent_file_id === parentId) { lrcFile = items[i]; break; }
  }
  if (!lrcFile) {
    for (let i = 0; i < items.length; i++) {
      if (isLyricFile(items[i])) { lrcFile = items[i]; break; }
    }
  }
  if (!lrcFile) throw new Error('该歌曲没有同名歌词文件');

  const dl = await api('/adrive/v1.0/openFile/getDownloadUrl', {
    drive_id: driveId,
    file_id: lrcFile.file_id,
    expire_sec: URL_EXPIRE_SEC,
  });
  if (!dl.url) throw new Error('无法获取歌词文件地址');

  const res = await axios.get(dl.url, {
    timeout: REQUEST_TIMEOUT,
    responseType: 'text',
    transformResponse: [function (d) { return d; }],
  });
  const text = res && res.data;
  if (!text) throw new Error('歌词文件内容为空');

  return { rawLrc: String(text) };
}

/* ============================ 插件导出 ============================ */

module.exports = {
  platform: '阿里云盘',
  version: '0.0.7',
  author: 'fhvyxyci',
  description:
    '播放你阿里云盘里的音乐。基于阿里云盘官方开放平台 API，支持搜索、按文件夹浏览歌单/专辑、' +
    '按目录浏览、汇总全部歌曲和播放。' +
    '使用前请在插件设置中填写刷新令牌（refresh_token），并按需选择云盘类型（默认云盘 / 资源库 / 备份盘 / 全部）。',
  cacheControl: 'no-cache',
  // album 与 sheet 都由「音乐目录下的文件夹」提供，内容一致
  supportedSearchType: ['music', 'album', 'sheet'],
  userVariables: [
    {
      key: 'refreshToken',
      name: '刷新令牌 (refresh_token)',
      hint: '必填。在 api.oplist.org 选「阿里云盘 应用登录」并勾选「使用 OpenList 提供的参数」，扫码后获得',
      type: 'password',
    },
    {
      key: 'folderId',
      name: '音乐目录',
      hint: '选填。填 root 表示根目录，也可填目录 ID 或以 / 开头的目录路径；多个目录用英文逗号分隔',
    },
    {
      key: 'driveType',
      name: '云盘类型',
      hint: '选填。all（全部云盘，默认）/ default（仅默认云盘）/ resource（仅资源库）/ backup（仅备份盘）',
    },
    {
      key: 'clientId',
      name: '客户端ID (ClientID/AppID)',
      hint: '选填。填写自建应用的 AppId 后，令牌直接向官方接口刷新，不经过第三方服务',
    },
    {
      key: 'clientSecret',
      name: '应用密钥 (AppSecret)',
      hint: '选填。与客户端ID 配套填写；两项都填写后才走官方直连刷新',
      type: 'password',
    },
    {
      key: 'renewApi',
      name: '令牌刷新服务地址',
      hint: '选填。仅在未填写客户端ID/密钥时生效，默认 https://api.oplist.org/alicloud/renewapi',
    },
  ],

  search(query, page, type) {
    if (type === 'album' || type === 'sheet') {
      return searchFolderSheets(query, page, type);
    }
    if (type !== 'music') return Promise.resolve({ isEnd: true, data: [] });
    return searchMusic(query, page);
  },

  // 歌单详情：点击「歌单」里的条目时调用
  async getMusicSheetInfo(sheetItem, page) {
    const r = await getFolderDetail(sheetItem, page);
    const out = { isEnd: r.isEnd, musicList: r.musicList };
    if ((page > 0 ? page : 1) === 1) {
      out.sheetItem = { id: sheetItem && sheetItem.id, title: r.folderTitle, worksNum: r.musicList.length };
    }
    return out;
  },

  // 专辑详情：点击「专辑」里的条目时调用
  async getAlbumInfo(albumItem, page) {
    const r = await getFolderDetail(albumItem, page);
    const out = { isEnd: r.isEnd, musicList: r.musicList };
    if ((page > 0 ? page : 1) === 1) {
      out.albumItem = { id: albumItem && albumItem.id, title: r.folderTitle, worksNum: r.musicList.length };
    }
    return out;
  },

  // 推荐歌单页：只放一个「全部文件夹」标签，点进去按文件夹列出所有歌单
  getRecommendSheetTags() {
    return Promise.resolve({
      pinned: [{ id: ALL_FOLDERS_TAG, title: '全部文件夹' }],
      data: [{ title: '阿里云盘', data: [{ id: ALL_FOLDERS_TAG, title: '全部文件夹' }] }],
    });
  },

  getRecommendSheetsByTag(tag, page) {
    // 应用首次进入时 tag.id 为空字符串，同样映射到「全部文件夹」
    const id = tag && tag.id ? tag.id : ALL_FOLDERS_TAG;
    if (id !== ALL_FOLDERS_TAG) return Promise.resolve({ isEnd: true, data: [] });
    return searchFolderSheets('', page, 'sheet');
  },

  getTopLists: getTopLists,
  getTopListDetail: getTopListDetail,
  getLyric: getLyric,

  async getMediaSource(musicItem) {
    const driveId = driveOfItem(musicItem) || (await getDriveId());
    const data = await api('/adrive/v1.0/openFile/getDownloadUrl', {
      drive_id: driveId,
      file_id: musicItem.id,
      expire_sec: URL_EXPIRE_SEC,
    });
    if (!data.url) throw new Error('无法获取播放地址');
    return { url: data.url };
  },
};
