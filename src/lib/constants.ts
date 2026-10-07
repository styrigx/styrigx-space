export const LINKS = {
  github: 'https://github.com/styrigx',
  x: 'https://x.com/styrigx',
  mail: 'mailto:styrigx@gmail.com',
  blog: 'https://styrigx-blog.pages.dev',
}

export const WORK_ZH = {
  TITLE: '折腾时间线',
  DESCRIPTION: '一路折腾过来的记录。',
}

export const WORK_EN = {
  TITLE: 'Timeline',
  DESCRIPTION: 'A record of everything I have tinkered with.',
}

export const STUDY_ZH = [
  { title: 'Astro', institution: 'Astro 文档', link: 'https://docs.astro.build/' },
  { title: 'Cloudflare', institution: 'Cloudflare Docs', link: 'https://developers.cloudflare.com/' },
  { title: 'AI', institution: 'Muse / 大模型应用' },
  { title: '英语', institution: '持续学习' },
]

export const STUDY_EN = [
  { title: 'Astro', institution: 'Astro docs', link: 'https://docs.astro.build/' },
  { title: 'Cloudflare', institution: 'Cloudflare Docs', link: 'https://developers.cloudflare.com/' },
  { title: 'AI', institution: 'Muse / LLM apps' },
  { title: 'English', institution: 'Ongoing' },
]

export type TimelineEntry = {
  company: string
  link: string
  location: string
  position: string
  start: string
  end: string
  description: string
  responsibilities: string[]
  stack: string[]
}

export const TIMELINE_ZH: TimelineEntry[] = [
  {
    company: '开源知识库',
    link: 'https://github.com/styrigx/muse-playbook',
    location: 'GitHub',
    position: '开源作者',
    start: '2026-10',
    end: '进行中',
    description:
      '把 AI 玩法和教材知识沉淀成开源仓库：501 条 Muse 玩法手册，以及两本教材的条目式知识库。',
    responsibilities: [
      'muse-playbook：十大分类 501 条，持续更新',
      'textbook-playbook：《信号与系统》《普林斯顿微积分读本》知识库',
      '每周自动巡检，只收录高质量新增',
    ],
    stack: ['Markdown', 'GitHub', 'GitHub Actions'],
  },
  {
    company: '个人网站矩阵',
    link: 'https://styrigx-portal.pages.dev',
    location: 'Cloudflare',
    position: '独立开发',
    start: '2026-10',
    end: '进行中',
    description:
      '从 Hugo 博客到 Astro 门户，用静态站 + Cloudflare 打造个人网站矩阵，不买服务器。',
    responsibilities: [
      '博客：Hugo + PaperMod，中英双语',
      '门户：Astro，个人枢纽，聚合所有站点入口',
      '部署：GitHub Actions / 直传，Cloudflare Pages 托管',
    ],
    stack: ['Astro', 'Hugo', 'Cloudflare Pages', 'GitHub Actions'],
  },
  {
    company: 'Muse 邀请码共享站',
    link: 'https://muse-invite-board.vercel.app',
    location: 'Cloudflare & Vercel',
    position: '独立开发',
    start: '2026-09',
    end: '进行中',
    description:
      '一个干净的邀请码共享板：网友提交、互相核验，零个人署名。',
    responsibilities: [
      'Worker + Supabase 数据层，KV 限流',
      'Turnstile 人机验证防刷',
      '每日自动清理被标记的码并备份',
    ],
    stack: ['Cloudflare Workers', 'Supabase', 'Vercel', 'Turnstile'],
  },
  {
    company: 'Mihomo 代理调优',
    link: 'https://github.com/styrigx',
    location: '本地',
    position: '网络折腾',
    start: '2026',
    end: '进行中',
    description:
      '从"投喂订阅"到自己写规则：Mesh 重构版配置，策略组、动态池、WARP MASQUE 备用出口。',
    responsibilities: [
      '策略组：基础设施置顶，动态池 url-test 自动选优',
      'WARP 从 WireGuard 切到 MASQUE，绕过协议封锁',
      '原则：自己改、能验证，不加维护不起的复杂度',
    ],
    stack: ['Mihomo', 'Cloudflare WARP', 'MASQUE'],
  },
  {
    company: '盲打',
    link: 'https://github.com/styrigx',
    location: '自学',
    position: '学习者',
    start: '2022',
    end: '2022',
    description:
      '第一次完整走通"复刻 → 学习 → 增量修改"的学习路线，从此这是我学任何东西的默认打法。',
    responsibilities: ['复刻 → 学习 → 编辑修改增量 → 筛捡优化'],
    stack: ['耐心'],
  },
]

