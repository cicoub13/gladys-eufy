// -----------------------------------------------------------------------------
// eufy error classification.
//
// Turns whatever the eufy client throws into a cause the user can act on, and
// tells the caller whether retrying makes sense. Retrying a refused password is
// the fastest way to get the eufy account locked or flooded with captchas, so
// only a cloud that could not be reached is retried.
// -----------------------------------------------------------------------------

/**
 * @typedef {'credentials' | 'locked' | 'unreachable' | 'session' | 'unknown'} ErrorKind
 */

/** Kinds worth retrying: the account is fine, the cloud momentarily is not. */
const TRANSIENT_KINDS = new Set(['unreachable', 'session']);

/**
 * Flatten a thrown value (string, Error, anything) into readable text.
 */
export function errorToText(err) {
  if (typeof err === 'string') {
    return err;
  }
  if (err && typeof err === 'object' && typeof err.message === 'string') {
    return err.message;
  }
  return String(err);
}

function classify(err, text) {
  // Matched on the class name rather than `instanceof`: the check must hold for
  // the class eufy-sdk actually throws, whichever copy of the module it came from.
  if (err?.name === 'SessionExpiredError' || err?.constructor?.name === 'SessionExpiredError') {
    return 'session';
  }
  const lowered = text.toLowerCase();
  if (err?.status === 429 || /too many|too frequent|\b429\b|locked|frozen/.test(lowered)) {
    return 'locked';
  }
  if (
    err?.status === 401 ||
    err?.status === 403 ||
    /password|credential|account (does not|doesn't) exist|not registered|\b401\b|\b403\b/.test(
      lowered,
    )
  ) {
    return 'credentials';
  }
  if (
    /enotfound|etimedout|econnrefused|econnreset|eai_again|socket hang up|network|fetch failed|timeout|\b5\d\d\b/.test(
      lowered,
    ) ||
    (typeof err?.status === 'number' && err.status >= 500)
  ) {
    return 'unreachable';
  }
  return 'unknown';
}

const MESSAGES = {
  credentials: {
    en: 'eufy refused the credentials: check the email, the password and the country.',
    fr: "eufy a refusé les identifiants : vérifiez l'email, le mot de passe et le pays.",
  },
  locked: {
    en: 'Too many attempts: the eufy account is temporarily blocked. Wait a while, then save the configuration again.',
    fr: 'Trop de tentatives : le compte eufy est temporairement bloqué. Patientez, puis enregistrez de nouveau la configuration.',
  },
  unreachable: {
    en: 'The eufy cloud is unreachable. Retrying automatically.',
    fr: 'Le cloud eufy est injoignable. Nouvelle tentative automatique.',
  },
  session: {
    en: 'The eufy session expired (is the account signed in elsewhere?). Reconnecting automatically.',
    fr: 'La session eufy a expiré (le compte est-il connecté ailleurs ?). Reconnexion automatique.',
  },
};

/**
 * Describe an error thrown by the eufy client.
 *
 * @param {unknown} err
 * @returns {{ kind: ErrorKind, transient: boolean, text: string, message: { en: string, fr: string } }}
 */
export function describeEufyError(err) {
  const text = errorToText(err);
  const kind = classify(err, text);
  // Unknown causes keep the raw text: a message the user can paste into an
  // issue beats a reassuring but useless generic sentence.
  const message = MESSAGES[kind] ?? {
    en: `Connection to eufy failed: ${text}. Save the configuration again to retry.`,
    fr: `La connexion à eufy a échoué : ${text}. Enregistrez de nouveau la configuration pour réessayer.`,
  };
  return { kind, transient: TRANSIENT_KINDS.has(kind), text, message };
}
