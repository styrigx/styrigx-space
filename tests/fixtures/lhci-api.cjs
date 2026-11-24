/**
 * Lighthouse CI 用的接口假数据（只给 tests/config/lhci-server.mjs，不进生产构建）。
 * 静态测试构建里没有 Worker，音乐 / 游戏页取接口会 404 进控制台（errors-in-console）；这里按线上接口的字段形状给几条数据。
 * 形状对齐：
 *   music()  = GET /music/api/music（workers/atlas-core/src/music，2026-11-24 线上：ok / canManage / albums[] / artists[]）
 *   games()  = GET /games/api/games（workers/atlas-core 游戏接口：ok / showPrivate / canManage / games[]）
 *   状态    = tests/fixtures/status-summary.cjs normal()（/api/status，lhci-server 直接引用）
 * 接口本身对不对靠单测和 e2e 验，不靠 lhci。
 */

function track(id, no, title, duration) {
  return { id, no, title, duration, artist: '测试歌手', artist_id: 1 };
}

function music() {
  return {
    ok: true,
    canManage: false,
    albums: [
      { id: 1, kind: 'album', title: '测试专辑一', artist: '测试歌手', artist_id: 1, year: 2024, cover: true,
        tracks: [track(1, 1, '第一首', 214), track(2, 2, '第二首', 248), track(3, 3, '第三首', 196)] },
      { id: 2, kind: 'album', title: '测试专辑二', artist: '测试歌手', artist_id: 1, year: 2025, cover: true,
        tracks: [track(4, 1, '第四首', 231), track(5, 2, '第五首', 263)] },
      { id: 3, kind: 'single', title: '测试单曲', artist: '另一位歌手', artist_id: 2, year: 0, cover: false,
        tracks: [{ id: 6, no: 1, title: '测试单曲', duration: 187, artist: '另一位歌手', artist_id: 2 }] },
    ],
    artists: [
      { id: 1, name: '测试歌手', avatar: true, bio: '', style: '' },
      { id: 2, name: '另一位歌手', avatar: false, bio: '', style: '' },
    ],
  };
}

function games() {
  return {
    ok: true,
    showPrivate: false,
    canManage: false,
    games: [
      { id: 1, title: '测试游戏一', platform: 'Switch', device_id: 0, edition: '', status: 'done', rating: 5, review: '', cover: true, private: false },
      { id: 2, title: '测试游戏二', platform: 'PC', device_id: 0, edition: '', status: 'playing', rating: 4, review: '', cover: true, private: false },
      { id: 3, title: '测试游戏三', platform: 'PS5', device_id: 0, edition: '', status: 'want', rating: 0, review: '', cover: false, private: false },
    ],
  };
}

module.exports = { music, games };
