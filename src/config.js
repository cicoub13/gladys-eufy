// -----------------------------------------------------------------------------
// Integration configuration (the Configuration tab of Gladys).
//
// Two kinds of keys live in the same form:
//   - the account (email, password, country): changing one of them starts a
//     brand new login;
//   - the one-shot answers (verification code, captcha answer): filled in only
//     when the connection status asks for them, handed to the PENDING login,
//     then emptied again by the integration.
// -----------------------------------------------------------------------------

export const DEFAULT_COUNTRY = 'FR';

export const DEFAULT_CONFIG = {
  email: '',
  password: '',
  country: DEFAULT_COUNTRY,
  allow_unlock: false,
  allow_disarm: false,
  verification_code: '',
  captcha_answer: '',
};

/** The keys of the one-shot answers, emptied once handed to the login. */
export const ANSWER_KEYS = ['verification_code', 'captcha_answer'];

const text = (value) => (typeof value === 'string' ? value.trim() : '');
// Off unless explicitly switched on.
const flag = (value) => value === true || value === 'true';

/**
 * @typedef {object} EufyConfig
 * @property {string} email
 * @property {string} password
 * @property {string} country Two-letter ISO code, routes the eufy region.
 * @property {boolean} allowUnlock Whether Gladys may unlock a lock.
 * @property {boolean} allowDisarm Whether Gladys may disarm a HomeBase.
 * @property {string} verificationCode
 * @property {string} captchaAnswer
 */

/**
 * Normalize the raw configuration sent by Gladys.
 *
 * @param {Record<string, unknown>} [raw]
 * @returns {EufyConfig}
 */
export function normalizeConfig(raw = {}) {
  const country = text(raw.country).toUpperCase();
  return {
    email: text(raw.email),
    // Never trimmed: a password may legitimately start or end with a space.
    password: typeof raw.password === 'string' ? raw.password : '',
    // Kept when invalid, so that the status names it: a silent fallback would
    // route the login to the wrong eufy region.
    country: country === '' ? DEFAULT_COUNTRY : country,
    allowUnlock: flag(raw.allow_unlock),
    allowDisarm: flag(raw.allow_disarm),
    verificationCode: text(raw.verification_code),
    captchaAnswer: text(raw.captcha_answer),
  };
}

/** Whether the account is filled in enough to try a login. */
export function isComplete(config) {
  return config.email !== '' && config.password !== '';
}

/** Whether the country is a two-letter code. */
export function isValidCountry(config) {
  return /^[A-Z]{2}$/.test(config.country);
}

/** Whether two configurations designate the same account (answers ignored). */
export function sameAccount(a, b) {
  return (
    a !== null &&
    b !== null &&
    a.email === b.email &&
    a.password === b.password &&
    a.country === b.country
  );
}
