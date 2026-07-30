# Installer TicTacDoh sur un iPhone

Trois chemins, du plus immédiat au plus complet. Le premier fonctionne
aujourd'hui, sans rien acheter ni installer.

---

## 1. PWA — disponible tout de suite

Sur l'iPhone, dans **Safari** (pas Chrome : sur iOS, seul Safari sait installer
une application sur l'écran d'accueil) :

1. Ouvrir l'adresse du serveur, par exemple `http://192.168.1.188:5173`
2. Bouton **Partager** → **Sur l'écran d'accueil**

L'application s'ouvre alors en plein écran, sans barre d'adresse, avec sa propre
icône. Elle joue en réseau — Wi-Fi et Internet — donc **iOS ↔ Android ↔ PC**
fonctionne, ce qui est le jalon de connexion visé par le socle.

Deux limites, dues à Safari et non au projet :

- **Pas de scan de QR.** `http://` n'est pas une origine sécurisée, donc pas de
  caméra ; et WebKit n'implémente pas `BarcodeDetector`. Le code à 6 chiffres
  fonctionne. En servant le site en `https://`, la caméra redeviendrait
  accessible, mais il faudrait alors embarquer un décodeur JavaScript.
- **Pas de Bluetooth.** Aucune API BLE en Safari. Le hors-ligne demande
  l'application native, donc le chemin 3.

---

## 2. Vérifier que le code Swift compile — sans compte Apple

Le plugin BLE iOS n'était jusqu'ici **jamais passé par un compilateur** : il n'y
a pas de Mac sur la machine de développement. Le workflow
[`.github/workflows/ios.yml`](../.github/workflows/ios.yml) répond à cette seule
question sur un runner macOS de GitHub, sans signature ni secret.

Il tourne à chaque poussée sur `main`. C'est le premier retour honnête sur la
validité du code Swift.

---

## 3. Sideload avec un Apple ID gratuit — sans Mac

**C'est le chemin qui met réellement l'application native sur l'iPhone sans
payer les 99 €/an.** Il repose sur un fait simple : un `.ipa` n'est qu'une
archive zip contenant `Payload/App.app`. La construire ne demande aucun compte
Apple — c'est ce que fait le workflow, à chaque poussée sur `main`. Seule la
*signature* exige un identifiant, et elle se pose localement.

### Récupérer le paquet

```bash
gh run download --name ipa-non-signe --dir build-ios
```

Le fichier obtenu est un Mach-O arm64 non signé, identifiant `app.tictacdoh`.

### Signer et installer

Un signeur compatible « compte gratuit » est nécessaire. Deux sont packagés :

```bash
yay -S iloader-bin        # activement maintenu — meilleures chances sur iOS 26
# ou
yay -S sideloader-bin     # Dadoum/Sideloader, plus ancien
```

L'outil demande **votre identifiant Apple et votre mot de passe** : il s'en sert
pour créer, via l'API d'Apple, un certificat de développement et un profil liés
à votre compte personnel, puis signe le `.ipa` et l'installe par USB. Saisissez-
les vous-même, dans l'outil — ils n'ont à transiter par rien d'autre.

### Les limites d'un compte gratuit, à connaître avant de commencer

- **7 jours.** Le certificat expire. Passé ce délai l'application refuse de se
  lancer, et il faut la re-signer et la réinstaller. Ce n'est pas contournable.
- **3 applications** sideloadées simultanément, **10 identifiants** par semaine.
- **iOS 26.0.1 est très récent.** Ces outils suivent les changements d'Apple
  avec du retard ; il est possible que la version du jour ne fonctionne pas
  encore. C'est le risque principal de ce chemin.
- Le **mode développeur** doit être actif sur l'iPhone — c'est le cas.

### Ce que ça débloque

L'application native, donc le **Bluetooth** : c'est le seul moyen de tester le
transport BLE entre iOS et Android, la partie du socle qu'aucun test simulé ne
peut valider. C'est précisément le trou qui reste dans la phase 9.

---

## 4. Application native signée en CI — demande un compte payant

**C'est ici que se situe le seul vrai blocage, et aucune astuce ne le contourne.**
Installer une application sur un iPhone non jailbreaké exige une signature émise
par Apple. Ni Linux, ni GitHub Actions, ni le mode développeur activé sur le
téléphone n'y changent quoi que ce soit.

### Ce qu'il faut fournir

| Secret GitHub | Ce que c'est | Où le prendre |
|---|---|---|
| `IOS_CERTIFICATE_P12` | Certificat de signature, en base64 | Xcode ou developer.apple.com → Certificates → *Apple Development* → exporter en `.p12` |
| `IOS_CERTIFICATE_PASSWORD` | Mot de passe du `.p12` | Choisi à l'export |
| `IOS_PROVISIONING_PROFILE` | Profil, en base64 | developer.apple.com → Profiles → *iOS App Development*, incluant **l'UDID de l'iPhone** |
| `IOS_TEAM_ID` | Identifiant d'équipe, 10 caractères | developer.apple.com → Membership |

L'UDID de cet iPhone est `00008110-0018554E0EBB801E` (iPhone SE 3, iOS 26.0.1).
Il doit figurer dans le profil, sinon l'installation est refusée sans explication
utile.

Conversion en base64 :

```bash
base64 -w0 certificat.p12       > cert.txt
base64 -w0 profil.mobileprovision > profil.txt
```

Puis `gh secret set IOS_CERTIFICATE_P12 < cert.txt`, et ainsi de suite.

### Compte gratuit ou payant

Un **Apple ID gratuit** permet de signer, mais seulement depuis Xcode sur un Mac,
avec une validité de 7 jours et sans automatisation possible — il n'y a pas de
clé d'API pour un compte gratuit. Ce chemin est donc inutilisable en CI.

Le **programme Apple Developer** (99 €/an) donne les certificats et profils
ci-dessus, valables un an, et automatisables. C'est le seul chemin viable pour
un `.ipa` construit par GitHub Actions.

### Une fois le `.ipa` récupéré

```bash
# Une seule fois : l'outil d'installation n'est pas présent sur cette machine.
sudo pacman -S ideviceinstaller

gh run download --name tictacdoh-ios
./scripts/install-ios.sh tictacdoh-ios/App.ipa
```

---

## Ce que le mode développeur apporte

Activé sur l'iPhone (Réglages → Confidentialité et sécurité → Mode développeur),
il autorise l'exécution d'applications signées en développement. Il est
**nécessaire** au chemin 3, mais **pas suffisant** : sans certificat, il n'y a
rien à exécuter.
