// -----------------------------------------------------------------------------
// Connection status messages, shown in the Configuration tab of Gladys.
//
// The status banner is the ONLY place where the integration can tell the user
// what to do next during a login (type a code, solve a captcha), so every
// message names the exact field or screen to use.
// -----------------------------------------------------------------------------

export const MISSING_CONFIG = {
  en: 'Please fill in the email and the password of your eufy account, then save.',
  fr: 'Veuillez renseigner l’email et le mot de passe de votre compte eufy, puis enregistrer.',
};

export const CONNECTING = {
  en: 'Connecting to eufy...',
  fr: 'Connexion à eufy...',
};

/**
 * @param {number} deviceCount
 */
export function connected(deviceCount) {
  if (deviceCount === 0) {
    return {
      en: 'Connected, but no supported eufy device was found on this account. Share your devices with it from the eufy Security app of your main account, then sign in once with this account in the app to accept the invitation. A shared device still missing: use “List the raw devices”.',
      fr: 'Connecté, mais aucun appareil eufy pris en charge sur ce compte. Partagez-lui vos appareils depuis l’application eufy Security de votre compte principal, puis connectez-vous une fois avec ce compte dans l’application pour accepter l’invitation. Un appareil partagé manque toujours : utilisez « Lister les appareils bruts ».',
    };
  }
  return {
    en: `Connected — ${deviceCount} eufy device(s) found. Create them from the Discovery tab.`,
    fr: `Connecté — ${deviceCount} appareil(s) eufy trouvé(s). Créez-les depuis l’onglet Découverte.`,
  };
}

/**
 * @param {number} delayMs Delay before the realtime channels are restarted.
 */
export function realtimeUnavailable(delayMs) {
  return retrying(
    {
      en: 'Connected to eufy, but the real-time events (doorbell, motion, images) could not start.',
      fr: 'Connecté à eufy, mais les événements temps réel (sonnette, mouvement, images) n’ont pas pu démarrer.',
    },
    delayMs,
  );
}

const CODE_CHANNELS = {
  email: { en: ' by email', fr: ' par email' },
  sms: { en: ' by SMS', fr: ' par SMS' },
};

/**
 * @param {string} [method] How eufy sent the code. eufy-sdk describes it in
 *   free text ("code sent via app-push/sendmsg/verify_code"): only a known
 *   channel is named.
 */
export function verificationCodeRequired(method) {
  const by = Object.hasOwn(CODE_CHANNELS, method) ? CODE_CHANNELS[method] : { en: '', fr: '' };
  return {
    en: `eufy sent a verification code${by.en}: type it in the "Verification code" field below, then save.`,
    fr: `eufy a envoyé un code de vérification${by.fr} : saisissez-le dans le champ « Code de vérification » ci-dessous, puis enregistrez.`,
  };
}

/**
 * @param {boolean} retry Whether the previous answer was wrong.
 */
export function captchaRequired(retry) {
  const prefix = retry
    ? {
        en: 'Wrong captcha answer, a new one was issued. ',
        fr: 'Réponse au captcha incorrecte, un nouveau a été généré. ',
      }
    : { en: '', fr: '' };
  return {
    en: `${prefix.en}eufy asks for a captcha: open the Logs of the integration, copy the line starting with "data:image/png;base64," into the address bar of your browser to see the image, type the 4 characters in the "Captcha answer" field below, then save.`,
    fr: `${prefix.fr}eufy demande un captcha : ouvrez les Logs de l’intégration, copiez la ligne commençant par « data:image/png;base64, » dans la barre d’adresse de votre navigateur pour voir l’image, saisissez les 4 caractères dans le champ « Réponse captcha » ci-dessous, puis enregistrez.`,
  };
}

/**
 * Append the automatic retry delay to an error message.
 *
 * @param {{ en: string, fr: string }} message
 * @param {number} delayMs
 */
export function retrying(message, delayMs) {
  const minutes = Math.max(1, Math.round(delayMs / 60_000));
  return {
    en: `${message.en} Next attempt in ${minutes} min.`,
    fr: `${message.fr} Prochaine tentative dans ${minutes} min.`,
  };
}
