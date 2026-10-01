// Site-wide settings. Anything left empty ('') is simply hidden on the site.
export const CONFIG = {
  name:     'George Lincu',
  role:     'Technology Consultant',
  company:  'BearingPoint GmbH',
  site:     'https://geoli.eu',
  domain:   'geoli.eu',
  email:    'contact@geoli.eu',  // Cloudflare Email Routing → forwards to Gmail
  linkedin: 'https://www.linkedin.com/in/georgelincu',

  // These appear automatically once the file exists in public/ (checked at build time)
  cvPath: '/assets/george-lincu-cv.pdf',
  photo:  '/assets/george.jpg',          // square, ~800×800

  // Free booking page, e.g. 'https://cal.com/georgelincu/30min' — shows a "Book a call" button
  bookingUrl: '',

} as const;
