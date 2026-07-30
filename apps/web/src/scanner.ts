/**
 * Lecture de QR par la caméra.
 *
 * Deux décodeurs, dans cet ordre :
 *
 * 1. **`BarcodeDetector`**, présent dans les moteurs Chromium — donc dans
 *    Chrome et dans le WebView d'Android. Décodage matériel, gratuit en poids.
 * 2. **Un décodeur JavaScript**, chargé à la demande. WebKit n'implémente pas
 *    `BarcodeDetector` : sans ce repli, scanner un QR était **impossible sur
 *    iPhone**, alors que c'est le geste d'appairage le plus naturel.
 *
 * Le second n'est téléchargé que là où il sert : un `import()` dynamique le
 * sort du paquet principal, si bien qu'Android ne paie rien pour une
 * bibliothèque qu'il n'utilisera jamais.
 *
 * Reste une condition commune, qui produit sinon un échec incompréhensible :
 * **le contexte sécurisé**. `getUserMedia` est refusé en `http://` simple. Les
 * coquilles natives servent depuis `localhost`, qui fait exception, mais un
 * navigateur atteignant le site par son adresse locale n'y aura pas droit.
 */

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>
}

type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike

function detectorCtor(): BarcodeDetectorCtor | undefined {
  return (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
}

export interface ScanSupport {
  readonly usable: boolean
  /** Raison de l'indisponibilité, formulée pour l'utilisateur. */
  readonly reason?: string
}

export function scanSupport(): ScanSupport {
  if (!globalThis.isSecureContext) {
    return {
      usable: false,
      reason:
        'La caméra exige une origine sécurisée. Utilisez l’application, ou le site en HTTPS.',
    }
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { usable: false, reason: 'Aucune caméra accessible depuis ce navigateur.' }
  }
  // Plus de refus faute de détecteur : le repli JavaScript couvre tout moteur
  // capable d'ouvrir une caméra.
  return { usable: true }
}

export interface Scanner {
  /** Arrête la caméra et libère le matériel. */
  stop(): void
}

export interface ScanOptions {
  /** Élément où afficher le flux vidéo. */
  readonly video: HTMLVideoElement
  readonly onResult: (text: string) => void
  readonly onError: (message: string) => void
}

/**
 * Démarre la lecture. Appelle `onResult` au premier code reconnu.
 *
 * La détection tourne sur `requestAnimationFrame` : ici c'est légitime, puisque
 * scanner sans regarder l'écran n'a aucun sens — contrairement à la simulation
 * de jeu, qui doit continuer en arrière-plan.
 */
export async function startScan(options: ScanOptions): Promise<Scanner> {
  const support = scanSupport()
  if (!support.usable) {
    options.onError(support.reason ?? 'Lecture impossible')
    return { stop: () => undefined }
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // Caméra arrière : celle qu'on pointe vers l'écran d'un autre.
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    })
  } catch (error) {
    const name = (error as DOMException).name
    options.onError(
      name === 'NotAllowedError'
        ? 'Accès à la caméra refusé.'
        : `Caméra indisponible : ${(error as Error).message}`,
    )
    return { stop: () => undefined }
  }

  const decode = await pickDecoder()
  options.video.srcObject = stream
  options.video.setAttribute('playsinline', '')
  await options.video.play().catch(() => undefined)

  let stopped = false
  let frame = 0

  const stop = () => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(frame)
    // Libérer explicitement : sans cela le voyant de la caméra reste allumé,
    // ce qui inquiète à juste titre.
    for (const track of stream.getTracks()) track.stop()
    options.video.srcObject = null
  }

  const tick = async () => {
    if (stopped) return
    try {
      const found = await decode(options.video)
      if (found) {
        stop()
        options.onResult(found)
        return
      }
    } catch {
      // Une image illisible n'est pas une erreur : on réessaie à la suivante.
    }
    frame = requestAnimationFrame(() => void tick())
  }
  frame = requestAnimationFrame(() => void tick())

  return { stop }
}

/** Décodeur : rend le texte lu, ou undefined si l'image n'en contient pas. */
type Decoder = (video: HTMLVideoElement) => Promise<string | undefined>

/**
 * Choisit le décodeur disponible.
 *
 * Le natif d'abord : il est plus rapide, plus tolérant aux angles et ne coûte
 * rien en poids. Le repli JavaScript n'est chargé que s'il manque.
 */
async function pickDecoder(): Promise<Decoder> {
  const Ctor = detectorCtor()
  if (Ctor) {
    const detector = new Ctor({ formats: ['qr_code'] })
    return async (video) => (await detector.detect(video))[0]?.rawValue
  }

  const { default: jsQR } = await import('jsqr')
  // Un canevas réutilisé d'une image à l'autre : en allouer un par frame
  // ferait travailler le ramasse-miettes soixante fois par seconde.
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  return async (video) => {
    if (!ctx || video.videoWidth === 0) return undefined
    // Analyse à largeur réduite : le décodage est en O(pixels), et un QR reste
    // lisible bien en dessous de la définition de la caméra. Sans cela, la
    // boucle sature le processeur d'un téléphone.
    const largeur = Math.min(480, video.videoWidth)
    const echelle = largeur / video.videoWidth
    canvas.width = largeur
    canvas.height = Math.round(video.videoHeight * echelle)
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
    return jsQR(image.data, image.width, image.height, {
      inversionAttempts: 'dontInvert',
    })?.data
  }
}
