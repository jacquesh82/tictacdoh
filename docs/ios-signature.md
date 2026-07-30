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

## 3. Application native signée — demande un compte Apple

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
