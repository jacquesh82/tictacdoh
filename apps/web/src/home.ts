import { offers } from '@ttd/games'
import { displayName } from './device.js'
import { settingNumber } from './settings.js'
import { LOCAL_CAPS } from '@ttd/transport-local'
import { type RoomSummary, WsTransport } from '@ttd/transport-ws'
import { TicketError, parseJoinInput } from '@ttd/join'
import { capabilities, supportPill } from './capabilities.js'
import { type Scanner, scanSupport, startScan } from './scanner.js'
import { NfcPairing } from '@ttd/nfc'
import { Nfc, isNative } from './native.js'
import { relayUrl } from './app-config.js'

const NAME_KEY = 'ttd.playerName'

/** Nom du joueur, retenu d'une partie à l'autre. */
export function playerName(): string {
  return globalThis.localStorage?.getItem(NAME_KEY) ?? ''
}

export function setPlayerName(name: string): void {
  globalThis.localStorage?.setItem(NAME_KEY, name.trim().slice(0, 24))
}

/**
 * Écran d'accueil.
 *
 * Trois chemins, dans l'ordre où on les emploie : reprendre une partie
 * détectée à proximité, en créer une, ou saisir un code quand la découverte
 * n'aboutit pas — ce qui arrive dès que les deux joueurs ne sont pas sur le
 * même réseau.
 */
