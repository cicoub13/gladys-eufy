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
  return {
    en: `Connected — ${deviceCount} eufy device(s) found. Create them from the Discovery tab.`,
    fr: `Connecté — ${deviceCount} appareil(s) eufy trouvé(s). Créez-les depuis l’onglet Découverte.`,
  };
}

/**
 * @param {string} [method] How eufy sent the code ("email", "sms"...).
 */
export function verificationCodeRequired(method) {
  const by = method ? { en: ` by ${method}`, fr: ` par ${method}` } : { en: '', fr: '' };
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
