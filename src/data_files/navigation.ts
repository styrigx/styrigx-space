/**
 * Navigation structure for Styrigx portal.
 * External URLs pass through localePath() untouched.
 */

export type NavLinkId = 'home' | 'blog';

export const navLinks: { id: NavLinkId; path: string }[] = [
  { id: 'home', path: '/' },
  { id: 'blog', path: 'https://blog.styrigx.com' },
];

export type FooterSectionId = 'sites' | 'about';

export type FooterLinkId =
  | 'blog'
  | 'inviteBoard'
  | 'github'
  | 'x';

export const footerSections: {
  id: FooterSectionId;
  links: { id: FooterLinkId; path: string }[];
}[] = [
  {
    id: 'sites',
    links: [
      { id: 'blog', path: 'https://blog.styrigx.com' },
      { id: 'inviteBoard', path: 'https://muse-invite.styrigx.com' },
    ],
  },
  {
    id: 'about',
    links: [
      { id: 'github', path: 'https://github.com/styrigx' },
      { id: 'x', path: 'https://x.com/styrigx' },
    ],
  },
];

export const socialLinks = {
  github: 'https://github.com/styrigx',
  x: 'https://x.com/styrigx',
};
