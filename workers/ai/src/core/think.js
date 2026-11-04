/**
 * @fileoverview 流式回答里去掉模型的思考段 <think>…</think>（Qwen3 等会输出；提示词里已带 /no_think，这里兜底）。
 * 有状态：标签可能被切在两段 delta 中间，所以把可能是标签开头的尾巴留到下一段再判断。
 */

const OPEN = '<think>';
const CLOSE = '</think>';

/** 尾巴是不是某个标签的前缀（是就先留着） @param {string} s @param {string} tag */
function partialTail(s, tag) {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

/**
 * @returns {{ push: (chunk: string) => string, flush: () => string }}
 *   push：喂一段，回可以发给浏览器的部分；flush：流结束时把留着的尾巴吐出来（还在思考段里的丢掉）。
 */
export function thinkFilter() {
  let inThink = false;
  let pending = '';
  let started = false; /* 正文还没出过字：开头的空白（思考段后面常跟换行）不发 */
  return {
    push(chunk) {
      let s = pending + String(chunk || '');
      pending = '';
      let out = '';
      for (;;) {
        if (inThink) {
          const i = s.indexOf(CLOSE);
          if (i === -1) { const keep = partialTail(s, CLOSE); pending = keep ? s.slice(s.length - keep) : ''; s = ''; break; }
          s = s.slice(i + CLOSE.length);
          inThink = false;
        } else {
          const i = s.indexOf(OPEN);
          if (i === -1) {
            const keep = partialTail(s, OPEN);
            out += s.slice(0, s.length - keep);
            pending = keep ? s.slice(s.length - keep) : '';
            break;
          }
          out += s.slice(0, i);
          s = s.slice(i + OPEN.length);
          inThink = true;
        }
      }
      if (!started) { out = out.replace(/^\s+/, ''); if (out) started = true; }
      return out;
    },
    flush() {
      const rest = inThink ? '' : pending;
      pending = '';
      return started ? rest : rest.replace(/^\s+/, '');
    },
  };
}