export function renderHome(root: HTMLElement, navigate: (route: string) => void): () => void {
  const caps = capabilities()
  const moyens = caps
    .filter((row) => row.join !== 'non')
    .map((row) => {
      const pill = supportPill(row.join)
      return `<li class="seat"><span class="${pill.className}">${pill.text}</span>${row.label}</li>`
    })
    .join('')

  root.innerHTML = `
    <h1>TicTacDoh</h1>
    <p class="lede">Des mini-jeux à 1 à 4 joueurs, sur le même appareil ou en réseau.</p>

    <section class="card" style="margin-bottom:1rem">
      <h2>Votre nom</h2>
      <div class="row">
        <input id="name" maxlength="24" placeholder="Ada" value="${playerName()}" />
      </div>
      <p class="muted" style="margin:0.5rem 0 0">
        Affiché aux autres joueurs, et sous lequel cet appareil se rend visible
        en Bluetooth et sur le réseau. Laissé vide, c’est le nom du téléphone
        qui sert.
      </p>
    </section>

    <div class="grid" style="margin-bottom:1.5rem">
      <section class="card">
        <h2>Créer une partie</h2>
        <div class="row">
          <input id="room-name" maxlength="32" placeholder="Le salon" />
        </div>
        <p class="muted" style="margin:0.5rem 0 0.75rem">
          Le nom de la salle, celui que les autres verront dans la liste.
        </p>
        <div class="row">
          <button id="create" class="primary">Ouvrir la salle</button>
        </div>
        <h2 style="margin-top:1.25rem">Sur cet appareil</h2>
        <p class="muted" style="margin:0 0 0.5rem">
          Jusqu’à 4 joueurs sur le même écran, sans réseau.
        </p>
        <div class="row" id="game-list"></div>
        <p class="muted" id="game-pitch" style="margin:0.5rem 0 0.75rem"></p>
        <div class="row">
          ${[1, 2, 3, 4]
            .map((n) => `<button data-players="${n}">${n}</button>`)
            .join('')}
        </div>
      </section>

      <section class="card">
        <div class="row" style="justify-content:space-between">
          <h2 style="margin:0">Parties à proximité</h2>
          <button id="refresh">Chercher</button>
        </div>
        <p class="muted" style="margin:0.5rem 0 0.75rem">
          Les salles ouvertes sur votre réseau. Ailleurs, il faut le code.
        </p>
        <div id="rooms"><p class="muted">Recherche…</p></div>

        <h2 style="margin-top:1.25rem">Rejoindre</h2>
        <div class="row">
          <button id="scan" class="primary">Scanner un QR</button>
          <button id="nfc" hidden>Approcher un téléphone</button>
        </div>
        <p id="nfc-note" class="muted" style="margin:0.5rem 0 0"></p>
        <p id="scan-note" class="muted" style="margin:0.5rem 0 0.75rem"></p>
        <div class="row">
          <input id="join-input" inputmode="numeric" placeholder="048213 ou lien" />
          <button id="join">Rejoindre</button>
        </div>
        <p id="join-error" class="error"></p>

        <h2 style="margin-top:0.75rem">Moyens disponibles ici</h2>
        <ul class="seats">${moyens}</ul>
      </section>
    </div>
  `

  root.insertAdjacentHTML(
    'beforeend',
    `<div class="sheet" id="scanner" hidden>
      <section class="card">
        <h2>Scanner le QR de l’hôte</h2>
        <video id="scan-video" class="qr" style="max-width:20rem;background:#000"></video>
        <p id="scan-error" class="error"></p>
        <div class="row"><button id="scan-close" class="primary">Annuler</button></div>
      </section>
    </div>`,
  )

  const listeners: Array<() => void> = []
  const on = (el: Element, ev: string, fn: EventListener) => {
    el.addEventListener(ev, fn)
    listeners.push(() => el.removeEventListener(ev, fn))
  }

  const nameInput = root.querySelector<HTMLInputElement>('#name')!
  const roomNameInput = root.querySelector<HTMLInputElement>('#room-name')!
  const roomsEl = root.querySelector<HTMLElement>('#rooms')!
  const errorEl = root.querySelector<HTMLElement>('#join-error')!

  on(nameInput, 'change', () => setPlayerName(nameInput.value))

  /**
   * Choix du mini-jeu pour une partie sur cet appareil.
   *
   * Présent même avec un seul jeu au catalogue : c'est la seule façon de
   * vérifier que rien, dans le lobby, ne présuppose lequel on lance.
   */
  const jeux = offers(LOCAL_CAPS)
  let choisi = jeux.find((offer) => offer.playable)?.plugin ?? jeux[0]!.plugin
  const gameListEl = root.querySelector<HTMLElement>('#game-list')!
  const gamePitchEl = root.querySelector<HTMLElement>('#game-pitch')!

  const renderGames = () => {
    gameListEl.innerHTML = jeux
      .map(
        (offer) =>
          `<button data-game="${offer.plugin.game.meta.id}"
            class="${offer.plugin === choisi ? 'primary' : ''}" ${offer.playable ? '' : 'disabled'}>
            ${offer.plugin.game.meta.name}
          </button>`,
      )
      .join('')
    for (const button of gameListEl.querySelectorAll<HTMLButtonElement>('[data-game]')) {
      on(button, 'click', () => {
        const found = jeux.find((offer) => offer.plugin.game.meta.id === button.dataset['game'])
        if (!found) return
        choisi = found.plugin
        renderGames()
      })
    }
    const offer = jeux.find((item) => item.plugin === choisi)
    gamePitchEl.textContent = offer?.reason ?? choisi.pitch
  }
  renderGames()

  const jouable = jeux.some((offer) => offer.playable)
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-players]')) {
    button.disabled = !jouable
    on(button, 'click', () =>
      navigate(`#/play/${button.dataset['players']}/${choisi.game.meta.id}`),
    )
  }

  on(root.querySelector('#create')!, 'click', () => {
    setPlayerName(nameInput.value)
    const label = roomNameInput.value.trim()
    navigate(`#/host${label ? `?nom=${encodeURIComponent(label)}` : ''}`)
  })

  const onJoin = () => {
    errorEl.textContent = ''
    setPlayerName(nameInput.value)
    const input = root.querySelector<HTMLInputElement>('#join-input')!
    try {
      const parsed = parseJoinInput(input.value)
      navigate(`#/join/${parsed.kind === 'code' ? parsed.code : parsed.ticket.code}`)
    } catch (error) {
      errorEl.textContent =
        error instanceof TicketError ? error.message : `Saisie illisible : ${(error as Error).message}`
    }
  }
  on(root.querySelector('#join')!, 'click', onJoin)
  on(root.querySelector('#join-input')!, 'keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') onJoin()
  })

  // Le bouton n'est offert que si la lecture peut réellement aboutir : proposer
  // un scan qui échouera à l'ouverture de la caméra est pire que ne rien
  // proposer, car l'utilisateur ne saura pas pourquoi.
  const support = scanSupport()
  const scanButton = root.querySelector<HTMLButtonElement>('#scan')!
  const scanNote = root.querySelector<HTMLElement>('#scan-note')!
  const scanSheet = root.querySelector<HTMLElement>('#scanner')!
  const scanVideo = root.querySelector<HTMLVideoElement>('#scan-video')!
  const scanError = root.querySelector<HTMLElement>('#scan-error')!
  let scanner: Scanner | undefined

  scanButton.disabled = !support.usable
  scanNote.textContent = support.usable
    ? 'Pointez la caméra vers le QR affiché par l’hôte.'
    : (support.reason ?? '')

  const closeScan = () => {
    scanner?.stop()
    scanner = undefined
    scanSheet.hidden = true
  }

  on(scanButton, 'click', () => {
    setPlayerName(nameInput.value)
    scanError.textContent = ''
    scanSheet.hidden = false
    void startScan({
      video: scanVideo,
      onError: (message) => {
        scanError.textContent = message
      },
      onResult: (text) => {
        closeScan()
        try {
          const parsed = parseJoinInput(text)
          navigate(`#/join/${parsed.kind === 'code' ? parsed.code : parsed.ticket.code}`)
        } catch (error) {
          errorEl.textContent = `QR lu mais illisible : ${(error as Error).message}`
        }
      },
    }).then((started) => {
      scanner = started
    })
  })

  on(root.querySelector('#scan-close')!, 'click', closeScan)

  // --- Appairage NFC ---
  //
  // Le bouton n'apparaît que si la puce répond vraiment. L'afficher partout
  // puis échouer serait pire que de ne rien proposer : l'utilisateur croirait
  // à une panne alors que son appareil n'a simplement pas de NFC.
  const nfcButton = root.querySelector<HTMLButtonElement>('#nfc')!
  const nfcNote = root.querySelector<HTMLElement>('#nfc-note')!
  const pairing = isNative() ? new NfcPairing(Nfc) : undefined
  let nfcActif = false

  if (pairing) {
    void pairing.availability().then((dispo) => {
      if (disposed) return
      nfcButton.hidden = !dispo.available
      if (!dispo.available && dispo.reason) nfcNote.textContent = dispo.reason
    })
  }

  const stopNfc = () => {
    nfcActif = false
    nfcButton.textContent = 'Approcher un téléphone'
    void pairing?.stopReading().catch(() => undefined)
  }

  on(nfcButton, 'click', () => {
    if (!pairing) return
    if (nfcActif) {
      stopNfc()
      nfcNote.textContent = ''
      return
    }
    setPlayerName(nameInput.value)
    nfcActif = true
    nfcButton.textContent = 'Arrêter'
    nfcNote.textContent = 'Approchez le dos des deux téléphones.'
    void pairing
      .read({
        promptMessage: 'Approchez le téléphone de l’hôte',
        onTicket: (ticket) => {
          stopNfc()
          navigate(`#/join/${ticket.code}`)
        },
        onError: (message) => {
          nfcNote.textContent = message
        },
      })
      .catch((error: Error) => {
        stopNfc()
        nfcNote.textContent = error.message
      })
  })

  let disposed = false

  const showRooms = (rooms: RoomSummary[]) => {
    if (disposed) return
    if (rooms.length === 0) {
      // Une liste vide sans explication ressemble à une panne. On distingue
      // « rien à proximité » de « la recherche a échoué ».
      roomsEl.innerHTML = `<p class="muted">Aucune partie sur ce réseau. Utilisez le code si l’hôte est ailleurs.</p>`
      return
    }
    roomsEl.innerHTML = rooms
      .map((room) => {
        const full = room.playerCount >= room.maxPlayers
        return `<div class="row" style="justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid var(--line)">
          <div>
            <b>${room.roomName}</b>
            <div class="muted">${room.hostName} · ${room.playerCount}/${room.maxPlayers} joueurs</div>
          </div>
          <button data-code="${room.code}" ${full ? 'disabled' : ''} class="primary">
            ${full ? 'Complète' : 'Rejoindre'}
          </button>
        </div>`
      })
      .join('')

    for (const button of roomsEl.querySelectorAll<HTMLButtonElement>('[data-code]')) {
      on(button, 'click', () => {
        setPlayerName(nameInput.value)
        navigate(`#/join/${button.dataset['code']}`)
      })
    }
  }

  const search = async () => {
    roomsEl.innerHTML = `<p class="muted">Recherche…</p>`
    const transport = new WsTransport({ url: relayUrl(), selfName: displayName(playerName()) })
    try {
      showRooms(await transport.listRooms(settingNumber('roomListTimeoutMs')))
    } catch (error) {
      if (!disposed) {
        roomsEl.innerHTML = `<p class="error">Recherche impossible : ${(error as Error).message}</p>`
      }
    } finally {
      await transport.close()
    }
  }

  on(root.querySelector('#refresh')!, 'click', () => void search())
  void search()

  return () => {
    disposed = true
    void pairing?.dispose()
    closeScan()
    for (const off of listeners) off()
  }
}
