/**
 * Lecture de QR par la caméra.
 *
 * S'appuie sur `BarcodeDetector`, présent dans les moteurs Chromium — donc
 * dans Chrome et dans le WebView d'Android. Aucune bibliothèque de décodage
 * n'est embarquée : elles pèsent plusieurs centaines de kilo-octets, et le
 * décodage matériel est de toute façon meilleur.
 *
 * Deux conditions se vérifient avant d'ouvrir quoi que ce soit, parce que
 * chacune produit sinon un échec incompréhensible :
 *
 * 1. **Contexte sécurisé.** `getUserMedia` est refusé en `http://` simple. La
 *    coquille native sert en `http://localhost`, qui fait exception, mais un
 *    navigateur atteignant le site par son adresse locale n'y aura pas droit.
 * 2. **Présence du détecteur.** Absent des moteurs non Chromium.
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
  if (!detectorCtor()) {
    return {
      usable: false,
      reason: 'Ce navigateur ne sait pas décoder les QR. Saisissez le code à la place.',
    }
  }
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

  const Ctor = detectorCtor()!
  const detector = new Ctor({ formats: ['qr_code'] })
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
      const codes = await detector.detect(options.video)
      const first = codes[0]?.rawValue
      if (first) {
        stop()
        options.onResult(first)
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
