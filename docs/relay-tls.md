# Chiffrer le relay

Le relay parle `ws://` par défaut et `wss://` dès qu'on lui donne un certificat :

```bash
TLS_CERT=cert.pem TLS_KEY=key.pem npm run relay
```

Il annonce alors `wss://` et affiche les adresses joignables depuis un
téléphone — `localhost` n'en étant jamais une.

## Faut-il chiffrer sur un réseau local ?

Pas nécessairement, et c'est un arbitrage assumé plutôt qu'une négligence.

Sur un réseau domestique, le trafic ne quitte pas la maison, et iOS l'autorise
explicitement : c'est le sens de `NSAllowsLocalNetworking` dans l'`Info.plist`.
Ce qui circule, par ailleurs, n'a rien de sensible — des positions de joueurs
et des numéros de tick.

Le vrai coût du chiffrement en local est ailleurs : **aucune autorité publique
n'émet de certificat pour une adresse IP privée.** Il faut donc créer sa propre
autorité et l'installer sur *chaque* appareil — sur iOS, cela demande en plus
d'activer la confiance totale dans les réglages. Pour un salon, le remède est
plus lourd que le mal.

## Quand il devient indispensable

**Dès que le relay quitte le réseau local.** Un relay exposé sur Internet en
clair est indéfendable, et c'est aussi le cas où le chiffrement devient facile :
un nom de domaine permet un certificat Let's Encrypt gratuit et reconnu partout,
sans rien installer sur les appareils.

C'est également obligatoire si le site est servi en `https://` : un navigateur
refuse une socket en clair depuis une page sécurisée, et l'échec est muet.
`relayUrl()` en tient compte et choisit `wss` dans ce cas.

## Pour un réseau local, malgré tout

[`mkcert`](https://github.com/FiloSottile/mkcert) crée une autorité locale et
l'installe :

```bash
mkcert -install
mkcert 192.168.1.188 localhost
TLS_CERT=./192.168.1.188+1.pem TLS_KEY=./192.168.1.188+1-key.pem npm run relay
```

L'autorité doit ensuite être installée **sur chaque téléphone** :

- **Android** : transférer le fichier `rootCA.pem` (chemin donné par
  `mkcert -CAROOT`), puis Réglages → Sécurité → Chiffrement → Installer un
  certificat → Certificat CA.
- **iOS** : envoyer le `rootCA.pem`, l'ouvrir pour installer le profil, puis
  Réglages → Général → Informations → **Certificats de confiance** et activer
  la confiance totale. Cette seconde étape est facile à oublier, et sans elle
  le certificat est installé mais ignoré.

Enfin, renseigner `wss://…` dans Diagnostic → Configuration.

## Ce que le chiffrement du transport ne couvre pas

TLS protège le trajet jusqu'au relay. Il ne protège **ni le BLE, ni le
Wi-Fi Direct**, qui n'ont pas de couche équivalente, et il n'empêche pas le
relay lui-même de lire ce qui transite.

Un chiffrement de bout en bout dérivé du code court les couvrirait tous, y
compris hors ligne. Il n'est pas implémenté : c'est la dette la plus sérieuse
du socle en matière de confidentialité, et elle est consignée ici pour ne pas
être oubliée derrière un `wss://` rassurant.
