import type { YearsTemplate } from '@/lib/experience'

/** A label with its emoji kept apart; the design renders labels without it. */
type Labelled = { emoji: string; label: string }

type Content = {
  meta: { title: string; description: string }
  a11y: {
    skip: string
    mainNav: string
    toggleTheme: string
    switchLanguage: string
    external: string
  }
  nav: { brand: string; home: string }
  intro: {
    eyebrow: string
    /** The name, one line per word, so the surname can be set in orange. */
    name: [string, string]
    /** The first sentence, set as the lead. */
    lead: string
    /** The rest of the introduction, flowed in columns. */
    paragraphs: string[]
    photoAlt: string
  }
  /** The title block under the name: the fields of a drawing's corner box. */
  titleBlock: {
    role: string
    based: string
    basedValue: string
    experience: string
    status: string
    available: string
  }
  /** Headline items of the stack, looping on the tape. */
  tape: string[]
  experience: {
    title: YearsTemplate
    pageTitle: YearsTemplate
    years: YearsTemplate
    sectionTitle: string
    pageLead: string
    roles: string
    viewMore: string
    stack: string
    eyebrow: string
    back: string
  }
  skills: {
    title: string
    groups: (Labelled & { items: string[] })[]
  }
  projects: { title: string; here: string; all: string }
  blog: {
    title: string
    lead: string
    posts: { title: string; href: string; date: string }[]
    visit: string
  }
  about: { title: string; paragraphs: string[] }
  goals: {
    title: string
    meta: string
    intro: string
    items: (Labelled & { text: string })[]
  }
  softSkills: { title: string; items: string[] }
  languages: { title: string; items: { name: string; level: string }[] }
  study: { title: string }
  profile: { title: string; meta: string }
  quote: { text: string; accent: string; author: string }
  contact: {
    title: string
    meta: string
    items: (Labelled & { href: string; detail: string })[]
    photoAlt: string
  }
  footer: { builtWith: string }
  notFound: {
    eyebrow: string
    code: string
    title: string
    body: string
    back: string
    photoAlt: string
  }
}

const tape_zh = [
  'Astro',
  'Cloudflare',
  'Mihomo',
  '开源',
  'AI',
  '博客',
  '折腾',
  '复刻学习',
]

const tape_en = [
  'Astro',
  'Cloudflare',
  'Mihomo',
  'Open Source',
  'AI',
  'Blog',
  'Tinkering',
  'Learn by Replicating',
]

const quote = {
  text: '拆开世界是为了看懂它，再把它装回去是为了相信它。',
  accent: '相信它。',
  author: 'Sloan Gray',
}

const GITHUB = 'https://github.com/styrigx'
const GITHUB_TEXT = 'styrigx'
const X = 'https://x.com/styrigx'
const X_TEXT = '@styrigx'
const MAIL = 'mailto:styrigx@gmail.com'
const MAIL_TEXT = 'styrigx@gmail.com'
const BLOG = 'https://styrigx-blog.pages.dev'
const BLOG_TEXT = 'styrigx-blog.pages.dev'

