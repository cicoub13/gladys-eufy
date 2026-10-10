# Intégration eufy Security pour Gladys Assistant

Intégrez vos appareils eufy Security dans Gladys : caméras, sonnettes vidéo, serrures connectées, capteurs (ouverture, mouvement, fuite, fumée, CO) et mode d'armement des HomeBase. L'intégration passe par le cloud eufy, avec la librairie [eufy-sdk](https://github.com/mega-yfue/eufy-sdk).

## Fonctionnalités

- **Caméras et sonnettes** : l'image publiée est la miniature envoyée par eufy à chaque détection ou appui sur la sonnette. Elle s'affiche dans la boîte caméra du tableau de bord. Une scène qui envoie l'image de la caméra sur un appui sonnette attend quelques secondes son arrivée.
- **Sonnette** : un appui passe la fonctionnalité « sonnette » à 1, puis elle revient à 0 au bout de 5 s.
- **Mouvement** : chaque détection passe le capteur de mouvement à 1, puis il revient à 0 au bout de 30 s sans nouvelle détection. Sont concernés les mouvements, personnes, inconnus, véhicules et animaux, sur les caméras comme sur les capteurs PIR.
- **Serrures** : verrouiller depuis Gladys, avec leur niveau de batterie. Le déverrouillage demande d'activer **Autoriser le déverrouillage depuis Gladys** dans la configuration : tout utilisateur, toute scène ou tout assistant vocal relié à Gladys pourrait alors ouvrir la porte.
- **Capteurs** : ouverture de porte ou de fenêtre, fuite d'eau, fumée, monoxyde de carbone, sirène active.
- **HomeBase** : lire et changer le mode d'armement (absent, à la maison, planning, personnalisé 1 à 3, désarmé…). Désarmé et Off demandent d'activer **Autoriser le désarmement depuis Gladys** dans la configuration.
- **Batterie** : niveau, charge en cours, alerte de batterie faible.
- **Scènes** : déclencheurs « Sonnette eufy pressée », « Mouvement détecté par eufy » (filtrable par personne, inconnu, véhicule ou animal), « Colis livré » et « Alarme eufy déclenchée ».

## Prérequis

- **Gladys 5.1 ou supérieur.**
- Un **compte eufy dédié** à Gladys. eufy ne garde qu'une session par compte : utiliser votre compte principal vous déconnecterait de l'application. Créez un second compte, puis partagez-lui vos appareils depuis l'application eufy Security de votre compte principal (Paramètres > Famille et invités). Donnez-lui les droits administrateur pour piloter les serrures et le mode d'armement. Connectez-vous ensuite une fois avec le compte dédié dans l'application eufy Security pour **accepter l'invitation**, puis déconnectez-vous : vous connecter plus tard avec ce compte dans l'application déconnecterait Gladys.

## Configuration

1. Ouvrez l'onglet **Configuration**.
2. Saisissez l'**email**, le **mot de passe** et le **pays** (code à 2 lettres, par exemple FR) du compte dédié, puis enregistrez.
3. Lisez le **statut de connexion** en haut de l'écran :
   - **Connecté** : passez à l'étape 4.
   - **Code de vérification** : eufy vous a envoyé un code par email. Saisissez-le dans le champ **Code de vérification**, puis enregistrez.
   - **Captcha** : ouvrez les **Logs** de l'intégration et copiez la ligne qui commence par `data:image/png;base64,` dans la barre d'adresse de votre navigateur pour afficher l'image. Saisissez ensuite les 4 caractères dans le champ **Réponse captcha**, puis enregistrez. eufy peut demander ensuite un code de vérification.
4. L'intégration vide elle-même les champs code et captcha une fois utilisés. La session est conservée : un redémarrage ne redemande rien.
5. Ouvrez l'onglet **Découverte** et créez les appareils souhaités.

Le bouton **Tester la connexion** indique l'état et le nombre d'appareils trouvés. **Lister les appareils bruts** écrit le modèle et les capacités de chaque appareil dans les logs : c'est utile pour signaler un appareil non pris en charge.

## Limites

- **Pas de vidéo en direct** : Gladys n'affiche que des images fixes.
- L'image d'une caméra n'est mise à jour **qu'après un événement** (mouvement ou sonnette). Gladys la considère comme expirée au bout d'une heure.
- La détection de fuite, de fumée et de CO dépend de ce qu'eufy remonte pour chaque modèle. Ces valeurs ne sont pas encore confirmées sur tous les appareils.
- Si la session eufy expire (par exemple parce que le compte s'est connecté ailleurs), l'intégration se reconnecte d'elle-même. eufy peut alors redemander un code ou un captcha.
