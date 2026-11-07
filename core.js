/*
 * 歌单核心逻辑：搜索、排序、批量导入解析、GitHub 仓库读写
 * 浏览器和 Node 都能用（Node 里用来跑测试）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SongCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function normalize(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function safeTags(value) {
    if (Array.isArray(value)) return value.map((t) => String(t).trim()).filter(Boolean);
    return String(value == null ? '' : value)
      .split(/[,，、]/)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  /** 整理成写入仓库的结构，同时过滤掉危险/超长字段 */
  function cleanSong(input) {
    const title = String((input && input.title) || '').trim();
    if (!title) throw new Error('歌名不能为空');
    return {
      id: String((input && input.id) || '').trim() || makeId(),
      title: title.slice(0, 120),
      artist: String((input && input.artist) || '').trim().slice(0, 120),
      key: String((input && (input.key != null ? input.key : input.song_key)) || '').trim().slice(0, 40),
      language: String((input && input.language) || '').trim().slice(0, 40),
      tags: safeTags(input && input.tags).slice(0, 10),
      createdAt: Number((input && input.createdAt) || 0) || Date.now(),
    };
  }

  function makeId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** 搜索：所有关键词都要命中（歌名/歌手/标签/语言/调性），顺序任意 */
  function searchSongs(list, query) {
    const terms = normalize(query).split(' ').filter(Boolean);
    if (!terms.length) return (list || []).slice();
    const q = normalize(query);
    return (list || []).filter((s) => {
      const hay = normalize([s.title, s.artist, (s.tags || []).join(' '), s.language, s.key].join(' '));
      return terms.every((t) => hay.indexOf(t) >= 0);
    }).sort((a, b) => {
      const rank = (s) => {
        const t = normalize(s.title);
        const ar = normalize(s.artist);
        if (t === q || ar === q) return 0;
        if (t.indexOf(q) === 0 || ar.indexOf(q) === 0) return 1;
        return 2;
      };
      return rank(a) - rank(b);
    });
  }

  function sortSongs(list, sort) {
    const out = (list || []).slice();
    if (sort === 'title') {
      out.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh-Hans-CN'));
    } else if (sort === 'artist') {
      out.sort((a, b) => {
        const c = String(a.artist).localeCompare(String(b.artist), 'zh-Hans-CN');
        return c !== 0 ? c : String(a.title).localeCompare(String(b.title), 'zh-Hans-CN');
      });
    } else {
      out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
    return out;
  }

  /**
   * 批量导入解析
   * 支持：歌名 - 歌手 / 歌名|歌手 / 歌名,歌手 / 只有歌名
   */
  function parseImport(text, existing) {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const seen = new Set(
      (existing || []).map((s) => normalize(s.title) + '\u0000' + normalize(s.artist))
    );

    const added = [];
    const skipped = [];
    for (const line of lines) {
      let title = line;
      let artist = '';
      for (const sep of [/\s*[|｜]\s*/, /\s+[-—–]\s+/, /\s*[,，]\s*/]) {
        if (sep.test(line)) {
          const parts = line.split(sep);
          title = (parts[0] || '').trim();
          artist = (parts[1] || '').trim();
          break;
        }
      }
      if (!title) continue;
      const key = normalize(title) + '\u0000' + normalize(artist);
      if (seen.has(key)) {
        skipped.push(line);
        continue;
      }
      seen.add(key);
      added.push(cleanSong({ title, artist, createdAt: Date.now() + added.length }));
    }
    return { added, skipped };
  }

  function decodeBase64Utf8(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function encodeBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  /**
   * 通过 GitHub API 直接读写仓库里的 songs.json
   * 每次修改都先取最新版本再提交，避免两个人同时改时互相覆盖
   */
  function GitHubStore(opts) {
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.branch = opts.branch || 'main';
    this.path = opts.path || 'songs.json';
    this.token = opts.token;
    this.apiBase = opts.apiBase || 'https://api.github.com';
  }

  GitHubStore.prototype.url = function () {
    return (
      this.apiBase +
      '/repos/' +
      encodeURIComponent(this.owner) +
      '/' +
      encodeURIComponent(this.repo) +
      '/contents/' +
      this.path.split('/').map(encodeURIComponent).join('/')
    );
  };

  GitHubStore.prototype.headers = function () {
    return {
      Authorization: 'Bearer ' + this.token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  };

  GitHubStore.prototype.load = async function () {
    const res = await fetch(this.url() + '?ref=' + encodeURIComponent(this.branch), {
      headers: this.headers(),
    });
    if (res.status === 404) return { songs: [], sha: null };
    if (res.status === 401) throw new Error('令牌无效或已过期');
    if (res.status === 403) throw new Error('令牌没有这个仓库的读写权限');
    if (!res.ok) throw new Error('读取仓库失败（HTTP ' + res.status + '）');
    const data = await res.json();
    let songs = [];
    try {
      songs = JSON.parse(decodeBase64Utf8(data.content || ''));
      if (!Array.isArray(songs)) songs = [];
    } catch (e) {
      songs = [];
    }
    return { songs, sha: data.sha };
  };

  GitHubStore.prototype.save = async function (songs, sha, message) {
    const body = {
      message: message || '更新歌单',
      content: encodeBase64Utf8(JSON.stringify(songs, null, 2)),
      branch: this.branch,
    };
    if (sha) body.sha = sha;
    const res = await fetch(this.url(), {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, this.headers()),
      body: JSON.stringify(body),
    });
    if (res.status === 409) throw new Error('CONFLICT');
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json()).message || '';
      } catch (e) {}
      throw new Error('保存失败（HTTP ' + res.status + '）' + (detail ? '：' + detail : ''));
    }
    const data = await res.json();
    return { sha: data.content && data.content.sha };
  };

  /** 取最新 → 修改 → 提交；遇到并发冲突自动重试一次 */
  GitHubStore.prototype.mutate = async function (fn, message) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { songs, sha } = await this.load();
      const next = fn(songs);
      try {
        const saved = await this.save(next, sha, message);
        return { songs: next, sha: saved.sha };
      } catch (e) {
        if (e.message === 'CONFLICT' && attempt < 2) continue;
        throw e;
      }
    }
    throw new Error('保存冲突，请重试');
  };

  return {
    normalize,
    safeTags,
    cleanSong,
    makeId,
    searchSongs,
    sortSongs,
    parseImport,
    decodeBase64Utf8,
    encodeBase64Utf8,
    GitHubStore,
  };
});