export const TIMELINE_EN: TimelineEntry[] = [
  {
    company: 'Open-source knowledge bases',
    link: 'https://github.com/styrigx/muse-playbook',
    location: 'GitHub',
    position: 'Open-source author',
    start: '2026-10',
    end: 'ongoing',
    description:
      'Turning AI tricks and textbook knowledge into open repos: 501 Muse tips, plus knowledge bases for two textbooks.',
    responsibilities: [
      'muse-playbook: 501 tips in ten categories, continuously updated',
      'textbook-playbook: knowledge bases for Signals & Systems and Princeton Calculus',
      'Weekly auto-review, only high-quality additions',
    ],
    stack: ['Markdown', 'GitHub', 'GitHub Actions'],
  },
  {
    company: 'Personal web matrix',
    link: 'https://styrigx-portal.pages.dev',
    location: 'Cloudflare',
    position: 'Indie builder',
    start: '2026-10',
    end: 'ongoing',
    description:
      'From a Hugo blog to an Astro portal: a personal web matrix on static sites + Cloudflare, no VPS.',
    responsibilities: [
      'Blog: Hugo + PaperMod, Chinese/English bilingual',
      'Portal: Astro, a personal hub aggregating every site',
      'Deploys: GitHub Actions / direct upload, hosted on Cloudflare Pages',
    ],
    stack: ['Astro', 'Hugo', 'Cloudflare Pages', 'GitHub Actions'],
  },
  {
    company: 'Muse invite-code board',
    link: 'https://muse-invite-board.vercel.app',
    location: 'Cloudflare & Vercel',
    position: 'Indie builder',
    start: '2026-09',
    end: 'ongoing',
    description:
      'A clean invite-code sharing board: submitted and verified by the community, zero personal attribution.',
    responsibilities: [
      'Worker + Supabase data layer, KV rate limiting',
      'Turnstile bot protection',
      'Daily auto-cleanup of flagged codes with backups',
    ],
    stack: ['Cloudflare Workers', 'Supabase', 'Vercel', 'Turnstile'],
  },
  {
    company: 'Mihomo proxy tuning',
    link: 'https://github.com/styrigx',
    location: 'Local',
    position: 'Network tinkerer',
    start: '2026',
    end: 'ongoing',
    description:
      'From pasted subscriptions to hand-written rules: a mesh-restructured config with policy groups, dynamic pools, and a WARP MASQUE fallback.',
    responsibilities: [
      'Policy groups with url-test pools picking the fastest node',
      'WARP moved from WireGuard to MASQUE to bypass protocol blocking',
      'Rule: change it myself, verify it, no unmaintainable complexity',
    ],
    stack: ['Mihomo', 'Cloudflare WARP', 'MASQUE'],
  },
  {
    company: 'Touch typing',
    link: 'https://github.com/styrigx',
    location: 'Self-taught',
    position: 'Learner',
    start: '2022',
    end: '2022',
    description:
      'The first time I completed the "replicate → learn → iterate" loop. It has been my default way of learning ever since.',
    responsibilities: ['Replicate → learn → edit and iterate → filter'],
    stack: ['Patience'],
  },
]
