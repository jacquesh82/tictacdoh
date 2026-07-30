# Code natif — état et marche à suivre

> ⚠️ **Rien dans ce dossier n'a été compilé ni exécuté.** La machine de
> développement était sous Linux, sans SDK Android, sans Xcode et sans appareil.
> Le Bluetooth et le Wi-Fi Direct ne se simulent pas : seul un test sur matériel
> réel peut valider ces fichiers.

Ce qui est en revanche **vérifié** : la couche TypeScript des deux transports,
et le contrat exact que le natif doit honorer. Voir `packages/transport-ble`
(17 tests) et `packages/transport-nearby` (13 tests), qui font tourner une
partie complète d'Esquive à trois joueurs contre une maquette de plugin.

## Contenu

| Dossier | Rôle | Plateformes |
|---|---|---|
| `capacitor-ble-mesh/` | Bluetooth Low Energy | Android (Kotlin) + iOS (Swift) |
| `capacitor-nearby/` | Wi-Fi Direct / Multipeer | Android (Kotlin) + iOS (Swift) |

## Le contrat, en une phrase

Un plugin reçoit et renvoie du JSON ; les charges utiles binaires voyagent en
**base64 standard**. Les noms d'événements et de méthodes sont ceux déclarés
dans `packages/transport-*/src/plugin.ts`. Toute divergence se manifestera par
un message corrompu, pas par une erreur — d'où l'intérêt des tests d'aller-retour
base64 déjà écrits.

## Points de vigilance, par ordre de risque

### 1. L'empreinte du code doit être lisible des deux côtés

CoreBluetooth **ne sait pas émettre de « service data »**. Un hôte iPhone ne
peut donc placer l'empreinte du code que dans son nom local. Un scanner Android
qui ne lirait que le service data ne verrait jamais un hôte iOS — c'est-à-dire
précisément le chemin que le Bluetooth existe pour couvrir.

La convention est donc : `<empreinte hex>|<nom lisible>` dans le nom annoncé,
**en plus** du service data là où il existe. Elle est figée et testée par
`encodeAdvertisedName` / `parseAdvertisedName` dans `@ttd/transport-ble`.

### 2. iOS en arrière-plan

Dès que l'application passe en arrière-plan, iOS retire l'UUID de service de
l'annonce principale et le déplace dans une zone « overflow » que seuls les
appareils Apple savent lire. **Un Android cessera alors de voir un hôte
iPhone.** Limite de plateforme, sans contournement : l'interface doit demander
à l'hôte de garder l'application au premier plan.

### 3. La MTU se négocie avant la découverte des services

Sur Android, appeler `discoverServices()` avant `requestMtu()` laisse la
connexion à 23 octets pour toute sa durée. L'ordre du code actuel est correct ;
ne pas l'inverser.

### 4. Nearby Connections exige les services Google Play

Absents de certains appareils : ce transport n'y fonctionnera jamais.
`isAvailable()` le signale, et le sélecteur de transport l'écartera
proprement.

### 5. Android sans mode périphérique

`isMultipleAdvertisementSupported` est faux sur une partie du parc. Ces
appareils peuvent **rejoindre** mais jamais **héberger** en Bluetooth.

## Vérification, quand le matériel sera disponible

Dans cet ordre — chaque étape suppose la précédente :

1. **Compilation.** `npm run sync -w @ttd/mobile`, puis ouvrir dans Android
   Studio / Xcode.
2. **Même plateforme.** Android ↔ Android, puis iPhone ↔ iPhone, en Wi-Fi
   Direct. Le plus simple, et cela valide le pont Capacitor.
3. **Le cas décisif : iOS ↔ Android en Bluetooth, mode avion activé des deux
   côtés.** C'est l'exigence qui a dicté toute l'architecture. Vérifier que
   l'hôte iPhone est bien découvert par l'Android — c'est le point 1 ci-dessus
   qui se joue là.
4. **Page de diagnostic** (`#/diag`) sur appareil : elle affiche le RTT réel, la
   gigue, la MTU négociée et le transport retenu. Elle a été écrite pour cette
   étape précise, le Bluetooth ne se déboguant pas autrement.
5. **Budget.** Vérifier que le débit mesuré reste sous ~1500 o/s à quatre
   joueurs. Si l'écart avec la simulation est important, c'est
   `BLE_LINK_BYTES_PER_SEC` dans `@ttd/wire` qu'il faut corriger — tout le reste
   s'y adapte automatiquement.
