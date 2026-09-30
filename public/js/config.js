export const CONFIG = Object.freeze({
  name:           'George Lincu',
  role:           'Technology Consultant',
  company:        'BearingPoint GmbH',
  email:          'george.lincu@gmail.com',
  linkedin:       'https://www.linkedin.com/in/georgelincu',
  domain:         'geoli.eu',
  year:           String(new Date().getFullYear()),
  storageKey:     'geoli-lang',
  defaultLang:    'en',
  supportedLangs: ['en', 'ro'],

  // CV: place george-lincu-cv.pdf in /assets/ and this link will work
  cvPath:         '/assets/george-lincu-cv.pdf',

  // Web3Forms access key (public by design — it only lets people send you mail).
  // Get it free at web3forms.com. Until set, the form falls back to mailto:.
  web3formsKey:   'YOUR_WEB3FORMS_KEY',
});