export const CONTENT: Record<'zh' | 'en', Content> = {
  zh: {
    meta: {
      title: 'Sloan Gray ｜ Styrigx - 个人门户',
      description:
        'Sloan Gray（@styrigx）的个人门户：开源项目、技术博客、折腾记录。',
    },
    a11y: {
      skip: '跳到正文',
      mainNav: '主导航',
      toggleTheme: '切换主题',
      switchLanguage: '切换语言',
      external: '（在新标签页打开）',
    },
    nav: { brand: 'Styrigx', home: '首页' },
    intro: {
      eyebrow: '你好，我是',
      name: ['Sloan', 'Gray'],
      lead: '我是 <b>Sloan Gray</b>，网上叫 <b>@styrigx</b>——喜欢把东西拆开看懂，再装回去。',
      paragraphs: [
        '我的学习方式是复刻 → 学习 → 增量修改 → 筛捡优化：先照抄跑通，再吃透原理，做增量改动，过滤掉没用的，必要时推倒重来。这套打法帮我拿下了盲打、Mihomo 配置、邀请码站和几个开源项目。',
        '现在手头的东西：Astro 个人门户、双语博客、Muse 玩法手册、教材知识库，还有一个干净的邀请码共享站。全部跑在 Cloudflare 上，不买服务器。',
      ],
      photoAlt: 'Sloan Gray',
    },
    titleBlock: {
      role: '身份',
      based: '坐标',
      basedValue: '中国',
      experience: '折腾',
      status: '状态',
      available: '在线',
    },
    tape: tape_zh,
    experience: {
      title: { plus: '折腾时间线', exact: '折腾时间线' },
      pageTitle: { plus: '折腾时间线', exact: '折腾时间线' },
      years: { plus: '+{n} 年', exact: '{n} 年' },
      sectionTitle: '时间线',
      pageLead: '一路折腾过来的记录',
      roles: '条目',
      viewMore: '查看全部',
      stack: '技术栈：',
      eyebrow: '02 — 时间线',
      back: '回到首页',
    },
    skills: {
      title: '工具箱',
      groups: [
        {
          emoji: '🌐',
          label: '建站',
          items: ['Astro', 'Hugo', 'Cloudflare Pages', 'Vercel', 'GitHub Actions'],
        },
        {
          emoji: '🛰️',
          label: '网络',
          items: ['Mihomo', 'Cloudflare WARP', 'MASQUE', '规则集'],
        },
        {
          emoji: '🤖',
          label: 'AI',
          items: ['Muse', 'Gemini', 'ChatGPT', 'GitHub Copilot'],
        },
        {
          emoji: '🧰',
          label: '日常',
          items: ['GitHub', 'Samsung', 'Markdown', 'Cloudflare Workers', 'Supabase'],
        },
      ],
    },
    projects: {
      title: '项目',
      here: '你在这里',
      all: '所有仓库',
    },
    blog: {
      title: '博客',
      lead: '技术记录和折腾笔记，中英双语。',
      posts: [
        {
          title: '整理了 501 条 Muse 玩法，开源了',
          href: 'https://styrigx-blog.pages.dev/post/muse-playbook/',
          date: '2026-10',
        },
        {
          title: '上线了一个 Muse 邀请码共享站',
          href: 'https://styrigx-blog.pages.dev/post/invite-board/',
          date: '2026-10',
        },
      ],
      visit: '去博客看看',
    },
    about: {
      title: '关于我',
      paragraphs: [
        '英文名 Sloan Gray，盖茨比是我进入外国文学的启蒙。座右铭是"拆开世界是为了看懂它，再把它装回去是为了相信它"。',
        '重度三星用户，折腾网络和网站，喜欢把学到的东西沉淀成开源项目。',
      ],
    },
    goals: {
      title: '目标',
      meta: '进行中',
      intro: '手头和远期的事：',
      items: [
        {
          emoji: '🌐',
          label: '拿下 styrigx.com',
          text: '门户迁到主域名，博客迁到 blog 子域名，统一入口。',
        },
        {
          emoji: '📚',
          label: '开源项目持续更新',
          text: 'Muse 玩法手册每周巡检，教材知识库继续扩充。',
        },
        {
          emoji: '✍️',
          label: '保持写作',
          text: '把折腾过程写成博客，对自己有交代，对别人有用。',
        },
        {
          emoji: '📱',
          label: '换新手机',
          text: '等支持 eSIM 的机器，开香港号码。',
        },
      ],
    },
    softSkills: {
      title: '特质',
      items: ['自学', '折腾', '耐心', '复刻学习', '不服输'],
    },
    languages: {
      title: '语言',
      items: [
        { name: '中文', level: '母语' },
        { name: '英语', level: '读写' },
      ],
    },
    study: { title: '学习' },
    profile: { title: '档案', meta: '关于 · 语言' },
    quote,
    contact: {
      title: '联系',
      meta: '找我聊聊',
      items: [
        { emoji: '💻', label: 'GitHub', href: GITHUB, detail: GITHUB_TEXT },
        { emoji: '🐦', label: 'X', href: X, detail: X_TEXT },
        { emoji: '📧', label: '邮箱', href: MAIL, detail: MAIL_TEXT },
        { emoji: '✍️', label: '博客', href: BLOG, detail: BLOG_TEXT },
      ],
      photoAlt: 'Sloan Gray',
    },
    footer: { builtWith: '用 Astro 构建' },
    notFound: {
      eyebrow: '出错了',
      code: '404',
      title: '页面没找到',
      body: '抱歉，你找的页面不存在。',
      back: '回到首页',
      photoAlt: 'Sloan Gray',
    },
  },
  en: {
    meta: {
      title: 'Sloan Gray ｜ Styrigx - Personal Hub',
      description:
        "Sloan Gray (@styrigx)'s personal hub: open-source projects, tech blog, tinkering notes.",
    },
    a11y: {
      skip: 'Skip to content',
      mainNav: 'Primary',
      toggleTheme: 'Toggle theme',
      switchLanguage: 'Switch language',
      external: '(opens in a new tab)',
    },
    nav: { brand: 'Styrigx', home: 'Home' },
    intro: {
      eyebrow: 'hello, I am',
      name: ['Sloan', 'Gray'],
      lead: 'I am <b>Sloan Gray</b>, known online as <b>@styrigx</b> — I like taking things apart to understand them, then putting them back together.',
      paragraphs: [
        'My way of learning: replicate → learn → iterate → filter. Copy it until it runs, understand how it works, make incremental changes, drop what is useless, rebuild from scratch when needed. This carried me through touch typing, Mihomo configs, an invite-code board, and several open-source projects.',
        'Currently working on: an Astro personal hub, a bilingual blog, a Muse tips handbook, textbook knowledge bases, and a clean invite-code sharing board. Everything runs on Cloudflare — no VPS.',
      ],
      photoAlt: 'Sloan Gray',
    },
    titleBlock: {
      role: 'Role',
      based: 'Based',
      basedValue: 'China',
      experience: 'Tinkering',
      status: 'Status',
      available: 'Online',
    },
    tape: tape_en,
    experience: {
      title: { plus: 'Timeline', exact: 'Timeline' },
      pageTitle: { plus: 'Timeline', exact: 'Timeline' },
      years: { plus: '+{n} yrs', exact: '{n} yrs' },
      sectionTitle: 'Timeline',
      pageLead: 'A record of everything I have tinkered with',
      roles: 'entries',
      viewMore: 'View all',
      stack: 'Stack:',
      eyebrow: '02 — Timeline',
      back: 'Back home',
    },
    skills: {
      title: 'Toolbox',
      groups: [
        {
          emoji: '🌐',
          label: 'Web',
          items: ['Astro', 'Hugo', 'Cloudflare Pages', 'Vercel', 'GitHub Actions'],
        },
        {
          emoji: '🛰️',
          label: 'Network',
          items: ['Mihomo', 'Cloudflare WARP', 'MASQUE', 'Rule sets'],
        },
        {
          emoji: '🤖',
          label: 'AI',
          items: ['Muse', 'Gemini', 'ChatGPT', 'GitHub Copilot'],
        },
        {
          emoji: '🧰',
          label: 'Daily',
          items: ['GitHub', 'Samsung', 'Markdown', 'Cloudflare Workers', 'Supabase'],
        },
      ],
    },
    projects: {
      title: 'Projects',
      here: 'you are here',
      all: 'All repos',
    },
    blog: {
      title: 'Blog',
      lead: 'Tech notes and tinkering logs, in Chinese and English.',
      posts: [
        {
          title: '501 Muse tips, open-sourced',
          href: 'https://styrigx-blog.pages.dev/en/post/muse-playbook/',
          date: '2026-10',
        },
        {
          title: 'Launched a Muse invite-code board',
          href: 'https://styrigx-blog.pages.dev/en/post/invite-board/',
          date: '2026-10',
        },
      ],
      visit: 'Visit the blog',
    },
    about: {
      title: 'About me',
      paragraphs: [
        'Sloan Gray. The Great Gatsby was my gateway into foreign literature. My motto: "To understand the world, take it apart; to believe in it, put it back together."',
        'Deep in the Samsung ecosystem. I tinker with networks and websites, and turn what I learn into open-source projects.',
      ],
    },
    goals: {
      title: 'Goals',
      meta: 'in progress',
      intro: 'Now and later:',
      items: [
        {
          emoji: '🌐',
          label: 'Get styrigx.com',
          text: 'Move the hub to the root domain and the blog to a subdomain, one unified entry.',
        },
        {
          emoji: '📚',
          label: 'Keep shipping open source',
          text: 'Weekly review for the Muse handbook, keep expanding the textbook bases.',
        },
        {
          emoji: '✍️',
          label: 'Keep writing',
          text: 'Write up the tinkering. Accountable to myself, useful to others.',
        },
        {
          emoji: '📱',
          label: 'New phone',
          text: 'Waiting for an eSIM-capable device to get a Hong Kong number.',
        },
      ],
    },
    softSkills: {
      title: 'Traits',
      items: ['Self-taught', 'Tinkerer', 'Patient', 'Learn-by-replicating', 'Persistent'],
    },
    languages: {
      title: 'Languages',
      items: [
        { name: 'Chinese', level: 'Native' },
        { name: 'English', level: 'Working' },
      ],
    },
    study: { title: 'Learning' },
    profile: { title: 'Profile', meta: 'about · languages' },
    quote: {
      text: 'To understand the world, take it apart; to believe in it, put it back together.',
      accent: 'put it back together.',
      author: 'Sloan Gray',
    },
    contact: {
      title: 'Contact',
      meta: 'say hello',
      items: [
        { emoji: '💻', label: 'GitHub', href: GITHUB, detail: GITHUB_TEXT },
        { emoji: '🐦', label: 'X', href: X, detail: X_TEXT },
        { emoji: '📧', label: 'Email', href: MAIL, detail: MAIL_TEXT },
        { emoji: '✍️', label: 'Blog', href: BLOG, detail: BLOG_TEXT },
      ],
      photoAlt: 'Sloan Gray',
    },
    footer: { builtWith: 'Built with Astro' },
    notFound: {
      eyebrow: 'oops',
      code: '404',
      title: 'Page not found',
      body: 'Sorry, the page you are looking for does not exist.',
      back: 'Back home',
      photoAlt: 'Sloan Gray',
    },
  },
}
