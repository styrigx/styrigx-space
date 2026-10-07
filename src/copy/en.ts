import faqs from '@data/faqs.json';

/**
 * English copy table for the Styrigx portal.
 * Single locale — this file defines the shape (`Copy` in `./index.ts`).
 */
export const en = {
  site: {
    /** Default `<meta name="description">` when a page sets none. */
    description:
      'Styrigx — the personal portal of Sloan Gray: blog, Muse invite-code board and open-source projects.',
    /** schema.org `WebSite.description` in every page's `isPartOf`. */
    descriptionShort: 'The personal portal of Sloan Gray.',
    ogTitle: 'Styrigx | Sloan Gray',
    ogDescription:
      'Styrigx — the personal portal of Sloan Gray: blog, Muse invite-code board and open-source projects.',
  },

  layout: {
    skipToContent: 'Skip to content',
    changeLanguage: 'Change language',
    toggleNavigation: 'Toggle navigation',
    darkTheme: 'Dark Theme Toggle',
    lightTheme: 'Light Theme Toggle',
    toggleTheme: 'Toggle theme',
  },

  nav: {
    /** Labels for `navLinks` in `@data/navigation`, keyed by id. */
    labels: {
      home: 'Home',
      blog: 'Blog',
    },
    footer: {
      /** Section titles and link labels for `footerSections` in `@data/navigation`, keyed by id. */
      sectionTitles: {
        sites: 'Sites',
        about: 'About',
      },
      links: {
        blog: 'Blog',
        inviteBoard: 'Muse Invite Board',
        github: 'GitHub',
        x: 'X',
      },
      craftedBy: 'Crafted by',
    },
  },

  notFound: {
    title: 'Page Not Found',
    subTitle: "Oops, this page doesn't exist.",
    content: "The link may be broken, or the page may have moved.",
    goHome: 'Go Home',
    goBack: 'Go Back',
  },

  home: {
    hero: {
      title:
        'Hi, I\'m <span class="text-yellow-500 dark:text-yellow-400">Sloan Gray</span>',
      subTitle:
        'To understand the world, take it apart; to believe in it, put it back together.',
      primaryBtn: 'Visit Blog',
      secondaryBtn: 'GitHub',
      imageAlt: 'Styrigx portal hero image',
    },
    sites: {
      title: 'My corners of the internet',
      subTitle:
        'Everything I run lives under one roof — pick a door and walk in.',
    },
    faqTitle: 'FAQ',
  },

  data: { faqs },
};
