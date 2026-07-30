# Code natif — état et marche à suivre

> **Phase 9 close le 31 juillet 2026.** Ce qui suit distingue soigneusement ce
> qui a été *vérifié* de ce qui reste *supposé* : la nuance décide de ce qu'on
> peut affirmer au reste de l'équipe.

## Ce qui est vérifié

**Sur matériel** (Galaxy S24 et iPhone SE 3) :

| Fait | Preuve |
|---|---|
| Les trois plugins Android s'enregistrent | `Registering plugin instance: BleMesh / Nearby / Nfc` |
| Les quatre plugins iOS sont instanciés | `packageClassList` de l'`.ipa` construite |
| L'annonce BLE Android est acceptée | `onAdvertisingSetStarted(1, 1, 0)` — statut 0 |
| Le scan BLE Android démarre | `onScannerRegistered() status=0` |
| Le service NFC Android est routé | `dumpsys nfc` : AID `D2760000850101` → notre service |
| Le Swift compile réellement | Erreur volontaire injectée → build en échec, puis retirée |
| Une partie complète tourne en WebRTC | Empreintes identiques au tick 105, RTT 47 ms |
| Une partie complète tourne par le relay | S24 ↔ PC |

**En test automatisé** : la couche TypeScript des trois plugins, et le contrat
exact que le natif doit honorer — `packages/transport-ble` (17 tests),
`packages/transport-nearby` (13), `packages/nfc` (12), qui font tourner une
partie complète d'Esquive contre une maquette de plugin.

## Ce qui n'est PAS vérifié

**Aucun octet de jeu n'a traversé un lien BLE réel.** Les deux plateformes
s'annoncent et se cherchent, c'est établi. Restent trois inconnues que seul le
matériel tranchera : l'établissement de la connexion GATT, la négociation de
MTU, et la tenue du débit dans le budget de 1,5 ko/s.

**Wi-Fi Direct n'a jamais été exercé**, et ne peut pas l'être avec un Android
et un iPhone : Nearby Connections et MultipeerConnectivity sont étanches. Il
faut deux appareils de même famille.

**Le NFC n'a jamais été exercé** non plus. Côté iPhone il ne le sera pas sans
compte Apple payant : l'autorisation applicative de lecture n'est pas
accessible aux comptes gratuits, et elle n'est volontairement pas déclarée —
l'ajouter ferait échouer la signature de toute l'application.

## Défauts trouvés sur appareil, que rien d'autre n'aurait révélés

Ils valent d'être listés : chacun était invisible en test, et plusieurs se
masquaient mutuellement.

1. **Plugin iOS jamais instancié.** Un pod ajouté à la main au `Podfile`
   compile et se lie, mais Capacitor n'instancie que ce qui figure dans
   `packageClassList` — rempli uniquement à partir de vrais paquets npm.
2. **État CoreBluetooth lu trop tôt.** `centralManager.state` vaut `.unknown`
   juste après la création ; le délégué qui le renseigne était vide. L'iPhone
   répondait « indisponible » à tous les coups.
3. **Annonce BLE trop grosse.** 42 octets pour un maximum de 31 : le service
   data répétait l'UUID 128 bits entier.
4. **Permissions Bluetooth jamais demandées.** Déclarées mais non réclamées à
   l'exécution ; depuis Android 12 la seule lecture de `adapter.isEnabled` tue
   le processus.
5. **Découverte sans annonce.** Deux appareils qui cherchent sans émettre ne se
   voient jamais.
6. **Conflit d'AID NFC** avec le service intégré d'Android, résolu par
   `setPreferredService`.
7. **Nom Bluetooth du téléphone détourné sans restauration** — l'appareil
   restait baptisé `000000|Koko`, visible de tous.

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
